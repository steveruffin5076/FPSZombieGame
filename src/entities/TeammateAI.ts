/**
 * AI TEAMMATE
 * ===========
 * One survivor driven by a small utility-based brain. The goal is that a
 * teammate is *useful and readable*, not omniscient:
 *
 *   - It reacts with a personality-dependent delay (Rook snap-shoots, Callahan
 *     takes a beat to line up), so the squad has texture.
 *   - It aims with a per-personality error cone and applies trigger discipline,
 *     so it feels like a person shooting rather than a turret.
 *   - Priorities are explicit and ordered: **rescue > revive > defend self >
 *     follow**. That ordering is what makes players trust them.
 *   - Repairing relationships: it always checks the people first, so it will
 *     abandon a fight to pick someone up — the L4D behaviour players expect.
 *
 * Pathing uses the player's navigation flow field (which points *toward* the
 * player) for following, and direct steering with LOS for combat, with the flow
 * field as a fallback when a target is occluded.
 */
import * as THREE from 'three';
import { bus } from '@/core/Events';
import { Rng, clamp, clamp01 } from '@/core/MathUtil';
import type { CollisionWorld, GroundOut } from '@/physics/Collision';
import { CollisionScratch } from '@/physics/Collision';
import { coneQuery, type EntityIndex } from '@/weapons/Ballistics';
import { weaponDef, HEAL_ITEMS, type WeaponDef } from '@/config/weapons';
import { COMBAT, SURVIVORS, VOICE, type PersonalityDef, type VoiceCue } from '@/config/zombies';
import { Survivor } from '@/entities/Survivor';
import type { Zombie } from '@/entities/Zombie';
import type { EntityManager } from '@/entities/EntityManager';
import type { NavGrid } from '@/world/Nav';
import type { Effects } from '@/vfx/Effects';
import type { AudioSystem } from '@/audio/Audio';
import type { ZTarget } from '@/entities/Types';

type TeammateGoal =
  | { kind: 'idle' }
  | { kind: 'follow'; x: number; z: number }
  | { kind: 'engage'; zombie: Zombie; distance: number }
  | { kind: 'revive'; target: Survivor }
  | { kind: 'rescue'; target: Survivor; attacker: ZTarget }
  | { kind: 'retreat'; x: number; z: number }
  | { kind: 'heal' }
  | { kind: 'navigate'; x: number; z: number; why: string };

interface TeammateWeapon {
  def: WeaponDef;
  ammo: number;
  reserve: number;
  cooldown: number;
  reloading: number;
}

/**
 * Catch-up leash for AI survivors: an agent this far from the lead survivor for
 * this long is warped back to the squad (see the regroup block in `update`).
 * Genre-standard behaviour — without it, one wedged doorway makes the chapter's
 * "whole squad in the safe room" ending unreachable.
 */
const TEAMMATE_STRAND_DISTANCE = 45;
const TEAMMATE_STRAND_GRACE = 6;

export class TeammateAI extends Survivor {
  override readonly personality: PersonalityDef;
  private brain = new Rng(0xa11ce);
  private scratch = new CollisionScratch();

  /** Seconds the agent has been out of leash range of the lead survivor. */
  private strandedTime = 0;
  private goal: TeammateGoal = { kind: 'idle' };
  private decisionTimer = 0;
  private reactionTimer = 0;
  private currentTarget: Zombie | null = null;
  private aimYaw = 0;
  private aimPitch = 0;
  private burstCount = 0;
  private burstPause = 0;
  private actionTimer = 0;
  private meleeCooldown = 0;
  private shoveCooldown = 0;
  private consoleTimer = 0;
  private healUseTimer = 0;
  private weapons: TeammateWeapon;
  private meleeWeapon = 'melee_crowbar';
  private throwCount = 2;
  private lastSpoken = new Map<VoiceCue, number>();
  private coneScratch: ZTarget[] = [];
  private stuckTimer = 0;
  private lastPos = new THREE.Vector3();
  /** Marks a squad slot so teammates spread out instead of stacking. */
  readonly slotOffset: number;

  constructor(
    id: number,
    personality: PersonalityDef,
    world: CollisionWorld,
    private nav: NavGrid,
    private entities: EntityManager,
    private effects: Effects,
    private audio: AudioSystem,
    loadout: { primary: string; secondary: string },
    slotOffset: number,
  ) {
    super(id, personality.name, false, world, personality);
    this.personality = personality;
    this.slotOffset = slotOffset;
    this.weapons = {
      def: weaponDef(loadout.primary),
      ammo: weaponDef(loadout.primary).magazine,
      reserve: Math.floor(weaponDef(loadout.primary).spawnAmmo * 2),
      cooldown: 0,
      reloading: 0,
    };
    this.meleeWeapon = personality.kind === 'aggressive' ? 'melee_machete' : 'melee_crowbar';
    this.facing = 0;
  }

