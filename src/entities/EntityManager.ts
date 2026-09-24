/**
 * ENTITY MANAGER
 * ==============
 * Owns every combatant that is not the level: the infected pool, the survivor
 * list, projectiles, hazard interactions and the spatial index that both
 * ballistics and AI neighbour queries use.
 *
 * Performance shape
 * -----------------
 *   - Zombies are pooled (`Zombie` objects are recycled, never GC'd in play).
 *   - A 4 m uniform spatial hash answers "who is near this ray/point" in O(1).
 *   - Navigation flow fields are rebuilt round-robin (one survivor per frame,
 *     at most every 0.4 s each) so pathing never spikes the frame time.
 *   - Separation is O(n · k) with k bounded by the hash neighbourhood, and only
 *     applied to infected that are actually moving.
 */
import * as THREE from 'three';
import { bus } from '@/core/Events';
import { Rng, clamp, clamp01 } from '@/core/MathUtil';
import type { Damageable, DamageOptions } from '@/core/Types';
import { CollisionScratch, type CollisionWorld } from '@/physics/Collision';
import type { NavGrid } from '@/world/Nav';
import { FLOW_SLOTS } from '@/world/Nav';
import { noise, type NoiseEvent } from '@/world/Noise';
import { ZOMBIES, COMMON_VARIANTS, type ZombieVariant } from '@/config/zombies';
import type { QualitySettings } from '@/core/Settings';
import { Zombie } from '@/entities/Zombie';
import type { CombatContext, CombatEvents, SurvivorEntity, ZTarget } from '@/entities/Types';
import type { Effects } from '@/vfx/Effects';
import type { AudioSystem } from '@/audio/Audio';
import type { EntityIndex } from '@/weapons/Ballistics';

export type ProjectileKind = 'pipebomb' | 'molotov' | 'bile' | 'acid' | 'rock' | 'bile_boomer';

export interface Projectile {
  kind: ProjectileKind;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  radius: number;
  /** Remaining fuse (0 = detonate on impact). */
  fuse: number;
  age: number;
  owner: 'survivor' | 'infected';
  /** Damage applied by direct detonation. */
  damage: number;
  /** Hazard radius/duration for molotov/acid pools. */
  hazardRadius: number;
  hazardDuration: number;
  hazardDps: number;
  /** Spinning visual payload. */
  spin: number;
  bounces: number;
}

/** Marks a survivor as "bile-covered": infected prioritise them. */
interface BileMark {
  survivor: SurvivorEntity;
  until: number;
}

export class EntityManager implements EntityIndex {
  readonly zombies: Zombie[] = [];
  readonly survivors: SurvivorEntity[] = [];
  readonly projectiles: Projectile[] = [];
  private pool: Zombie[] = [];
  private nextId = 1;
  private rng = new Rng(0x2bad1dea);
  private scratch = new CollisionScratch();
  private noiseEvents: NoiseEvent[] = [];
  private bileMarks: BileMark[] = [];
  private time = 0;
  /** Spatial hash cell size. */
  private cell = 4;
  private buckets = new Map<number, Zombie[]>();
  /** Round-robin flow field rebuild cursor. */
  private flowCursor = 0;
  private flowTimer = 0;
  /** Roster of variants allowed this chapter (set by the Director). */
  allowedVariants: ZombieVariant[] = COMMON_VARIANTS.slice();
  /** Marks the events callback used by every damage path. */
  events: CombatEvents;
  /** Set by the engine: called when a corpse should fade/spawn decals. */
  onZombieRemoved: ((z: Zombie) => void) | null = null;
  /** Set by the engine: called when an infected dies and needs a ragdoll. */
  onZombieDied: ((z: Zombie, opts: { headshot: boolean; gibbed: boolean }) => void) | null = null;
  /** Set by the engine: horde mood changes for the music director. */
  onHordeSizeChanged: ((count: number) => void) | null = null;
  private hostileCount = 0;

  constructor(
    private world: CollisionWorld,
    private nav: NavGrid,
    private effects: Effects,
    private audio: AudioSystem,
    private quality: QualitySettings,
    events: CombatEvents,
  ) {
    this.events = events;
  }

  applyQuality(q: QualitySettings): void {
    this.quality = q;
  }

  /** Hard cap on live infected; defaults to the quality preset's budget. */
  get maxLive(): number {
    return this.maxLiveOverride ?? this.quality.maxLiveZombies;
  }

