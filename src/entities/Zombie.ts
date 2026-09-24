/**
 * INFECTED ENTITY + AI
 * ====================
 * One class per infected, sharing a single goal-driven state machine with
 * per-archetype ability hooks. Design notes:
 *
 *  - **Cheap, deep AI**: every infected re-senses on a jittered timer (0.4-0.8 s)
 *    rather than every frame, and moves by following the *flow field* of its
 *    target (`world/Nav.ts`) — O(1) steering, no per-agent pathfinding.
 *  - **Local avoidance**: neighbours are sampled from a spatial hash and pushed
 *    apart, which is what makes a horde flow around corners and through doorways
 *    instead of stacking into a single point.
 *  - **Abilities as states**: a Hunter's pounce, a Charger's charge and a
 *    Boomer's vomit are all small states with wind-up → execute → recover,
 *    which is what makes them readable (and dodgeable) for the player.
 *  - **Noise > sight**: gunfire pulls infected from far outside their vision
 *    cone, so silencers, melee and thrown objects genuinely matter.
 */
import * as THREE from 'three';
import { Rng, angleDelta, clamp, rotateToward } from '@/core/MathUtil';
import type { DamageOptions, HitZone } from '@/core/Types';
import { Character } from '@/physics/Character';
import type { CollisionWorld, CollisionScratch } from '@/physics/Collision';
import { ZOMBIES, type ZombieDef, type ZombieVariant } from '@/config/zombies';
import type { NavGrid } from '@/world/Nav';
import type { NoiseEvent } from '@/world/Noise';
import type { CombatContext, CombatEvents, SurvivorEntity, ZTarget, ZombieState } from '@/entities/Types';

/** Transient aim/steering target. */
interface SenseResult {
  target: SurvivorEntity | null;
  /** Last known position of the target (infected keep walking to where you were). */
  lastKnown: THREE.Vector3 | null;
  noise: NoiseEvent | null;
}

const UP = new THREE.Vector3(0, 1, 0);

export class Zombie implements ZTarget {
  readonly id: number;
  readonly variant: ZombieVariant;
  readonly def: ZombieDef;
  readonly special: boolean;
  readonly isZombie = true;
  readonly isSurvivor = false;
  maxHealth: number;
  health: number;
  /** Facing yaw (owned by the character controller). */
  get facing(): number {
    return this.char.facing;
  }
  set facing(v: number) {
    this.char.facing = v;
  }
  /** Walk cycle phase, used by the renderer to swing the legs. */
  get stepPhase(): number {
    return this.char.stepPhase;
  }
  alive = true;
  state: ZombieState = 'spawning';
  stateTime = 0;
  /** Time spent in the current state (seconds). */
  readonly char: Character;
  readonly position: THREE.Vector3;
  readonly centre = new THREE.Vector3();
  readonly velocity: THREE.Vector3;
  yaw = 0;
  target: SurvivorEntity | null = null;
  readonly lastKnown = new THREE.Vector3();
  hasLastKnown = false;
  /** Navigation node the agent believes it occupies. */
  flowNode = -1;
  pinnedSurvivor: SurvivorEntity | null = null;
  /** Slot index in the renderer (assigned by ZombieRenderer). */
  renderSlot = -1;
  /** Walk-cycle phase used by the procedural animation. */
  walkPhase: number;
  /** Per-instance flavour. */
  crawler = false;
  speedJitter = 1;
  /** Fire damage accumulated this frame. */
  burning = 0;
  burnTimer = 0;
  /** Set while the Director is "retiring" this infected (it despawns out of sight). */
  retired = false;
  /** Statistics. */
  readonly damageDealt = { value: 0 };
  killerId = 0;
  /** Time since spawn (for spawn immunity / fade-in). */
  age = 0;
  /** Aggro flag used by the Witch. */
  enraged = false;
  /** Ability timers. */
  private abilityTimer = 0;
  private attackCooldown = 0;
  private staggerTimer = 0;
  private senseTimer = 0;
  private hitFlash = 0;
  private chargeDir = new THREE.Vector3();
  private pounceVel = new THREE.Vector3();
  private steer = new THREE.Vector3();
  private sense: SenseResult = { target: null, lastKnown: null, noise: null };
  private wanderTarget = new THREE.Vector3();
  private wanderTimer = 0;
  /** Damage taken while staggering is remembered for the "overkill" statistic. */
  lastDamage = 0;

  constructor(
    id: number,
    variant: ZombieVariant,
    world: CollisionWorld,
    private readonly nav: NavGrid,
    private readonly rng: Rng,
    rand: () => number,
  ) {
    this.id = id;
    this.variant = variant;
    this.def = ZOMBIES[variant];
    this.special = this.def.special;
    this.char = new Character(world, {
      radius: this.def.radius,
      height: this.def.height,
      eyeHeight: this.def.height * 0.9,
    });
    this.position = this.char.position;
    this.velocity = this.char.velocity;
    const healthScale = 1;
    this.maxHealth = this.def.health * healthScale;
    this.health = this.maxHealth;
    this.walkPhase = rand() * Math.PI * 2;
    this.crawler = rand() < this.def.flavour.crawlerChance;
    this.speedJitter = 1 + (rand() * 2 - 1) * this.def.flavour.speedJitter;
    if (this.crawler) {
      this.char.height = this.def.height * 0.45;
      this.char.crouchHeight = this.def.height * 0.4;
      this.char.eyeHeight = this.def.height * 0.4;
      this.char.crouching = true;
    }
    void this.rng;
  }