  /** Id of the weapon this teammate is currently carrying (HUD + restock). */
  get primaryWeaponId(): string {
    return this.weapons.def.id;
  }

  /**
   * Move the agent to a world position without collision resolution. Called when
   * the regroup leash fires — the nav flow field gets an agent close, this
   * closes the last gap when it cannot path back on its own.
   */
  warpTo(x: number, z: number): void {
    // Find the floor under the destination rather than assuming the player's Y:
    // a spot on a rooftop or a stair landing must not drop the agent through it.
    const surface: { surface?: unknown } = this.groundProbe;
    surface.surface = undefined;
    const y = this.world.groundAt(x, z, this.position.y + 4, 1.5, this.groundProbe);
    const targetY = Number.isFinite(y) ? y + 0.02 : this.position.y;
    this.char.teleport(x, targetY, z);
    this.char.snapToGround(3);
    this.strandedTime = 0;
  }

  /** Scratch sink for `groundAt` probes (surfaces only, no index list). */
  private readonly groundProbe: Exclude<GroundOut, number[]> = {};

  /**
   * Chapter reset: full health, fresh kit, no lingering pin/revive state. Called
   * when a chapter loads and again when the safe room restocks the squad.
   */
  resetForChapter(loadout: { primary: string; secondary: string }): void {
    this.health = this.maxHealth;
    this.tempHealth = 0;
    this.incapacitated = false;
    this.dead = false;
    this.pinnedBy = null;
    this.isBeingRevived = false;
    this.reviveProgress = 0;
    this.bleedOut = COMBAT.bleedOutTime;
    this.causeOfDeath = '';
    this.invulnerable = COMBAT.spawnProtectionTime;
    this.velocity.set(0, 0, 0);
    const def = weaponDef(loadout.primary);
    this.weapons = {
      def,
      ammo: def.magazine,
      reserve: Math.floor(def.spawnAmmo * 2),
      cooldown: 0,
      reloading: 0,
    };
    this.throwCount = 2;
    this.healUseTimer = 0;
    this.consoleTimer = 0;
  }

  // --- interface -----------------------------------------------------------