  set maxLive(value: number) {
    this.maxLiveOverride = value;
  }

  private maxLiveOverride: number | null = null;

  get population(): number {
    let n = 0;
    for (const z of this.zombies) if (z.alive) n++;
    return n;
  }

  get specialPopulation(): number {
    let n = 0;
    for (const z of this.zombies) if (z.alive && z.special) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /** Spawn an infected at a world position. Returns null when the cap is hit. */
  spawn(variant: ZombieVariant, x: number, y: number, z: number, yaw: number, healthScale = 1): Zombie | null {
    if (this.population >= this.maxLive) return null;
    let zombie = this.pool.pop();
    if (!zombie || zombie.variant !== variant) {
      zombie = new Zombie(this.nextId++, variant, this.world, this.nav, this.rng, () => this.rng.next());
      this.zombies.push(zombie);
    }
    zombie.spawn(x, y, z, yaw);
    const def = ZOMBIES[variant];
    if (healthScale !== 1) {
      zombie.maxHealth = def.health * healthScale;
    } else {
      zombie.maxHealth = def.health;
    }
    zombie.health = zombie.maxHealth;
    zombie.losCheck = (from, dir, dist) => this.lineBlocked(from, dir, dist);
    this.events.onZombieSpawned(zombie);
    bus.emit('zombie:spawned', { variant });
    return zombie;
  }

  /** Remove an infected (death cleanup, Director retirement, chapter unload). */
  despawn(z: Zombie): void {
    const idx = this.zombies.indexOf(z);
    if (idx >= 0) this.zombies.splice(idx, 1);
    if (z.renderSlot >= 0) z.renderSlot = -1;
    this.pool.push(z);
    this.removeFromHash(z);
    this.onZombieRemoved?.(z);
  }

  clear(): void {
    for (const z of this.zombies.slice()) this.despawn(z);
    this.projectiles.length = 0;
    this.bileMarks.length = 0;
    this.buckets.clear();
    noise.clear();
  }

  // -------------------------------------------------------------------------
  // Spatial hash
  // -------------------------------------------------------------------------

  private key(x: number, z: number): number {
    const ix = Math.floor(x / this.cell);
    const iz = Math.floor(z / this.cell);
    return (((ix & 0xffff) << 16) | (iz & 0xffff)) | 0;
  }

  private insert(z: Zombie): void {
    const k = this.key(z.position.x, z.position.z);
    let list = this.buckets.get(k);
    if (!list) {
      list = [];
      this.buckets.set(k, list);
    }
    list.push(z);
  }

  private removeFromHash(z: Zombie): void {
    // Buckets are rebuilt every frame; removing here is only needed for
    // mid-frame removals, so we simply mark the entry dead.
    z.retired = true;
    if (z.alive) return;
    void z;
  }

  private rebuildHash(): void {
    for (const list of this.buckets.values()) list.length = 0;
    for (const z of this.zombies) {
      if (!z.alive) continue;
      this.insert(z);
    }
  }

  /** EntityIndex: entities whose capsule overlaps the AABB. */
  queryBox(minX: number, _minY: number, minZ: number, maxX: number, _maxY: number, maxZ: number, out: Damageable[]): void {
    out.length = 0;
    const x0 = Math.floor(minX / this.cell);
    const x1 = Math.floor(maxX / this.cell);
    const z0 = Math.floor(minZ / this.cell);
    const z1 = Math.floor(maxZ / this.cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.buckets.get((((ix & 0xffff) << 16) | (iz & 0xffff)) | 0);
        if (!list) continue;
        for (const z of list) {
          if (!z.alive) continue;
          if (z.position.x < minX || z.position.x > maxX) continue;
          if (z.position.z < minZ || z.position.z > maxZ) continue;
          out.push(z);
        }
      }
    }
    // Survivors are few; a linear scan is cheaper than another hash.
    for (const s of this.survivors) {
      if (s.dead) continue;
      if (s.position.x < minX || s.position.x > maxX) continue;
      if (s.position.z < minZ || s.position.z > maxZ) continue;
      out.push(s);
    }
  }