  // --- damageable interface ------------------------------------------------

  get zoneMultipliers(): Partial<Record<HitZone, number>> {
    return this.def.zoneMultipliers;
  }

  get canBeInstakilled(): boolean {
    return !this.special;
  }

  get isPinning(): boolean {
    return this.pinnedSurvivor !== null;
  }

  get staggered(): boolean {
    return this.staggerTimer > 0;
  }

  get flashIntensity(): number {
    return this.hitFlash;
  }

  get inWindup(): boolean {
    return this.state === 'windup';
  }

  get attackWindupFraction(): number {
    if (this.state !== 'windup') return -1;
    return clamp(this.stateTime / this.def.attackWindup, 0, 1);
  }

  spawn(x: number, y: number, z: number, yaw: number): void {
    this.char.teleport(x, y, z);
    this.yaw = yaw;
    this.char.facing = yaw;
    this.alive = true;
    this.health = this.maxHealth;
    this.state = 'spawning';
    this.stateTime = 0;
    this.age = 0;
    this.burning = 0;
    this.burnTimer = 0;
    this.retired = false;
    this.enraged = false;
    this.target = null;
    this.pinnedSurvivor = null;
    this.hasLastKnown = false;
    this.flowNode = this.nav.nodeAt(x, y + 0.5, z);
    // Idle infected shamble around until they notice someone.
    this.state = this.rng.chance(this.def.flavour.idleChance) ? 'idle' : 'wander';
    if (this.variant === 'witch') this.state = 'dormant';
  }

  takeDamage(amount: number, opts: DamageOptions): void {
    if (!this.alive) return;
    this.lastDamage = amount;
    this.health -= amount;
    this.events?.onZombieHit?.(this, {
      damage: amount,
      headshot: opts.hitZone === 'head',
      attacker: opts.attacker ?? null,
    });
    this.hitFlash = 1;
    // Hit reactions.
    if (opts.impulse && this.def.staggerThreshold > 0) {
      const dir = opts.source ? new THREE.Vector3().subVectors(this.position, opts.source) : null;
      if (dir) {
        dir.y = 0;
        dir.normalize();
        this.char.velocity.addScaledVector(dir, Math.min(4.2, opts.impulse / 60));
      }
    }
    if (amount >= this.def.staggerThreshold && this.def.staggerThreshold > 0 && !this.special) {
      this.stagger(this.def.staggerTime, opts.source);
    } else if (amount >= this.def.staggerThreshold * 1.6 && this.def.staggerThreshold > 0) {
      this.stagger(this.def.staggerTime, opts.source);
    }
    // The Witch wakes up when shot.
    if (this.variant === 'witch' && this.state === 'dormant') {
      this.enrage();
    }
    // Getting shot always aggros.
    if (!this.target && opts.attacker && opts.attacker.isSurvivor) {
      this.target = opts.attacker as unknown as SurvivorEntity;
      this.lastKnown.copy(this.target.position);
      this.hasLastKnown = true;
      if (this.state !== 'dormant') this.state = 'chase';
    }
    if (this.health <= 0) this.die(opts);
  }

  stagger(seconds: number, source?: THREE.Vector3): void {
    if (this.variant === 'tank' || seconds <= 0) return;
    if (this.isPinning) return;
    this.staggerTimer = Math.max(this.staggerTimer, seconds);
    this.state = 'stagger';
    this.stateTime = 0;
    void source;
  }

  /** The Witch's transition from dormant threat to frenzied killer. */
  enrage(): void {
    if (this.enraged) return;
    this.enraged = true;
    this.state = 'chase';
    this.stateTime = 0;
    this.staggerTimer = 0;
    this.abilityTimer = 0;
  }

  die(opts: DamageOptions): void {
    if (!this.alive) return;
    this.alive = false;
    this.state = 'dead';
    this.stateTime = 0;
    this.killerId = opts.attacker?.id ?? 0;
    if (this.pinnedSurvivor) {
      this.pinnedSurvivor.releasePin('killed');
      this.pinnedSurvivor = null;
    }
    // The Boomer is a walking bomb: death means bile everywhere.
    if (this.variant === 'boomer') {
      this.explodeBile();
    }
    // Kill reporting: the engine's statistics, the ragdoll pool and the
    // Director all hang off this single notification.
    this.events?.onZombieKilled(this, {
      headshot: opts.hitZone === 'head',
      attacker: opts.attacker ?? null,
      damage: this.lastDamage,
    });
    void UP;
  }