  aimOrigin(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.char.eyeY, this.position.z);
  }

  aimDirection(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.aimPitch);
    return out.set(Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), Math.cos(this.aimYaw) * cp).normalize();
  }

  get currentGoalKind(): string {
    return this.goal.kind;
  }

  get equippedWeaponName(): string {
    return this.weapons.def.name;
  }

  get ammoDisplay(): { mag: number; reserve: number } {
    return { mag: this.weapons.ammo, reserve: this.weapons.reserve };
  }

  // --- update --------------------------------------------------------------

  update(
    dt: number,
    ctx: { leadPos: THREE.Vector3; leadSlot: number; threats: Zombie[]; zombieDamage: number; regroup?: boolean },
  ): void {
    this.time += dt;
    this.updateStatus(dt);
    if (this.dead) return;

    // Frozen while pinned or riding.
    if (this.pinnedBy) {
      this.updatePinned(dt);
      return;
    }

    // --- regroup leash ------------------------------------------------------
    // AI survivors in this genre do not get permanently lost: an agent that has
    // been left far behind — or that is holding up the safe-room countdown —
    // rejoins the squad. Without it a single navigation failure (a wedged
    // doorway, a fence it refuses to path around) makes the chapter
    // unfinishable, because the ending requires the whole living squad inside.
    if (!this.incapacitated && !this.isBeingRevived) {
      const strandedDist = Math.hypot(ctx.leadPos.x - this.position.x, ctx.leadPos.z - this.position.z);
      if (ctx.regroup || strandedDist > TEAMMATE_STRAND_DISTANCE) {
        this.strandedTime += dt;
        if (this.strandedTime > (ctx.regroup ? 0 : TEAMMATE_STRAND_GRACE)) {
          this.warpTo(ctx.leadPos.x - Math.sin(this.facing) * 1.8, ctx.leadPos.z - Math.cos(this.facing) * 1.8);
        }
      } else {
        this.strandedTime = 0;
      }
    }

    this.weapons.cooldown = Math.max(0, this.weapons.cooldown - dt);
    this.weapons.reloading = Math.max(0, this.weapons.reloading - dt);
    this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);
    this.shoveCooldown = Math.max(0, this.shoveCooldown - dt);
    this.consoleTimer = Math.max(0, this.consoleTimer - dt);
    this.reactionTimer = Math.max(0, this.reactionTimer - dt);

    // Decision cadence: personalities think at different speeds.
    this.decisionTimer -= dt;
    if (this.decisionTimer <= 0) {
      this.decisionTimer = 0.22 + this.brain.next() * 0.12;
      this.chooseGoal(ctx);
    }

    this.executeGoal(dt, ctx);
    this.updateVoice(dt);
  }

  // --- decision making -----------------------------------------------------

  private chooseGoal(ctx: { leadPos: THREE.Vector3; leadSlot: number; threats: Zombie[]; zombieDamage: number }): void {
    // 1) Someone is pinned (Hunter/Jockey/Smoker) — highest priority.
    for (const s of this.entities.survivors) {
      if (s.dead || s === this) continue;
      if (s.pinnedBy && !(s.pinnedBy as unknown as Zombie).alive) continue;
      if (s.pinnedBy) {
        const dist = this.position.distanceTo(s.position);
        if (dist < 22) {
          this.goal = { kind: 'rescue', target: s as Survivor, attacker: s.pinnedBy };
          return;
        }
      }
    }

    // 2) A teammate is down — pick them up.
    let bestDown: Survivor | null = null;
    let bestDownDist = Infinity;
    for (const s of this.entities.survivors) {
      if (s === this || s.dead || !s.incapacitated) continue;
      const d = this.position.distanceTo(s.position);
      // Altruism gates how far they will travel to help.
      if (d < bestDownDist && d < 26 + this.personality.altruism * 26) {
        bestDownDist = d;
        bestDown = s as Survivor;
      }
    }
    if (bestDown) {
      this.goal = { kind: 'revive', target: bestDown };
      return;
    }

    // 3) Self-preservation: heal when badly hurt and safe.
    if (this.health + this.tempHealth < 45 && this.healUseTimer <= 0) {
      const nearbyThreats = this.countNearbyThreats(ctx.threats, 9);
      if (nearbyThreats === 0 || this.health < 25) {
        this.goal = { kind: 'heal' };
        return;
      }
    }

    // 4) Shoot the closest visible threat.
    const threat = this.pickThreat(ctx);
    if (threat) {
      const dist = this.position.distanceTo(threat.position);
      // Cautious personalities back off from a Tank or a big group.
      if (threat.variant === 'tank' && this.personality.caution > 0.6 && dist < 14) {
        const away = new THREE.Vector3().subVectors(this.position, threat.position).setY(0).normalize();
        this.goal = { kind: 'retreat', x: this.position.x + away.x * 8, z: this.position.z + away.z * 8 };
        return;
      }
      this.goal = { kind: 'engage', zombie: threat, distance: dist };
      return;
    }

    // 5) Stay with the squad.
    const toLead = new THREE.Vector3().subVectors(ctx.leadPos, this.position);
    const distToLead = Math.hypot(toLead.x, toLead.z);
    if (distToLead > this.personality.followDistance) {
      this.goal = { kind: 'follow', x: ctx.leadPos.x, z: ctx.leadPos.z };
    } else if (distToLead < this.personality.followDistance * 0.55 && this.personality.kind !== 'aggressive') {
      // Too close: give the player room (drift forward toward the objective).
      this.goal = { kind: 'navigate', x: ctx.leadPos.x, z: ctx.leadPos.z, why: 'spread' };
    } else {
      this.goal = { kind: 'idle' };
    }
  }

  private countNearbyThreats(threats: Zombie[], radius: number): number {
    let n = 0;
    for (const z of threats) {
      if (!z.alive) continue;
      if (z.distanceTo(this.position.x, this.position.y, this.position.z) < radius) n++;
    }
    return n;
  }

  /** Pick the most dangerous visible infected (specials first, then proximity). */
  private pickThreat(ctx: { threats: Zombie[] }): Zombie | null {
    let best: Zombie | null = null;
    let bestScore = -Infinity;
    const aggressiveness = this.personality.aggression;
    for (const z of ctx.threats) {
      if (!z.alive) continue;
      const dx = z.position.x - this.position.x;
      const dy = z.position.y + 1 - this.char.eyeY;
      const dz = z.position.z - this.position.z;
      const dist = Math.hypot(dx, dy, dz);
      const range = dist < 40 ? 40 : 0;
      if (dist > range) continue;
      // Prefer targets this personality likes: aggressive = close, cautious = far.
      const idealRange = 6 + (1 - aggressiveness) * 22;
      const rangePenalty = Math.abs(dist - idealRange) / 22;
      let score = 3 - rangePenalty;
      if (z.special) score += 2.4; // specials are always the priority
      if (z.isPinning) score += 4;
      if (z.state === 'windup') score += 0.8;
      // Visibility check.
      DIR.set(dx, dy, dz).multiplyScalar(1 / Math.max(0.001, dist));
      EYE.set(this.position.x, this.char.eyeY, this.position.z);
      const blocked = this.world.raycastStatic(this.scratch.hit, EYE, DIR, dist, (b) => b.solid && b.surface !== 'glass');
      if (blocked.hit && blocked.distance < dist - 0.5) score -= 3;
      if (score > bestScore) {
        bestScore = score;
        best = z;
      }
    }
    return best;
  }

  // --- execution -----------------------------------------------------------

  private executeGoal(dt: number, ctx: { leadPos: THREE.Vector3; leadSlot: number; threats: Zombie[]; zombieDamage: number }): void {
    switch (this.goal.kind) {
      case 'rescue':
        this.runRescue(dt);
        break;
      case 'revive':
        this.runRevive(dt);
        break;
      case 'heal':
        this.runHeal(dt);
        break;
      case 'engage':
        this.runEngage(dt, this.goal.zombie, this.goal.distance);
        break;
      case 'retreat':
        this.moveToward(this.goal.x, this.goal.z, dt, 6.2, ctx.leadSlot);
        this.lookAtPoint(this.goal.x, this.goal.z, dt);
        break;
      case 'follow':
      case 'navigate':
        this.moveToward(this.goal.x, this.goal.z, dt, this.personality.kind === 'aggressive' ? 5.4 : 4.9, ctx.leadSlot);
        this.lookAtPoint(this.goal.x, this.goal.z, dt);
        break;
      case 'idle':
      default: {
        this.char.update(dt, { dirX: 0, dirZ: 0, speed: 0, canAccelerate: true, jump: false, crouch: false });
        // Idle look: face wherever the nearest threat would be.
        const threat = this.pickThreat(ctx);
        if (threat) this.lookAtPoint(threat.position.x, threat.position.z, dt, true, threat);
        else this.lookAtPoint(ctx.leadPos.x, ctx.leadPos.z, dt);
        break;
      }
    }
  }

  /** Fight a specific infected. */
  private runEngage(dt: number, zombie: Zombie, _distance: number): void {
    if (!zombie.alive) {
      this.goal = { kind: 'idle' };
      return;
    }
    const dist = this.position.distanceTo(zombie.position);
    this.currentTarget = zombie;

    // Melee anything that gets in our face (aggressive personalities more so).
    if (dist < 2.2 && this.meleeCooldown <= 0 && this.brain.chance(0.4 + this.personality.aggression * 0.5)) {
      this.meleeAttack(zombie);
    } else if (dist < 1.6 && this.shoveCooldown <= 0 && !zombie.special) {
      // Shove to buy space, then shoot.
      this.shove(zombie);
    }

    // Position: hold a preferred distance from the target.
    const ideal = 5 + (1 - this.personality.aggression) * 13;
    const dx = zombie.position.x - this.position.x;
    const dz = zombie.position.z - this.position.z;
    const len = Math.max(0.001, Math.hypot(dx, dz));
    if (dist > ideal + 2.5) {
      this.moveDirection(dx / len, dz / len, dt, 4.6);
    } else if (dist < ideal - 3.5 && zombie.special) {
      this.moveDirection(-dx / len, -dz / len, dt, 4.4);
    } else {
      // Strafe for a better angle.
      const strafeDir = Math.sin(this.time * 0.8 + this.slotOffset) > 0 ? 1 : -1;
      this.moveDirection((-dz / len) * strafeDir, (dx / len) * strafeDir, dt, 2.6);
    }

    // Aim with personality-dependent error and reaction delay.
    const aimPoint = TMP.set(zombie.position.x, zombie.position.y + zombie.def.height * 0.72, zombie.position.z);
    this.lookAtPoint(aimPoint.x, aimPoint.z, dt, true, zombie, false);
    const aimError = (this.personality.aimError * Math.PI) / 180;
    const jitter = (this.brain.next() * 2 - 1) * aimError;
    const jitterPitch = (this.brain.next() * 2 - 1) * aimError * 0.6;
    this.aimYaw += jitter;
    this.aimPitch = clamp(this.aimPitch + jitterPitch, -0.9, 0.9);

    // Fire control.
    if (this.reactionTimer <= 0) {
      this.fireAt(zombie, dist);
    } else if (this.reactionTimer < 0.02) {
      // Just spotted: call it out.
      this.speak('contact', 2.5);
    }
    // Utility: throw a pipe bomb at a cluster.
    if (this.throwCount > 0 && this.isClusterNearby(zombie, 5) && this.brain.chance(dt * 0.6 * this.personality.utilityUse)) {
      this.throwPipeBomb(zombie);
    }
    // Specials in a pin get focus fire — always shoot, no discipline.
    if (zombie.isPinning) this.fireAt(zombie, dist, true);
  }

  private isClusterNearby(center: Zombie, radius: number): boolean {
    let n = 0;
    for (const z of this.entities.zombies) {
      if (!z.alive || z.special) continue;
      if (z.distanceTo(center.position.x, center.position.y, center.position.z) < radius) n++;
    }
    return n >= 4;
  }

  private runRevive(dt: number): void {
    const goal = this.goal as { kind: 'revive'; target: Survivor };
    const target = goal.target;
    if (!target || target.dead || !target.incapacitated) {
      this.goal = { kind: 'idle' };
      return;
    }
    const dist = this.position.distanceTo(target.position);
    if (dist > 1.3) {
      this.moveToward(target.position.x, target.position.z, dt, 5.2, -1, true);
      this.lookAtPoint(target.position.x, target.position.z, dt);
      // Cover fire while approaching.
      const threat = this.pickThreat({ threats: this.entities.zombies });
      if (threat && threat.distanceTo(this.position.x, this.position.y, this.position.z) < 16) {
        this.lookAtPoint(threat.position.x, threat.position.z, dt, true, threat);
        this.fireAt(threat, this.position.distanceTo(threat.position));
      }
    } else {
      this.char.update(dt, { dirX: 0, dirZ: 0, speed: 0, canAccelerate: true, jump: false, crouch: true });
      this.lookAtPoint(target.position.x, target.position.z, dt);
      const progress = target.tickRevive(dt, this);
      if (progress >= 1) {
        this.speak('revived', 4);
        this.goal = { kind: 'idle' };
      }
    }
  }

  private runRescue(dt: number): void {
    const goal = this.goal as { kind: 'rescue'; target: Survivor; attacker: ZTarget };
    const victim = goal.target;
    const attacker = goal.attacker as unknown as Zombie;
    if (!victim || victim.dead || !victim.pinnedBy) {
      this.goal = { kind: 'idle' };
      return;
    }
    if (!attacker || !attacker.alive) {
      victim.releasePin('rescued');
      this.goal = { kind: 'idle' };
      return;
    }
    const distToAttacker = this.position.distanceTo(attacker.position);
    const distToVictim = this.position.distanceTo(victim.position);
    // Get into shove/melee range of the *attacker*, not the victim.
    if (distToAttacker > 2.6 || distToVictim > 3.5) {
      this.moveToward(attacker.position.x, attacker.position.z, dt, 5.6, -1, true);
      this.lookAtPoint(attacker.position.x, attacker.position.z, dt, true, attacker);
      // Shoot it while closing if we have a clean line.
      if (distToAttacker > 5) this.fireAt(attacker, distToAttacker, true);
    } else {
      this.char.update(dt, { dirX: 0, dirZ: 0, speed: 0, canAccelerate: true, jump: false, crouch: false });
      if (this.shoveCooldown <= 0) {
        this.shove(attacker);
        this.shoveCooldown = 0.9;
        this.audio.play('melee_shove_hit', { position: attacker.position });
      } else if (this.meleeCooldown <= 0) {
        this.meleeAttack(attacker);
      }
      this.audio.play('survivor_call', { position: this.position, volume: 0.6, ui: false });
    }
  }

  private runHeal(dt: number): void {
    // Stand still, use a medkit over time.
    this.char.update(dt, { dirX: 0, dirZ: 0, speed: 0, canAccelerate: true, jump: false, crouch: true });
    this.healUseTimer -= dt;
    if (this.healUseTimer <= 0) {
      this.healUseTimer = HEAL_ITEMS.medkit.useTimeMs / 1000 + 2;
      const before = this.health;
      this.heal(HEAL_ITEMS.medkit.heal);
      this.audio.play('heal_done', { position: this.position });
      if (this.health - before > 5) this.speak('healed', 6);
      this.goal = { kind: 'idle' };
    }
  }

  // --- combat primitives ---------------------------------------------------

  private fireAt(zombie: Zombie, dist: number, force = false): void {
    const w = this.weapons;
    if (!zombie.alive) return;
    if (w.reloading > 0 || w.cooldown > 0) return;
    if (w.ammo <= 0) {
      this.reload();
      return;
    }
    // Trigger discipline: burst fire with pauses, so they do not waste a mag.
    if (this.burstPause > 0) {
      this.burstPause -= 1;
      return;
    }
    if (!force && this.brain.next() > this.personality.fireDiscipline * 0.9 + 0.1) return;
    if (dist > w.def.falloffEnd * 1.6 && !force) return;

    const origin = this.aimOrigin(TMP2);
    const dir = this.aimDirection(DIR);
    // Spread for AI is small but non-zero; personalities add their own error.
    const spread = 0.9 + (1 - this.personality.aggression) * 0.6;
    const muzzle = TMP3.copy(origin).addScaledVector(dir, 0.4);
    const pellets = Math.max(1, w.def.pellets);
    for (let p = 0; p < pellets; p++) {
      const d = DIR.clone();
      jitterDirection(d, spread, this.brain, TMP4);
      const hit = this.world.raycastEntities(TMP4, d, w.def.falloffEnd * 2, this.entityQuery(zombie));
      if (hit && hit.entity === zombie) {
        const falloff = 1;
        const zoneMult = hit.zone === 'head' ? 3 : hit.zone === 'torso' ? 1 : 0.6;
        const dmg = w.def.damage * falloff * zoneMult * 0.92;
        zombie.takeDamage(dmg, { source: origin.clone(), attacker: this, kind: 'bullet', hitZone: hit.zone, impulse: 12 });
        this.effects.bloodSpray(hit.point.x, hit.point.y, hit.point.z, d.x, d.y, d.z, hit.zone === 'head' ? 1.3 : 0.8, hit.zone === 'head');
        this.audio.impactFlesh(hit.point, hit.zone === 'head');
        this.stats.hits++;
      } else {
        const wall = this.world.raycastStatic(this.scratch.hit, origin, TMP4, w.def.falloffEnd * 2);
        if (wall.hit) {
          this.effects.impact(wall.point.x, wall.point.y, wall.point.z, wall.normal.x, wall.normal.y, wall.normal.z, wall.surface, 0.6);
          this.audio.impactSurface(wall.surface, wall.point);
        }
      }
    }
    this.effects.muzzleFlash(muzzle.x, muzzle.y, muzzle.z, dir.x, dir.y, dir.z, w.def.flashScale * 0.9, false);
    this.effects.tracer(muzzle.x, muzzle.y, muzzle.z, origin.x + dir.x * 40, origin.y + dir.y * 40, origin.z + dir.z * 40, 0.022);
    this.audio.gunshot(w.def, muzzle);
    this.audio.emitNoise(muzzle, w.def.sfx.loudness * 30, 'gunshot');
    this.stats.shots++;
    w.ammo--;
    w.cooldown = w.def.cycleMs / 1000;
    // Burst control: short bursts with a breath between them.
    this.burstCount++;
    if (this.burstCount > (this.personality.kind === 'aggressive' ? 8 : 5)) {
      this.burstCount = 0;
      this.burstPause = 6 + Math.floor(this.brain.next() * 10);
    }
    this.reactionTimer = Math.max(this.reactionTimer, 0);
    if (this.brain.chance(0.03)) this.speak('reloading', 6);
  }

  private reload(): void {
    const w = this.weapons;
    if (w.reloading > 0) return;
    if (w.reserve <= 0) {
      // Out of ammo: fall back to the pistol (infinite-ish reserve like L4D).
      if (w.def.id !== 'pistol_m9') {
        w.def = weaponDef('pistol_m9');
        w.ammo = w.def.magazine;
        w.reserve = 999;
        this.speak('outOfAmmo', 5);
      }
      return;
    }
    w.reloading = w.def.reloadTimeMs / 1000;
    const need = w.def.magazine - w.ammo;
    const take = Math.min(need, w.reserve);
    w.ammo += take;
    w.reserve -= take;
    this.audio.play(w.def.sfx.reload as never, { position: this.position, volume: 0.7 });
  }

  /** Local melee: uses the same maths as the player's melee, lightly simplified. */
  private meleeAttack(target: Zombie): void {
    this.meleeCooldown = 0.55;
    const def = weaponDef(this.meleeWeapon);
    const m = def.melee!;
    const origin = TMP.set(this.position.x, this.position.y + 1.2, this.position.z);
    const forward = DIR.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw));
    this.coneScratch = coneQuery(this.entities, origin, forward, m.range, m.arc, m.targets, this.coneScratch as never) as never;
    for (const t of this.coneScratch as unknown as Zombie[]) {
      if (!t.alive) continue;
      const instakill = t.canBeInstakilled && this.brain.next() < m.instakillChance;
      t.takeDamage(instakill ? 9999 : m.damage, { source: origin.clone(), attacker: this, kind: 'melee', impulse: 60 });
      this.effects.bloodSpray(t.position.x, t.position.y + 1.2, t.position.z, forward.x, 0.2, forward.z, 1, instakill);
      if (instakill) this.effects.gib(t.position.x, t.position.y + 1.4, t.position.z, 0.6);
    }
    this.audio.play('melee_swing', { position: origin });
    this.audio.emitNoise(origin, 10, 'melee');
    void target;
  }

  private shove(target: Zombie): void {
    if (this.shoveCooldown > 0) return;
    this.shoveCooldown = 0.8;
    const origin = TMP.set(this.position.x, this.position.y + 1.2, this.position.z);
    const forward = DIR.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw));
    for (const z of this.entities.queryRadius(origin.x, origin.y, origin.z, 1.9)) {
      if (!z.alive) continue;
      const dx = z.position.x - origin.x;
      const dz = z.position.z - origin.z;
      const d = Math.hypot(dx, dz);
      if (d > 1.9) continue;
      if ((dx / d) * forward.x + (dz / d) * forward.z < 0.4) continue;
      z.knockback(TMP2.set(dx / d, 0, dz / d), 5.5);
      z.stagger(0.7);
      z.takeDamage(6, { source: origin.clone(), attacker: this, kind: 'melee', impulse: 120 });
    }
    this.audio.play('melee_shove_hit', { position: origin, volume: 0.5 });
    this.audio.emitNoise(origin, 8, 'melee');
    void target;
  }

  private throwPipeBomb(target: Zombie): void {
    this.throwCount--;
    const origin = TMP.set(this.position.x, this.char.eyeY, this.position.z);
    const dx = target.position.x - origin.x;
    const dz = target.position.z - origin.z;
    const dist = Math.hypot(dx, dz);
    const speed = 18;
    const vel = new THREE.Vector3((dx / dist) * speed, 0, (dz / dist) * speed);
    vel.y = (2.2 - 0.5 * 20.5 * Math.pow(dist / speed, 2)) / Math.max(0.2, dist / speed);
    this.entities.spawnProjectile({
      kind: 'pipebomb',
      position: origin.clone(),
      velocity: vel,
      owner: 'survivor',
      fuse: 2.6,
    });
    this.audio.play('throw', { position: origin });
    this.speak('throwing', 5);
  }

  // --- movement ------------------------------------------------------------

  /**
   * Follow the navigation flow field belonging to the lead survivor (which
   * points toward the player) or move directly when a line exists.
   */
  private moveToward(x: number, z: number, dt: number, speed: number, leadSlot: number, forceNav = false): void {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.6) {
      this.char.update(dt, { dirX: 0, dirZ: 0, speed: 0, canAccelerate: true, jump: false, crouch: false });
      return;
    }
    // Direct line if close or unoccluded; otherwise use the flow field.
    let dirX = dx / dist;
    let dirZ = dz / dist;
    const needNav = forceNav || dist > 14 || !this.hasLine(x, z);
    if (needNav && leadSlot >= 0 && this.nav.hasFlow(leadSlot)) {
      const node = this.nav.nodeAt(this.position.x, this.position.y + 0.5, this.position.z, 3);
      if (node >= 0 && this.nav.flowDirection(node, PATH, 2, leadSlot)) {
        // Blend the field direction with the direct direction for smoothness.
        const w = clamp01((dist - 6) / 18);
        dirX = PATH.x * w + dirX * (1 - w);
        dirZ = PATH.z * w + dirZ * (1 - w);
        const l = Math.hypot(dirX, dirZ) || 1;
        dirX /= l;
        dirZ /= l;
      }
    }
    this.moveDirection(dirX, dirZ, dt, speed);
    this.facing = Math.atan2(dirX, dirZ);
  }

  private moveDirection(dirX: number, dirZ: number, dt: number, speed: number): void {
    this.char.update(dt, {
      dirX,
      dirZ,
      speed,
      canAccelerate: true,
      jump: this.isStuck() && this.char.grounded,
      crouch: false,
    });
    // Unstuck: if we barely moved for a while, sidestep.
    const moved = this.position.distanceToSquared(this.lastPos);
    if (moved < 0.0004) this.stuckTimer += dt;
    else this.stuckTimer = 0;
    this.lastPos.copy(this.position);
    if (this.stuckTimer > 0.7) {
      this.stuckTimer = 0;
      const side = this.brain.chance(0.5) ? 1 : -1;
      this.char.velocity.x += -dirZ * side * 3.4;
      this.char.velocity.z += dirX * side * 3.4;
      this.char.velocity.y = 4.4;
    }
  }

  private isStuck(): boolean {
    return this.stuckTimer > 0.5;
  }

  private hasLine(x: number, z: number): boolean {
    DIR.set(x - this.position.x, 0, z - this.position.z);
    const len = DIR.length();
    if (len < 0.2) return true;
    DIR.multiplyScalar(1 / len);
    EYE.set(this.position.x, this.position.y + 1.1, this.position.z);
    const hit = this.world.raycastStatic(this.scratch.hit, EYE, DIR, len, (b) => b.solid && b.surface !== 'glass');
    return !hit.hit;
  }

  private lookAtPoint(x: number, z: number, dt: number, withPitch = false, target?: Zombie, smooth = true): void {
    const desired = Math.atan2(x - this.position.x, z - this.position.z);
    const rate = smooth ? (6 + this.personality.reactionTime * 12) * dt : 999;
    let diff = ((desired - this.aimYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    diff = clamp(diff, -rate, rate);
    this.aimYaw += diff;
    this.facing = this.aimYaw;
    if (withPitch && target) {
      const dy = target.position.y + target.def.height * 0.7 - this.char.eyeY;
      const dist = Math.hypot(target.position.x - this.position.x, target.position.z - this.position.z);
      const desiredPitch = Math.atan2(dy, Math.max(0.5, dist));
      this.aimPitch += clamp(desiredPitch - this.aimPitch, -rate, rate);
    } else {
      this.aimPitch += clamp(0 - this.aimPitch, -rate * 0.4, rate * 0.4);
    }
    // Reaction delay when a *new* target appears.
    if (target && this.currentTarget !== target) {
      this.currentTarget = target;
      this.reactionTimer = this.personality.reactionTime;
    }
  }

  private updatePinned(dt: number): void {
    // Struggle free slowly if nobody comes (keeps the player from soft-locking).
    this.char.update(dt, { dirX: 0, dirZ: 0, speed: 0, canAccelerate: false, jump: false, crouch: false });
    this.actionTimer += dt;
    if (this.actionTimer > 6 && this.pinnedBy) {
      this.actionTimer = 0;
      (this.pinnedBy as unknown as Zombie).release?.();
      this.releasePin('escaped');
    }
  }

  // --- voice ---------------------------------------------------------------

  private updateVoice(dt: number): void {
    void dt;
    if (this.pinnedBy && this.voiceCooldown <= 0) {
      this.speak('grab', 3);
    }
  }

  /** Say something, throttled per cue so the squad does not chatter. */
  speak(line: VoiceCue, cooldown = 4): void {
    if (this.voiceCooldown > 0) return;
    const last = this.lastSpoken.get(line) ?? -99;
    if (this.time - last < cooldown) return;
    this.lastSpoken.set(line, this.time);
    this.voiceCooldown = 1.2;
    const options = VOICE[line];
    const text = Array.isArray(options) ? options[Math.floor(this.brain.next() * options.length)] : String(options);
    bus.emit('survivor:voice', { id: this.id, name: this.name, line: text, duration: 1.6 });
    this.audio.play('survivor_call', { position: this.position, pitch: 0.9 + this.brain.next() * 0.2, volume: 0.5 });
  }

  /** Called by the engine when the Director announces something. */
  announce(kind: 'horde' | 'tank' | 'witch' | 'clear' | 'downed'): void {
    const map = {
      horde: 'horde',
      tank: 'tank',
      witch: 'witch',
      clear: 'clear',
      downed: 'downed',
    } as const satisfies Record<typeof kind, VoiceCue>;
    this.speak(map[kind], 8);
  }

  /** Give ammo from pickups. */
  addAmmo(amount: number): void {
    this.weapons.reserve = Math.min(this.weapons.def.reserveMax, this.weapons.reserve + amount);
  }

  /** Called by pickups so a teammate can upgrade weapons. */
  giveWeapon(id: string): void {
    const def = weaponDef(id);
    if (def.slot !== 'primary') return;
    this.weapons = { def, ammo: def.magazine, reserve: def.spawnAmmo, cooldown: 0, reloading: 0 };
    this.speak('pickupWeapon', 3);
  }

  giveThrowable(count = 1): void {
    this.throwCount = Math.min(3, this.throwCount + count);
  }

  /** EntityIndex view limited to what this AI should shoot. */
  private entityQuery(preferred: Zombie): EntityIndex {
    // Small wrapper: the AI only ever tests the entity it is aiming at.
    const self = this;
    return {
      queryBox(_minX: number, _minY: number, _minZ: number, _maxX: number, _maxY: number, _maxZ: number, out: never[]): void {
        out.length = 0;
        out.push(preferred as never);
        for (const s of self.entities.survivors) {
          if (s !== self) out.push(s as never);
        }
      },
    };
  }
}

const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const TMP3 = new THREE.Vector3();
const TMP4 = new THREE.Vector3();
const DIR = new THREE.Vector3();
const EYE = new THREE.Vector3();
const PATH = new THREE.Vector3();

/** Random cone deviation for AI shots. */
function jitterDirection(dir: THREE.Vector3, degrees: number, rng: Rng, out: THREE.Vector3): THREE.Vector3 {
  const rad = (degrees * Math.PI) / 180;
  const a = rng.next() * Math.PI * 2;
  const r = Math.sqrt(rng.next()) * Math.tan(rad);
  const up = Math.abs(dir.y) > 0.95 ? ALT_UP : UP;
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  const realUp = new THREE.Vector3().crossVectors(right, dir).normalize();
  out.copy(dir);
  out.addScaledVector(right, Math.cos(a) * r);
  out.addScaledVector(realUp, Math.sin(a) * r);
  return out.normalize();
}

const UP = new THREE.Vector3(0, 1, 0);
const ALT_UP = new THREE.Vector3(1, 0, 0);

/** Default squad composition used when a chapter starts without a loadout plan. */
export const DEFAULT_SQUAD_LOADOUT = [
  { primary: 'shotgun_pump', secondary: 'pistol_m9' },
  { primary: 'smg_compact', secondary: 'pistol_m9' },
  { primary: 'sniper_hunting', secondary: 'pistol_m9' },
];

export { SURVIVORS };
export { HEAL_ITEMS };