  /** Nearest living infected to a point (used by AI + the Director). */
  nearestZombie(x: number, y: number, z: number, maxDist = 50, filter?: (zb: Zombie) => boolean): Zombie | null {
    let best: Zombie | null = null;
    let bestD = maxDist * maxDist;
    const r = Math.ceil(maxDist / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const list = this.buckets.get((((ix & 0xffff) << 16) | (iz & 0xffff)) | 0);
        if (!list) continue;
        for (const zb of list) {
          if (!zb.alive || (filter && !filter(zb))) continue;
          const dx = zb.position.x - x;
          const dy = zb.position.y - y;
          const dz = zb.position.z - z;
          const d = dx * dx + dy * dy * 0.5 + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = zb;
          }
        }
      }
    }
    return best;
  }

  /** All living infected within a radius (explosions, melee sweeps, AI scans). */
  queryRadius(x: number, y: number, z: number, radius: number, out: Zombie[] = []): Zombie[] {
    out.length = 0;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const r2 = radius * radius;
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const list = this.buckets.get((((ix & 0xffff) << 16) | (iz & 0xffff)) | 0);
        if (!list) continue;
        for (const zb of list) {
          if (!zb.alive) continue;
          const dx = zb.position.x - x;
          const dy = zb.position.y - y;
          const dz = zb.position.z - z;
          if (dx * dx + dz * dz <= r2 && Math.abs(dy) < 4) out.push(zb);
        }
      }
    }
    return out;
  }

  /** Line-of-sight helper with a mask that ignores glass and thin clutter. */
  private lineBlocked(from: THREE.Vector3, dir: THREE.Vector3, dist: number): boolean {
    const hit = this.world.raycastStatic(
      this.scratch.hit,
      from,
      dir,
      dist,
      (b) => b.solid && b.surface !== 'glass' && b.surface !== 'foliage',
    );
    return hit.hit;
  }

  // -------------------------------------------------------------------------
  // Survivors
  // -------------------------------------------------------------------------

  registerSurvivor(s: SurvivorEntity): void {
    this.survivors.push(s);
    // Assign a navigation flow slot (player first, so its field rebuilds often).
    s.flowSlot = Math.min(FLOW_SLOTS - 1, this.survivors.length - 1);
  }

  unregisterSurvivor(s: SurvivorEntity): void {
    const i = this.survivors.indexOf(s);
    if (i >= 0) this.survivors.splice(i, 1);
  }

  get leadSurvivor(): SurvivorEntity | null {
    // The player is the squad anchor when alive; otherwise the healthiest AI.
    for (const s of this.survivors) if (s.isPlayer && !s.dead) return s;
    let best: SurvivorEntity | null = null;
    for (const s of this.survivors) {
      if (s.dead) continue;
      if (!best || s.health > best.health) best = s;
    }
    return best;
  }

  get aliveSurvivorCount(): number {
    let n = 0;
    for (const s of this.survivors) if (!s.dead) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Bile marks (Boomer)
  // -------------------------------------------------------------------------

  markWithBile(s: SurvivorEntity, duration: number): void {
    const existing = this.bileMarks.find((b) => b.survivor === s);
    if (existing) existing.until = this.time + duration;
    else this.bileMarks.push({ survivor: s, until: this.time + duration });
  }

  isBileMarked(s: SurvivorEntity): boolean {
    return this.bileMarks.some((b) => b.survivor === s);
  }

  /** Pick the survivor infected should prefer (bile marks win, then proximity). */
  preferredTarget(from: { x: number; z: number }): SurvivorEntity | null {
    let best: SurvivorEntity | null = null;
    let bestScore = Infinity;
    for (const s of this.survivors) {
      if (s.dead) continue;
      const d = Math.hypot(s.position.x - from.x, s.position.z - from.z);
      const score = this.isBileMarked(s) ? d * 0.35 : s.incapacitated ? d * 1.4 : d;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Explosions & area damage
  // -------------------------------------------------------------------------

  /**
   * Radial damage with falloff and line-of-sight occlusion: geometry actually
   * protects you from a pipe bomb, which keeps positioning meaningful.
   */
  explode(
    x: number,
    y: number,
    z: number,
    radius: number,
    damage: number,
    kind: DamageOptions['kind'],
    owner: 'survivor' | 'infected',
    attacker: Damageable | null,
    alsoDamageSurvivors: boolean,
    friendlyFire: number,
  ): void {
    const affected = this.queryRadius(x, y, z, radius);
    const source = TMP_A.set(x, y, z);
    for (const zb of affected) {
      const dx = zb.position.x - x;
      const dy = zb.position.y + 0.9 - y;
      const dz = zb.position.z - z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;
      // Occlusion: blocked line halves the damage.
      DIR_A.set(dx, dy, dz);
      const len = DIR_A.length() || 1;
      DIR_A.multiplyScalar(1 / len);
      const blocked = this.lineBlocked(source, DIR_A, Math.max(0, len - 0.6));
      const falloff = 1 - clamp01(dist / radius);
      const dmg = damage * falloff * falloff * (blocked ? 0.35 : 1);
      if (dmg <= 0) continue;
      zb.takeDamage(dmg, { source: source.clone(), attacker, kind, impulse: dmg * 0.4 });
      if (owner === 'survivor' && zb.special) zb.stagger(0.5);
      if (!zb.alive) {
        // Death accounting happens in the zombie's own death path.
      }
    }
    if (alsoDamageSurvivors) {
      for (const s of this.survivors) {
        if (s.dead) continue;
        const dx = s.position.x - x;
        const dy = s.position.y + 0.9 - y;
        const dz = s.position.z - z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > radius * 1.15) continue;
        DIR_A.set(dx, dy, dz).normalize();
        // Explosions ignore friendly-fire settings less strictly: they always
        // hurt a little, which is what makes pipe bombs a real decision.
        const falloff = 1 - clamp01(dist / (radius * 1.15));
        const dmg = damage * falloff * falloff * 0.22 * Math.max(0.25, friendlyFire);
        if (dmg > 1) {
          s.takeDamage(dmg, { source: source.clone(), attacker, kind, impulse: dmg * 0.3 });
          DIR_A.multiplyScalar(6 * falloff);
          (s as unknown as { knockback?: (d: THREE.Vector3, f: number) => void }).knockback?.(DIR_A.clone(), 5 * falloff);
        }
      }
    }
    this.effects.explosion(x, y, z, radius, kind !== 'crush');
    this.audio.play(kind === 'explosion' ? 'explosion' : 'explosion_small', { position: source, maxDistance: 400 });
    this.audio.emitNoise(source, kind === 'explosion' ? 95 : 60, 'explosion');
    // Push nearby survivors' cameras.
    void attacker;
  }

  // -------------------------------------------------------------------------
  // Projectiles
  // -------------------------------------------------------------------------

  spawnProjectile(p: Partial<Projectile> & { kind: ProjectileKind; position: THREE.Vector3; velocity: THREE.Vector3 }): Projectile {
    const def = PROJECTILE_DEFAULTS[p.kind];
    const proj: Projectile = {
      kind: p.kind,
      position: p.position.clone(),
      velocity: p.velocity.clone(),
      radius: p.radius ?? def.radius,
      fuse: p.fuse ?? def.fuse,
      age: 0,
      owner: p.owner ?? 'survivor',
      damage: p.damage ?? def.damage,
      hazardRadius: p.hazardRadius ?? def.hazardRadius,
      hazardDuration: p.hazardDuration ?? def.hazardDuration,
      hazardDps: p.hazardDps ?? def.hazardDps,
      spin: 0,
      bounces: 0,
    };
    this.projectiles.push(proj);
    return proj;
  }

  private updateProjectiles(dt: number, friendlyFire: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += dt;
      p.fuse -= dt;
      p.spin += dt * 8;
      // Gravity + integration with a swept step so fast projectiles don't tunnel.
      p.velocity.y -= 20.5 * dt;
      let remaining = dt;
      const total = p.velocity.length() * dt;
      const steps = Math.max(1, Math.ceil(total / 0.4));
      let detonated = false;
      for (let s = 0; s < steps && !detonated; s++) {
        const sub = (remaining / (steps - s)) || dt / steps;
        const dx = p.velocity.x * sub;
        const dy = p.velocity.y * sub;
        const dz = p.velocity.z * sub;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 1e-5) {
          DIR_A.set(dx / dist, dy / dist, dz / dist);
          const hit = this.world.raycastStatic(this.scratch.hit, p.position, DIR_A, dist + p.radius);
          if (hit.hit && hit.distance <= dist + p.radius) {
            // Move to the contact point.
            p.position.addScaledVector(DIR_A, Math.max(0, hit.distance - p.radius * 0.4));
            if (p.kind === 'pipebomb') {
              // Pipe bombs bounce and keep ticking — that is the whole point.
              const n = hit.normal;
              const vn = p.velocity.dot(n);
              p.velocity.addScaledVector(n, -2 * vn);
              p.velocity.multiplyScalar(0.42);
              p.bounces++;
              if (p.velocity.length() < 1.5) p.velocity.set(0, 0, 0);
            } else {
              detonated = true;
            }
            break;
          }
          p.position.addScaledVector(DIR_A, dist);
        }
        remaining -= sub;
      }
      if (p.fuse <= 0) detonated = true;
      if (detonated) {
        this.detonate(p, friendlyFire);
        this.projectiles.splice(i, 1);
      } else if (p.age > 20) {
        this.projectiles.splice(i, 1);
      }
    }
  }

  private detonate(p: Projectile, friendlyFire: number): void {
    const pos = p.position;
    switch (p.kind) {
      case 'pipebomb':
        this.explode(pos.x, pos.y + 0.2, pos.z, p.hazardRadius > 0 ? 8 : 8, p.damage, 'explosion', p.owner, null, true, friendlyFire);
        this.effects.explosion(pos.x, pos.y + 0.3, pos.z, 8);
        break;
      case 'molotov':
        this.effects.addFire(pos.x, pos.y + 0.05, pos.z, 4.2, 14, 26, p.owner);
        this.effects.explosion(pos.x, pos.y + 0.2, pos.z, 4, true);
        this.audio.play('explosion_small', { position: pos });
        this.audio.emitNoise(pos, 55, 'explosion');
        break;
      case 'bile':
      case 'bile_boomer': {
        this.effects.bileSplat(pos.x, pos.y + 0.4, pos.z, 6);
        // Anything nearby — survivors included — gets covered.
        for (const s of this.survivors) {
          if (s.dead) continue;
          if (s.position.distanceTo(pos) < 6.5) this.markWithBile(s, 8);
        }
        this.audio.play('boomer_explode', { position: pos });
        bus.emit('boomer:explode', { position: [pos.x, pos.y, pos.z] });
        break;
      }
      case 'acid':
        this.effects.addAcid(pos.x, pos.y + 0.05, pos.z, p.hazardRadius, p.hazardDuration, p.hazardDps, 'infected');
        this.audio.play('spitter_spit', { position: pos, pitch: 1.2 });
        break;
      case 'rock':
        this.explode(pos.x, pos.y, pos.z, 3.6, p.damage, 'crush', 'infected', null, true, friendlyFire);
        this.effects.dust(pos.x, pos.y, pos.z, 1.6);
        this.effects.debrisBurst(pos.x, pos.y, pos.z, 10, 0x8a8278);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  private roundRobin = 0;

  update(dt: number, opts: { zombieDamage: number; zombieHealth: number; friendlyFire: boolean; maxLive?: number }): void {
    this.time += dt;
    this.rebuildHash();
    noise.consume(this.noiseEvents);

    // --- navigation flow fields (round-robin, one per frame) ---------------
    this.flowTimer -= dt;
    if (this.flowTimer <= 0 && this.survivors.length > 0) {
      this.flowTimer = 0.12;
      for (let i = 0; i < this.survivors.length; i++) {
        const idx = (this.flowCursor + i) % this.survivors.length;
        const s = this.survivors[idx];
        this.flowCursor = (idx + 1) % Math.max(1, this.survivors.length);
        if (s.dead) continue;
        const node = this.nav.nodeAt(s.position.x, s.position.y + 0.5, s.position.z, 3);
        if (node < 0) continue;
        // Rebuild only when the target moved enough to matter.
        this.nav.buildFlow(node, s.flowSlot ?? 0);
        break;
      }
    }

    // --- context -----------------------------------------------------------
    const lead = this.leadSurvivor;
    if (!lead) return;
    const ctx: CombatContext = {
      time: this.time,
      dt,
      survivors: this.survivors as never,
      lead: lead as never,
      zombieDamage: opts.zombieDamage,
      zombieHealth: opts.zombieHealth,
      friendlyFire: opts.friendlyFire,
    };

    // --- zombies -----------------------------------------------------------
    let hostile = 0;
    for (const z of this.zombies) {
      if (!z.alive) continue;
      hostile++;
      // LOD: far infected simulate at a reduced rate but still walk.
      const distToLead = z.distanceTo(lead.position.x, lead.position.y, lead.position.z);
      const far = distToLead > 55;
      if (far && this.roundRobin % 2 === 1) {
        z.update(ctx, this.events, this.noiseEvents);
      } else {
        z.update(ctx, this.events, this.noiseEvents);
      }
      // Consume queued special abilities.
      if (z.projectileSpawnQueue.length > 0) {
        for (const q of z.projectileSpawnQueue) {
          this.spawnProjectile({
            kind: q.kind,
            position: new THREE.Vector3(z.position.x, z.position.y + z.def.height * 0.8, z.position.z),
            velocity: new THREE.Vector3(q.vx, q.vy, q.vz),
            owner: 'infected',
            damage: q.damage,
            fuse: q.fuse ?? 0,
          });
        }
        z.projectileSpawnQueue.length = 0;
      }
      // Smoker tongue connection resolution.
      if (z.variant === 'smoker' && z.state === 'talking' && z.tongueState === 'firing') {
        const victim = z.target;
        if (victim) {
          const dx = victim.position.x - z.position.x;
          const dz = victim.position.z - z.position.z;
          const d = Math.hypot(dx, dz);
          DIR_A.set(dx / d, 0, dz / d);
          EYE_A.set(z.position.x, z.position.y + z.def.height * 0.8, z.position.z);
          const blocked = this.lineBlocked(EYE_A, DIR_A, d);
          if (!blocked && d < (z.def.ability?.tongueRange ?? 26)) {
            z.attachTongue(victim);
            bus.emit('survivor:voice', { id: victim.id, name: (victim as unknown as { name: string }).name ?? 'Survivor', line: 'grab', duration: 1.4 });
          }
        }
      }
      // Boomer death bile.
      if (z.bileExploded && !z.alive) {
        z.bileExploded = false;
        this.spawnProjectile({
          kind: 'bile_boomer',
          position: new THREE.Vector3(z.position.x, z.position.y + 1.1, z.position.z),
          velocity: new THREE.Vector3(0, -1, 0),
          owner: 'infected',
          fuse: 0.01,
        });
      }
      // Fire damage from hazard fields.
      const burn = this.effects.hazardDamageAt(z.position.x, z.position.y + 0.5, z.position.z, 'infected');
      if (burn > 0) {
        z.burning = 1;
        z.health -= burn * dt;
        if (z.health <= 0) z.die({ kind: 'fire', attacker: null });
      } else {
        z.burning = 0;
      }
      // Clear the attack flag that survivors may have set.
      z.updateWalkPhase(dt);
      this.roundRobin++;
    }
    if (hostile !== this.hostileCount) {
      this.hostileCount = hostile;
      this.onHordeSizeChanged?.(hostile);
    }

    // --- separation (keeps the horde from collapsing into one point) --------
    this.applySeparation(dt);

    // --- projectiles --------------------------------------------------------
    this.updateProjectiles(dt, opts.friendlyFire ? 1 : 0);

    // --- bile marks ---------------------------------------------------------
    for (let i = this.bileMarks.length - 1; i >= 0; i--) {
      const b = this.bileMarks[i];
      if (b.until < this.time || b.survivor.dead) this.bileMarks.splice(i, 1);
    }
  }

  /**
   * Local avoidance: infected push each other apart inside a cell and its
   * neighbours. Cheap, symmetric-ish, and enough to make a horde flow.
   */
  private applySeparation(dt: number): void {
    const cell = this.cell;
    for (const z of this.zombies) {
      if (!z.alive) continue;
      const speed = Math.hypot(z.char.velocity.x, z.char.velocity.z);
      if (speed < 0.05 && z.state !== 'chase') continue;
      const cx = Math.floor(z.position.x / cell);
      const cz = Math.floor(z.position.z / cell);
      let pushX = 0;
      let pushZ = 0;
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iz = cz - 1; iz <= cz + 1; iz++) {
          const list = this.buckets.get((((ix & 0xffff) << 16) | (iz & 0xffff)) | 0);
          if (!list) continue;
          for (const o of list) {
            if (o === z || !o.alive) continue;
            const dx = z.position.x - o.position.x;
            const dz = z.position.z - o.position.z;
            const d2 = dx * dx + dz * dz;
            const minD = (z.def.radius + o.def.radius) * 1.05;
            if (d2 > minD * minD || d2 < 1e-6) continue;
            const d = Math.sqrt(d2);
            const strength = (minD - d) / minD;
            // Heavier infected push lighter ones out of the way.
            const massRatio = o.def.mass / (o.def.mass + z.def.mass);
            pushX += (dx / d) * strength * massRatio * 3.2;
            pushZ += (dz / d) * strength * massRatio * 3.2;
          }
        }
      }
      if (pushX !== 0 || pushZ !== 0) {
        z.char.velocity.x += pushX * dt * 6;
        z.char.velocity.z += pushZ * dt * 6;
      }
    }
    // Survivors also push infected away slightly (they are not tissue paper).
    for (const s of this.survivors) {
      if (s.dead) continue;
      const cx = Math.floor(s.position.x / cell);
      const cz = Math.floor(s.position.z / cell);
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iz = cz - 1; iz <= cz + 1; iz++) {
          const list = this.buckets.get((((ix & 0xffff) << 16) | (iz & 0xffff)) | 0);
          if (!list) continue;
          for (const o of list) {
            if (!o.alive) continue;
            const dx = o.position.x - s.position.x;
            const dz = o.position.z - s.position.z;
            const d2 = dx * dx + dz * dz;
            const minD = 0.7 + o.def.radius;
            if (d2 > minD * minD || d2 < 1e-6) continue;
            const d = Math.sqrt(d2);
            const strength = (minD - d) / minD;
            o.char.velocity.x += (dx / d) * strength * 2.4;
            o.char.velocity.z += (dz / d) * strength * 2.4;
          }
        }
      }
    }
  }

  /** Chapter teardown / difficulty change. */
  setHealthScale(scale: number): void {
    for (const z of this.zombies) {
      if (!z.alive) continue;
      const ratio = z.health / Math.max(1, z.maxHealth);
      z.maxHealth = z.def.health * scale;
      z.health = z.maxHealth * ratio;
    }
  }

  /** Feeds the Director: how much pressure is the squad under right now? */
  pressureMetrics(lead: { position: THREE.Vector3 }): { nearby: number; close: number; engaging: number } {
    let nearby = 0;
    let close = 0;
    let engaging = 0;
    for (const z of this.zombies) {
      if (!z.alive) continue;
      const d = z.distanceTo(lead.position.x, lead.position.y, lead.position.z);
      if (d < 40) nearby++;
      if (d < 12) close++;
      if (z.target) engaging++;
    }
    return { nearby, close, engaging };
  }

  /** Utility for AI: is the point currently inside a fire/acid hazard? */
  hazardAt(x: number, y: number, z: number, target: 'survivor' | 'infected'): number {
    return this.effects.hazardDamageAt(x, y, z, target);
  }

  get elapsed(): number {
    return this.time;
  }

  /** Number of living infected targeting a specific survivor. */
  attackersOf(s: SurvivorEntity): number {
    let n = 0;
    for (const z of this.zombies) {
      if (z.alive && z.target === s) n++;
    }
    return n;
  }

  /** Nearest infected holding a survivor (for rescue interactions). */
  pinnedAttackers(): ZTarget[] {
    const out: ZTarget[] = [];
    for (const z of this.zombies) if (z.alive && z.isPinning) out.push(z);
    return out;
  }
}

const TMP_A = new THREE.Vector3();
const DIR_A = new THREE.Vector3();
const EYE_A = new THREE.Vector3();

const PROJECTILE_DEFAULTS: Record<
  ProjectileKind,
  { radius: number; fuse: number; damage: number; hazardRadius: number; hazardDuration: number; hazardDps: number }
> = {
  pipebomb: { radius: 0.09, fuse: 2.6, damage: 320, hazardRadius: 8, hazardDuration: 0, hazardDps: 0 },
  molotov: { radius: 0.1, fuse: 0, damage: 40, hazardRadius: 4.2, hazardDuration: 14, hazardDps: 26 },
  bile: { radius: 0.12, fuse: 0, damage: 0, hazardRadius: 6, hazardDuration: 0, hazardDps: 0 },
  bile_boomer: { radius: 0.4, fuse: 0.01, damage: 0, hazardRadius: 9, hazardDuration: 0, hazardDps: 0 },
  acid: { radius: 0.16, fuse: 0, damage: 0, hazardRadius: 4.6, hazardDuration: 9, hazardDps: 13 },
  rock: { radius: 0.5, fuse: 0, damage: 42, hazardRadius: 3.6, hazardDuration: 0, hazardDps: 0 },
};

export { clamp };