  /** Notify the entity that it was damaged by a specific attacker (threat priority). */
  aggro(attacker: SurvivorEntity | null, at: THREE.Vector3): void {
    if (attacker && (!this.target || this.target.incapacitated)) {
      this.target = attacker;
    }
    if (at) {
      this.lastKnown.copy(at);
      this.hasLastKnown = true;
    }
    if (this.state !== 'dormant' && this.state !== 'chase' && this.state !== 'pouncing' && this.state !== 'charging') {
      this.state = 'chase';
      this.stateTime = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  /**
   * Events sink captured on the first update (the manager owns it; a zombie
   * cannot be constructed with it because the manager needs the entity first).
   * Deaths are reported through it so kill statistics, ragdolls and the
   * Director's pacing all see every kill — including ones caused by fire,
   * explosions or teammates, which never pass through the weapon code.
   */
  private events: CombatEvents | null = null;

  update(ctx: CombatContext, events: CombatEvents, noiseEvents: NoiseEvent[]): void {
    this.events = events;
    if (!this.alive) return;
    const dt = ctx.dt;
    const def = this.def;
    this.age += dt;
    this.stateTime += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4);

    // --- status ------------------------------------------------------------
    if (this.staggerTimer > 0) {
      this.staggerTimer -= dt;
      if (this.staggerTimer <= 0 && this.alive) this.state = 'chase';
    }
    // Fire damage over time.
    if (this.burning > 0) {
      const burn = def.fireVulnerability * this.burning * dt;
      this.health -= burn;
      this.burnTimer += dt;
      if (this.burnTimer > 0.5) {
        this.burnTimer = 0;
        events.onAbility(this, 'burn');
      }
      if (this.health <= 0) {
        this.die({ kind: 'fire', attacker: null });
        return;
      }
    }

    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.abilityTimer = Math.max(0, this.abilityTimer - dt);

    // --- sensing -----------------------------------------------------------
    this.senseTimer -= dt;
    if (this.senseTimer <= 0) {
      this.senseTimer = 0.45 + this.rng.next() * 0.35;
      this.senseForTargets(ctx, noiseEvents);
    }

    // --- state machine -----------------------------------------------------
    switch (this.state) {
      case 'dormant':
        this.updateDormant(ctx, events);
        break;
      case 'idle':
        this.updateIdle(ctx);
        break;
      case 'wander':
        this.updateWander(ctx, dt);
        break;
      case 'stagger':
        this.char.update(dt, { dirX: 0, dirZ: 0, speed: 0, canAccelerate: false, jump: false, crouch: this.crawler });
        break;
      case 'pinned':
        this.updatePinning(ctx, events, dt);
        break;
      case 'pouncing':
        this.updatePounce(ctx, events, dt);
        break;
      case 'charging':
        this.updateCharge(ctx, events, dt);
        break;
      case 'vomiting':
      case 'talking':
        this.updateRangedAbility(ctx, events, dt);
        break;
      case 'riding':
        this.updateRide(ctx, events, dt);
        break;
      case 'grabbed':
        this.updateGrab(ctx, events, dt);
        break;
      case 'windup':
        this.updateWindup(ctx, events, dt);
        break;
      case 'attack':
        this.updateAttackRecovery(ctx, dt);
        break;
      case 'chase':
      default:
        this.updateChase(ctx, events, dt);
        break;
    }

    // --- post-move bookkeeping ---------------------------------------------
    this.centre.set(this.position.x, this.position.y + def.height * 0.5, this.position.z);
    this.char.facing = this.yaw;
    // Keep the navigation node current (cheap: only when it may have changed).
    if (this.state !== 'dead') {
      const node = this.nav.nodeAt(this.position.x, this.position.y + 0.4, this.position.z, 2);
      if (node !== -1) this.flowNode = node;
    }
  }

  /** Look for a survivor to hunt, or a noise to investigate. */
  private senseForTargets(ctx: CombatContext, noiseEvents: NoiseEvent[]): void {
    const def = this.def;
    const s = this.sense;
    s.target = null;
    s.noise = null;
    let bestDist = Infinity;

    for (const survivor of ctx.survivors) {
      if (survivor.dead) continue;
      // Downed survivors are still a target but lower priority than standing ones.
      const dx = survivor.position.x - this.position.x;
      const dy = survivor.position.y - this.position.y;
      const dz = survivor.position.z - this.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > def.sightRange) continue;
      const priority = dist * (survivor.incapacitated ? 1.6 : 1);
      if (priority >= bestDist) continue;
      if (!this.canSee(survivor.position, dist)) continue;
      bestDist = priority;
      s.target = survivor;
    }

    // Noise: gunfire and screams are heard from far beyond sight range.
    let bestNoise: NoiseEvent | null = null;
    let bestNoiseScore = 0;
    for (const n of noiseEvents) {
      const dist = Math.hypot(n.x - this.position.x, n.z - this.position.z);
      if (dist > n.loudness || dist > def.hearingRange) continue;
      const score = (n.loudness - dist) / Math.max(1, n.loudness);
      if (score > bestNoiseScore) {
        bestNoiseScore = score;
        bestNoise = n;
      }
    }
    s.noise = bestNoise;

    if (s.target) {
      this.target = s.target;
      this.lastKnown.copy(s.target.position);
      this.hasLastKnown = true;
      if (this.state === 'idle' || this.state === 'wander' || this.state === 'dormant') {
        if (this.variant !== 'witch') this.state = 'chase';
      }
    } else if (bestNoise && !this.target) {
      this.lastKnown.set(bestNoise.x, bestNoise.y, bestNoise.z);
      this.hasLastKnown = true;
      if (this.state === 'idle' || this.state === 'wander') this.state = 'chase';
    }
  }

  /** Line of sight test: a single ray with a mask that ignores thin clutter. */
  canSee(point: THREE.Vector3, dist: number): boolean {
    // Start the ray at eye height so low cover does not block vision.
    EYE.set(this.position.x, this.position.y + this.def.height * 0.85, this.position.z);
    DIR.subVectors(point, EYE);
    DIR.y += 0.2;
    const len = DIR.length();
    if (len < 0.001) return true;
    DIR.multiplyScalar(1 / len);
    const blocked = this.navBlocked(EYE, DIR, Math.min(len, dist));
    return !blocked;
  }

  /** Set by the manager: a shared LOS query against the collision world. */
  losCheck: ((from: THREE.Vector3, dir: THREE.Vector3, dist: number) => boolean) | null = null;

  private navBlocked(from: THREE.Vector3, dir: THREE.Vector3, dist: number): boolean {
    if (!this.losCheck) return false;
    return this.losCheck(from, dir, dist);
  }

  // --- movement helpers ----------------------------------------------------

  /**
   * Steer toward a world position using the nav flow field, falling back to
   * straight-line movement when no flow data is available (e.g. the target is
   * close and visible).
   */
  private steerToward(x: number, z: number, dt: number, allowDirect = true): boolean {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) {
      this.steer.set(0, 0, 0);
      return true;
    }
    let used = false;
    // Follow the flow field when the goal is far or occluded.
    if ((!allowDirect || dist > 8 || !this.hasLineTo(x, z)) && this.flowNode >= 0) {
      const ok = this.nav.flowDirection(this.flowNode, this.steer, dist > 12 ? 3 : 1);
      if (ok && (this.steer.x !== 0 || this.steer.z !== 0)) used = true;
    }
    if (!used) {
      this.steer.set(dx / dist, 0, dz / dist);
    }
    void dt;
    return used;
  }

  /** Cheap two-point LOS used to decide between direct steering and the flow field. */
  private hasLineTo(x: number, z: number): boolean {
    if (!this.losCheck) return true;
    DIR.set(x - this.position.x, 0, z - this.position.z);
    const len = Math.hypot(DIR.x, DIR.z);
    if (len < 0.001) return true;
    DIR.multiplyScalar(1 / len);
    EYE.set(this.position.x, this.position.y + 0.9, this.position.z);
    return !this.losCheck(EYE, DIR, len);
  }

  /** Apply the current steering intent to the character controller. */
  private move(dt: number, speed: number, crouch = false, jump = false): void {
    const sx = this.steer.x;
    const sz = this.steer.z;
    const len = Math.hypot(sx, sz);
    const dirX = len > 1e-4 ? sx / len : 0;
    const dirZ = len > 1e-4 ? sz / len : 0;
    this.char.update(dt, {
      dirX,
      dirZ,
      speed: speed * this.speedJitter,
      canAccelerate: true,
      jump,
      crouch: crouch || this.crawler,
    });
    // Face the direction of travel (or the target when restrained).
    if (len > 1e-4) {
      const desired = Math.atan2(dirX, dirZ);
      this.yaw = rotateToward(this.yaw, desired, this.def.turnRate * dt);
    }
  }

  /** Face a world point without moving. */
  private faceToward(x: number, z: number, dt: number, rate = 1): void {
    const desired = Math.atan2(x - this.position.x, z - this.position.z);
    this.yaw = rotateToward(this.yaw, desired, this.def.turnRate * rate * dt);
  }

  // --- states -------------------------------------------------------------

  private updateDormant(ctx: CombatContext, events: CombatEvents): void {
    // The Witch cries quietly and swipes at anyone who comes too close.
    const ability = this.def.ability;
    const aggroRadius = ability?.aggroRadius ?? 7;
    for (const s of ctx.survivors) {
      if (s.dead) continue;
      const d = s.position.distanceTo(this.position);
      if (d < aggroRadius) {
        events.onAbility(this, 'witch_aggro', s);
        this.enrage();
        return;
      }
    }
    this.faceToward(ctx.lead.position.x, ctx.lead.position.z, ctx.dt, 0.2);
    this.move(ctx.dt, 0);
  }

  private updateIdle(_ctx: CombatContext): void {
    this.move(_ctx.dt, 0);
    if (this.rng.chance(_ctx.dt * 0.25)) this.state = 'wander';
  }

  private updateWander(_ctx: CombatContext, dt: number): void {
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = 3 + this.rng.next() * 5;
      const p = this.nav.randomPointNear(this.position.x, this.position.z, 14, () => this.rng.next(), undefined, 8);
      if (p) this.wanderTarget.copy(p);
      else this.wanderTarget.copy(this.position);
    }
    this.steerToward(this.wanderTarget.x, this.wanderTarget.z, dt);
    this.move(dt, this.def.walkSpeed * 0.6);
    if (this.position.distanceTo(this.wanderTarget) < 1.5) this.state = 'idle';
  }

  private updateChase(ctx: CombatContext, events: CombatEvents, dt: number): void {
    const def = this.def;
    const target = this.target;

    // Special behaviours that interrupt the chase.
    if (this.special && this.abilityTimer <= 0 && target && !target.dead) {
      if (this.tryAbility(ctx, events, target)) return;
    }

    if (!target || target.dead) {
      // Keep walking to the last known position, then resume wandering.
      if (this.hasLastKnown) {
        this.steerToward(this.lastKnown.x, this.lastKnown.z, dt);
        const d = this.position.distanceTo(this.lastKnown);
        this.move(dt, def.runSpeed * 0.55);
        if (d < 2.2) {
          this.hasLastKnown = false;
          this.state = 'wander';
        }
      } else {
        this.state = 'wander';
      }
      return;
    }

    const dx = target.position.x - this.position.x;
    const dz = target.position.z - this.position.z;
    const dy = target.position.y - this.position.y;
    const dist = Math.hypot(dx, dz);
    const reach = def.attackRange + (target.incapacitated ? 0.2 : 0);

    // In range: start the attack wind-up (telegraphed, dodgeable).
    if (dist <= reach && Math.abs(dy) < 2.2 && this.attackCooldown <= 0) {
      this.state = 'windup';
      this.stateTime = 0;
      this.steer.set(0, 0, 0);
      events.onAbility(this, 'attack_windup');
      return;
    }

    // Movement: commons shamble, then sprint once close (the classic L4D feel).
    const closeEnough = dist < (this.crawler ? 12 : 18);
    const speed = closeEnough ? def.runSpeed : def.walkSpeed * 1.15;
    this.steerToward(target.position.x, target.position.z, dt);
    this.move(dt, speed, false, false);
    // Face the target while approaching so attacks read correctly.
    this.faceToward(target.position.x, target.position.z, dt, 0.6);
  }

  /** Attack wind-up: the tell that gives the player time to react. */
  private updateWindup(ctx: CombatContext, events: CombatEvents, dt: number): void {
    const target = this.target;
    if (!target || target.dead || !this.alive) {
      this.state = 'chase';
      return;
    }
    this.steer.set(0, 0, 0);
    this.faceToward(target.position.x, target.position.z, dt, 2.2);
    // Creep forward slightly during the wind-up.
    const dx = target.position.x - this.position.x;
    const dz = target.position.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > this.def.attackRange * 0.75) {
      this.steer.set(dx / dist, 0, dz / dist);
      this.move(dt, this.def.runSpeed * 0.5);
    } else {
      this.move(dt, 0);
    }
    if (this.stateTime >= this.def.attackWindup) {
      this.performAttack(ctx, events, target);
    }
  }

  private updateAttackRecovery(_ctx: CombatContext, dt: number): void {
    this.move(dt, 0);
    if (this.stateTime > 0.25) this.state = 'chase';
  }

  /** Land the melee hit. */
  private performAttack(ctx: CombatContext, events: CombatEvents, target: SurvivorEntity): void {
    const def = this.def;
    const dist = Math.hypot(target.position.x - this.position.x, target.position.z - this.position.z);
    if (dist > def.attackRange * 1.35) {
      this.state = 'chase';
      this.attackCooldown = 0.2;
      return;
    }
    const damage = def.attackDamage * ctx.zombieDamage;
    const opts: DamageOptions = {
      source: this.position,
      attacker: this,
      kind: 'melee',
      hitZone: 'torso',
      impulse: 0,
    };
    // The Tank's fist also flings the survivor.
    if (this.variant === 'tank') {
      events.onAbility(this, 'tank_swing', target);
      (target as unknown as { knockback?: (dir: THREE.Vector3, force: number) => void }).knockback?.(
        DIR.set(target.position.x - this.position.x, 0, target.position.z - this.position.z).normalize(),
        7,
      );
    }
    events.applyDamage(target, damage, opts);
    this.attackCooldown = def.attackInterval;
    this.state = 'attack';
    this.stateTime = 0;
    events.onAbility(this, 'attack', target);
  }

  // --- special abilities ---------------------------------------------------

  /** Returns true when the infected committed to an ability this frame. */
  private tryAbility(ctx: CombatContext, events: CombatEvents, target: SurvivorEntity): boolean {
    const def = this.def;
    const ability = def.ability;
    if (!ability) return false;
    const dx = target.position.x - this.position.x;
    const dz = target.position.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    const canSeeTarget = this.canSee(target.position, dist);

    switch (def.attack) {
      case 'explode': {
        // Boomer: walk in, then vomit bile over a cluster.
        if (dist < 14 && canSeeTarget && !target.incapacitated) {
          this.state = 'vomiting';
          this.stateTime = 0;
          this.abilityTimer = 6;
          this.faceToward(target.position.x, target.position.z, ctx.dt, 3);
          events.onAbility(this, 'boomer_vomit', target);
          return true;
        }
        return false;
      }
      case 'pounce': {
        // Hunter: crouch for a moment, then leap. Only from range with LOS.
        const range = ability.pounceRange ?? 24;
        if (dist > 4 && dist < range && canSeeTarget) {
          const arc = this.ballisticPitch(dist, -8, ability.pounceSpeed ?? 16);
          this.pounceVel.set(dx / dist, 0, dz / dist).multiplyScalar(ability.pounceSpeed ?? 16);
          this.pounceVel.y = arc;
          this.state = 'pouncing';
          this.stateTime = 0;
          this.abilityTimer = 4;
          this.char.gravityEnabled = true;
          events.onAbility(this, 'hunter_pounce', target);
          return true;
        }
        return false;
      }
      case 'tongue': {
        // Smoker: drag a survivor out of position.
        const range = ability.tongueRange ?? 26;
        if (dist > 5 && dist < range && canSeeTarget) {
          this.state = 'talking';
          this.stateTime = 0;
          this.abilityTimer = 7;
          this.tongueTarget = target;
          this.tongueState = 'firing';
          this.tongueEnd.copy(target.position);
          this.tongueEnd.y += 0.9;
          events.onAbility(this, 'smoker_tongue', target);
          return true;
        }
        return false;
      }
      case 'acid': {
        // Spitter: arc an acid glob over short cover.
        const range = ability.acidRange ?? 20;
        if (dist > 4 && dist < range) {
          const speed = 20;
          this.projectileVel.set(dx / dist, 0, dz / dist).multiplyScalar(speed);
          this.projectileVel.y = this.ballisticPitch(dist, 0.5, speed);
          this.state = 'vomiting';
          this.stateTime = 0;
          this.abilityTimer = 5.5;
          this.projectileType = 'acid';
          events.onAbility(this, 'spitter_spit', target);
          return true;
        }
        return false;
      }
      case 'ride': {
        // Jockey: leap onto the survivor's head and steer them into danger.
        const range = 9;
        if (dist > 2.5 && dist < range && canSeeTarget) {
          this.pounceVel.set(dx / dist, 0, dz / dist).multiplyScalar(8.5);
          this.pounceVel.y = this.ballisticPitch(dist, 1.6, 8.5);
          this.state = 'pouncing';
          this.stateTime = 0;
          this.abilityTimer = 6;
          this.ridingIntent = true;
          events.onAbility(this, 'jockey_leap', target);
          return true;
        }
        return false;
      }
      case 'charge': {
        // Charger: line up, then charge in a straight line.
        const range = ability.chargeRange ?? 20;
        if (dist > 6 && dist < range && canSeeTarget) {
          this.chargeDir.set(dx / dist, 0, dz / dist);
          this.state = 'charging';
          this.stateTime = 0;
          this.abilityTimer = 7;
          this.faceToward(target.position.x, target.position.z, ctx.dt, 8);
          events.onAbility(this, 'charger_charge', target);
          return true;
        }
        return false;
      }
      case 'fist': {
        // Tank: throw a rock at range.
        const rockRange = ability.rockRange ?? 32;
        if (dist > 10 && dist < rockRange && canSeeTarget) {
          this.projectileVel.set(dx / dist, 0, dz / dist).multiplyScalar(26);
          this.projectileVel.y = this.ballisticPitch(dist * 0.9, 1.4, 26);
          this.state = 'vomiting';
          this.stateTime = 0;
          this.abilityTimer = ability.rockCooldown ?? 6;
          this.projectileType = 'rock';
          events.onAbility(this, 'tank_rock', target);
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  /** Launch pitch that lands a ballistic projectile on a target `dist` away. */
  private ballisticPitch(dist: number, targetDrop: number, speed: number): number {
    const g = 20.5;
    const t = dist / speed;
    // y = v*t + 0.5*g*t^2 solved for v, aiming at (target height + drop).
    const v = (targetDrop - 0.5 * g * t * t) / Math.max(0.001, t);
    return clamp(v, -speed, speed);
  }

  // --- ability states ------------------------------------------------------

  private tongueTarget: SurvivorEntity | null = null;
  /** Tongue lifecycle, read by the manager to resolve the grab. */
  tongueState: 'firing' | 'pulling' | 'missed' = 'missed';
  /**
   * Projectiles queued by abilities this frame; the manager consumes this list
   * after the update so projectile spawning stays in one place.
   */
  readonly projectileSpawnQueue: { kind: 'acid' | 'rock' | 'bile'; vx: number; vy: number; vz: number; damage: number; fuse?: number }[] = [];
  readonly tongueStart = new THREE.Vector3();
  readonly tongueEnd = new THREE.Vector3();
  /** Visual state the renderer reads. */
  readonly projectileVel = new THREE.Vector3();
  projectileType: 'acid' | 'rock' | null = null;
  projectileFired = false;
  private ridingIntent = false;

  private updateRangedAbility(ctx: CombatContext, events: CombatEvents, dt: number): void {
    const def = this.def;
    this.steer.set(0, 0, 0);
    if (this.tongueTarget) this.faceToward(this.tongueTarget.position.x, this.tongueTarget.position.z, dt, 1.5);
    else if (this.target) this.faceToward(this.target.position.x, this.target.position.z, dt, 1.5);
    this.move(dt, 0);
    this.tongueStart.set(this.position.x, this.position.y + def.height * 0.75, this.position.z);

    const commitTime = def.attack === 'tongue' ? 0.35 : def.attack === 'acid' ? 0.45 : 0.55;
    if (this.stateTime < commitTime) return;

    if (def.attack === 'explode') {
      // Boomer vomit: bile projectile with a short arc.
      if (!this.projectileSpawned) {
        this.projectileSpawned = true;
        const target = this.target ?? this.tongueTarget;
        if (target) {
          const dx = target.position.x - this.position.x;
          const dz = target.position.z - this.position.z;
          const dist = Math.max(0.5, Math.hypot(dx, dz));
          const speed = 17;
          this.projectileSpawnQueue.push({
            kind: 'bile',
            vx: (dx / dist) * speed,
            vy: this.ballisticPitch(dist, 0.4, speed),
            vz: (dz / dist) * speed,
            damage: 0,
          });
        }
      }
      if (this.stateTime > 0.9) {
        this.state = 'chase';
        this.projectileType = null;
        this.projectileSpawned = false;
      }
      return;
    }

    if (def.attack === 'tongue') {
      if (this.tongueState === 'firing') {
        // Extend the tongue toward the target; the manager resolves the hit.
        this.tongueEnd.lerp(this.tongueTarget ? TMP.set(this.tongueTarget.position.x, this.tongueTarget.position.y + 0.9, this.tongueTarget.position.z) : this.tongueStart, 1 - Math.exp(-14 * dt));
        events.onAbility(this, 'tongue_tick', this.tongueTarget ?? undefined);
        if (!this.tongueTarget || !this.tongueTarget.pinnedBy) {
          if (this.stateTime > 0.6) {
            this.tongueState = 'missed';
            this.state = 'chase';
          }
        }
      }
      if (this.stateTime > 1.2 && this.tongueState !== 'pulling') {
        this.state = 'chase';
        this.tongueState = 'missed';
      }
      return;
    }

    if (def.attack === 'acid' || def.attack === 'fist') {
      if (!this.projectileSpawned) {
        this.projectileSpawned = true;
        if (this.projectileVel.lengthSq() > 0.1) {
          this.projectileSpawnQueue.push({
            kind: this.projectileType === 'rock' ? 'rock' : 'acid',
            vx: this.projectileVel.x,
            vy: this.projectileVel.y,
            vz: this.projectileVel.z,
            damage: this.projectileType === 'rock' ? (this.def.ability?.rockDamage ?? 40) : 0,
          });
        }
      }
      if (this.stateTime > 0.85) {
        this.state = 'chase';
        this.projectileType = null;
        this.projectileSpawned = false;
      }
      return;
    }
    this.state = 'chase';
    void events;
    void ctx;
  }

  projectileSpawned = false;

  private updatePounce(ctx: CombatContext, events: CombatEvents, dt: number): void {
    // Ballistic dash: keep the velocity, gravity already handles the arc.
    const ability = this.def.ability;
    const maxTime = ability?.pounceMaxTime ?? 2.2;
    this.char.velocity.copy(this.pounceVel);
    this.char.gravityEnabled = true;
    // The character controller integrates the velocity; give it a zero intent
    // so it does not overwrite our dash.
    this.steer.set(this.pounceVel.x, 0, this.pounceVel.z);
    this.char.update(dt, { dirX: 0, dirZ: 0, speed: 0, canAccelerate: false, jump: false, crouch: this.crawler });
    this.yaw = Math.atan2(this.pounceVel.x, this.pounceVel.z);

    // Hit test: did we land on a survivor?
    for (const s of ctx.survivors) {
      if (s.dead) continue;
      const d = s.position.distanceTo(this.position);
      if (d < 1.35 && !s.pinnedBy) {
        if (this.ridingIntent) {
          // Jockey: cling to the survivor.
          this.pinnedSurvivor = s;
          this.state = 'riding';
          this.stateTime = 0;
          s.pinBy(this, 'ride');
          events.onPin(s, this);
          return;
        }
        // Hunter: pin and claw.
        this.pinnedSurvivor = s;
        this.state = 'pinned';
        this.stateTime = 0;
        s.pinBy(this, 'pounce');
        events.onPin(s, this);
        const dmg = (ability?.pounceDamage ?? 16) * ctx.zombieDamage;
        events.applyDamage(s, dmg, { source: this.position, attacker: this, kind: 'pounce' });
        return;
      }
    }
    if (this.stateTime > maxTime || this.char.grounded) {
      this.state = 'chase';
      this.ridingIntent = false;
      this.char.velocity.multiplyScalar(0.2);
    }
  }

  private updateCharge(ctx: CombatContext, events: CombatEvents, dt: number): void {
    const def = this.def;
    const speed = def.ability?.chargeSpeed ?? 13;
    this.steer.copy(this.chargeDir);
    this.char.update(dt, { dirX: this.chargeDir.x, dirZ: this.chargeDir.z, speed, canAccelerate: true, jump: false, crouch: false });
    this.yaw = Math.atan2(this.chargeDir.x, this.chargeDir.z);

    // Landing the charge pins the survivor.
    for (const s of ctx.survivors) {
      if (s.dead) continue;
      const d = Math.hypot(s.position.x - this.position.x, s.position.z - this.position.z);
      if (d < 1.5 && !s.pinnedBy && !s.incapacitated) {
        this.pinnedSurvivor = s;
        this.state = 'grabbed';
        this.stateTime = 0;
        s.pinBy(this, 'pounce');
        events.onPin(s, this);
        events.applyDamage(s, (def.ability?.chargeDamage ?? 24) * ctx.zombieDamage, { source: this.position, attacker: this, kind: 'pounce' });
        return;
      }
    }
    const maxTime = def.ability?.chargeDuration ?? 2.2;
    if (this.stateTime > maxTime || this.char.velocity.lengthSq() < 4) {
      this.state = 'chase';
      this.chargeDir.set(0, 0, 0);
    }
  }

  /** Hunter pinning / smoker dragging: continuous damage until rescued. */
  private updatePinning(ctx: CombatContext, events: CombatEvents, dt: number): void {
    const victim = this.pinnedSurvivor;
    this.steer.set(0, 0, 0);
    this.move(dt, 0);
    if (!victim || victim.dead) {
      this.release();
      return;
    }
    this.faceToward(victim.position.x, victim.position.z, dt, 2);
    // Claw every attackInterval.
    if (this.attackCooldown <= 0) {
      this.attackCooldown = this.def.attackInterval;
      events.applyDamage(victim, this.def.attackDamage * ctx.zombieDamage, {
        source: this.position,
        attacker: this,
        kind: 'melee',
      });
    }
    // Drag the survivor toward us (steals position, looks terrifying).
    if (this.variant === 'smoker') {
      const dx = this.position.x - victim.position.x;
      const dz = this.position.z - victim.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 2) {
        (victim as unknown as { dragTo?: (x: number, z: number, dt: number) => void }).dragTo?.(
          this.position.x,
          this.position.z,
          dt,
        );
      }
    }
  }

  private updateRide(ctx: CombatContext, events: CombatEvents, _dt: number): void {
    const victim = this.pinnedSurvivor;
    this.steer.set(0, 0, 0);
    if (!victim || victim.dead) {
      this.release();
      return;
    }
    // Sit on their head and steer them.
    this.position.set(victim.position.x, victim.position.y + victim.maxHealth * 0 + 1.55, victim.position.z);
    this.char.velocity.set(0, 0, 0);
    const steer = (victim as unknown as { steerTo?: (x: number, z: number) => void });
    steer.steerTo?.(this.rng.range(-1, 1), this.rng.range(-1, 1));
    if (this.attackCooldown <= 0) {
      this.attackCooldown = 0.8;
      events.applyDamage(victim, (this.def.ability?.rideDamagePerSec ?? 10) * ctx.zombieDamage, {
        source: this.position,
        attacker: this,
        kind: 'melee',
        dot: true,
      });
    }
    const maxTime = this.def.ability?.rideDuration ?? 9;
    if (this.stateTime > maxTime) this.release();
  }

  private updateGrab(ctx: CombatContext, events: CombatEvents, dt: number): void {
    const victim = this.pinnedSurvivor;
    this.steer.set(0, 0, 0);
    this.move(dt, 0);
    if (!victim || victim.dead) {
      this.release();
      return;
    }
    this.faceToward(victim.position.x, victim.position.z, dt, 1.5);
    // Slam repeatedly.
    if (this.stateTime > 0.8 && this.attackCooldown <= 0) {
      this.attackCooldown = 1.4;
      events.applyDamage(victim, this.def.attackDamage * ctx.zombieDamage, { source: this.position, attacker: this, kind: 'crush' });
    }
    if (this.stateTime > 3.4) this.release();
    void events;
  }

  /** Let go of whoever we are holding. */
  release(): void {
    if (this.pinnedSurvivor) {
      this.pinnedSurvivor.releasePin('escaped');
      this.pinnedSurvivor = null;
    }
    this.pinnedSurvivor = null;
    this.tongueTarget = null;
    this.ridingIntent = false;
    if (this.alive) {
      this.state = 'chase';
      this.stateTime = 0;
      this.attackCooldown = 0.6;
    }
  }

  /** Smoker tongue fully connected: begin the drag. */
  attachTongue(victim: SurvivorEntity): void {
    this.tongueState = 'pulling';
    this.pinnedSurvivor = victim;
    this.state = 'pinned';
    this.stateTime = 0;
    victim.pinBy(this, 'tongue');
  }

  /** Boomer death / vomit: bile everywhere. */
  explodeBile(): void {
    this.bileExploded = true;
  }

  bileExploded = false;

  /** Knockback applied by explosions, Tank hits and shoves. */
  knockback(dir: THREE.Vector3, force: number): void {
    this.char.velocity.addScaledVector(dir, force);
    this.char.grounded = false;
    if (force > 6) this.stagger(Math.min(0.6, force * 0.05));
  }

  /** Force the walking animation to match the current speed. */
  updateWalkPhase(dt: number): void {
    const speed = Math.hypot(this.char.velocity.x, this.char.velocity.z);
    this.walkPhase += dt * (1.6 + speed * 1.6);
  }

  /** Distance from this infected to a point (used by the audio mixer). */
  distanceTo(x: number, y: number, z: number): number {
    return Math.hypot(this.position.x - x, this.position.y - y, this.position.z - z);
  }
}

const TMP = new THREE.Vector3();
const EYE = new THREE.Vector3();
const DIR = new THREE.Vector3();

export type { CollisionScratch };
export { angleDelta };
