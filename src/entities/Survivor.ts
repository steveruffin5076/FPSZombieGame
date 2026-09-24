/**
 * SURVIVOR (shared base for the player and AI teammates)
 * ======================================================
 * Implements the L4D-style health model that gives the game its tension curve:
 *
 *   - **Health** (0-100): permanent, only a medkit restores it.
 *   - **Temporary health**: pills/adrenaline take you above the cap, then decay.
 *   - **Incapacitation**: at 0 HP you go down with a pistol and a bleed-out
 *     timer; a teammate can revive you, otherwise you die.
 *   - **Pinning**: specials don't just damage you, they remove your agency —
 *     which is what makes Teammates matter.
 *
 * The player and the AI teammates share every rule in this file; only input and
 * decision-making differ. That is deliberate: it makes the AI feel like peers
 * and makes the eventual co-op multiplayer swap-in far less invasive.
 */
import * as THREE from 'three';
import { bus } from '@/core/Events';
import { clamp, damp } from '@/core/MathUtil';
import type { Damageable, DamageOptions, HitZone } from '@/core/Types';
import { Character } from '@/physics/Character';
import type { CollisionWorld } from '@/physics/Collision';
import { COMBAT, type PersonalityDef } from '@/config/zombies';
import type { SurvivorEntity, ZTarget } from '@/entities/Types';

export type SurvivorPinKind = 'pounce' | 'tongue' | 'ride';

export abstract class Survivor implements SurvivorEntity {
  readonly id: number;
  readonly name: string;
  readonly isPlayer: boolean;
  readonly isZombie = false;
  readonly isSurvivor = true;
  readonly personality: PersonalityDef | null;
  readonly char: Character;
  /** Collision world this survivor moves in (shared with the AI). */
  readonly world: CollisionWorld;
  readonly position: THREE.Vector3;
  readonly centre = new THREE.Vector3();
  readonly velocity: THREE.Vector3;

  maxHealth = COMBAT.playerMaxHealth;
  health = COMBAT.playerMaxHealth;
  tempHealth = 0;
  incapacitated = false;
  dead = false;
  /** Reason the survivor died (for the death screen). */
  causeOfDeath = '';
  pinnedBy: ZTarget | null = null;
  pinKind: SurvivorPinKind | null = null;
  isBeingRevived = false;
  reviveProgress = 0;
  /** Seconds of invulnerability (spawn protection / post-revive). */
  invulnerable = COMBAT.spawnProtectionTime;
  /** Bleed-out countdown once incapacitated. */
  bleedOut = COMBAT.bleedOutTime;
  /** Navigation flow field slot assigned by the entity manager. */
  flowSlot = 0;
  /** Set by the AI: true while intentionally sprinting. */
  sprinting = false;
  /** AI-steered override (Jockey riding / Smoker dragging). */
  readonly externalSteer = new THREE.Vector2();
  /** Facing yaw (used by AI survivors; the player uses the camera). */
  facing = 0;
  /** Voice-line cooldown bookkeeping. */
  voiceCooldown = 0;
  /** Statistics. */
  readonly stats = { damageTaken: 0, damageDealt: 0, revives: 0, kills: 0, shots: 0, hits: 0 };
  /** Temporary-health decay bookkeeping. */
  private tempDecayDelay = 0;
  private tempDecayRate = 0;
  private pinDamageTimer = 0;
  private reviveHoldTimer = 0;
  private lastDamageTime = -99;
  protected time = 0;
  /** Screen-shake / feedback hook for the subclass. */
  onDamagedFeedback: ((amount: number, source: THREE.Vector3 | undefined) => void) | null = null;
  onDowned: ((attacker: ZTarget | null) => void) | null = null;
  onDeath: ((attacker: ZTarget | null) => void) | null = null;
  onRevived: (() => void) | null = null;
  onPinned: ((z: ZTarget, kind: SurvivorPinKind) => void) | null = null;
  onUnpinned: ((rescued: boolean) => void) | null = null;

  constructor(
    id: number,
    name: string,
    isPlayer: boolean,
    world: CollisionWorld,
    personality: PersonalityDef | null = null,
  ) {
    this.id = id;
    this.name = name;
    this.isPlayer = isPlayer;
    this.personality = personality;
    this.world = world;
    this.char = new Character(world, { radius: 0.34, height: 1.78, eyeHeight: 1.62 });
    this.position = this.char.position;
    this.velocity = this.char.velocity;
  }

  // --- interface -----------------------------------------------------------

  get alive(): boolean {
    return !this.dead;
  }

  get zoneMultipliers(): Partial<Record<HitZone, number>> {
    return { head: 2.2, torso: 1, limb: 0.8 };
  }

  get healthFraction(): number {
    return clamp(this.health / this.maxHealth, 0, 1);
  }

  /** Total effective HP including temporary health. */
  get totalHealth(): number {
    return this.health + this.tempHealth;
  }

  get healthState(): 'fine' | 'hurt' | 'bad' | 'critical' | 'down' | 'dead' {
    if (this.dead) return 'dead';
    if (this.incapacitated) return 'down';
    const f = this.healthFraction;
    if (f > 0.75) return 'fine';
    if (f > 0.5) return 'hurt';
    if (f > 0.25) return 'bad';
    return 'critical';
  }

  // --- damage --------------------------------------------------------------

  takeDamage(amount: number, opts: DamageOptions): void {
    if (this.dead) return;
    if (this.invulnerable > 0) return;
    // Already pinned: pin damage keeps ticking but melee cannot stack freely.
    const dmg = Math.max(0, amount);
    if (dmg <= 0) return;
    this.stats.damageTaken += dmg;
    this.lastDamageTime = this.time;

    // Temporary health absorbs damage first (L4D pill mechanic).
    let remaining = dmg;
    if (this.tempHealth > 0) {
      const absorbed = Math.min(this.tempHealth, remaining);
      this.tempHealth -= absorbed;
      remaining -= absorbed;
      // Taking damage resets the decay delay so pills feel protective.
      this.tempDecayDelay = 2;
    }
    this.health = Math.max(0, this.health - remaining);
    this.onDamagedFeedback?.(dmg, opts.source);
    bus.emit('survivor:damaged', { id: this.id, name: this.name, health: this.health });
    if (this.isPlayer) {
      bus.emit('player:damaged', {
        amount: dmg,
        health: this.health,
        source: opts.kind,
        direction: opts.source ? Math.atan2(opts.source.x - this.position.x, opts.source.z - this.position.z) : 0,
      });
    }

    if (this.health <= 0 && !this.incapacitated) {
      this.goDown(opts.attacker as ZTarget | null);
    }
  }

  heal(amount: number): number {
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    bus.emit('player:healed', { amount: this.health - before, health: this.health });
    return this.health - before;
  }

  /** Pills / adrenaline: temporary health above the cap. */
  giveTempHealth(amount: number, decayPerSec: number, delay: number): void {
    this.tempHealth = Math.min(COMBAT.tempHealthMax, this.tempHealth + amount);
    this.tempDecayRate = decayPerSec;
    this.tempDecayDelay = delay;
    bus.emit('player:pill', { health: this.totalHealth });
  }

  private goDown(attacker: ZTarget | null): void {
    if (this.incapacitated) return;
    this.incapacitated = true;
    this.bleedOut = COMBAT.bleedOutTime;
    this.health = 0;
    this.tempHealth = 0;
    this.onDowned?.(attacker);
    if (this.pinnedBy) this.releasePin('died');
    bus.emit('survivor:incapacitated', { id: this.id, name: this.name });
    if (this.isPlayer) bus.emit('player:incapacitated', {});
  }

  /** Incapacitated survivors die when their bleed-out timer expires. */
  private die(attacker: ZTarget | null, cause: string): void {
    if (this.dead) return;
    this.dead = true;
    this.incapacitated = false;
    this.causeOfDeath = cause;
    if (this.pinnedBy) this.releasePin('died');
    this.onDeath?.(attacker);
    bus.emit('survivor:died', { id: this.id, name: this.name });
    if (this.isPlayer) bus.emit('player:died', { cause });
  }

  /** Instant kill used by the Director for permadeath and scripted moments. */
  kill(cause = 'unknown'): void {
    if (this.dead) return;
    this.health = 0;
    this.tempHealth = 0;
    this.incapacitated = false;
    this.die(null, cause);
  }

  /** Revive an incapacitated survivor (called by a teammate or the player). */
  revive(health = COMBAT.reviveHealth): void {
    if (!this.incapacitated || this.dead) return;
    this.incapacitated = false;
    this.health = health;
    this.tempHealth = 0;
    this.invulnerable = COMBAT.spawnProtectionTime;
    this.reviveProgress = 0;
    this.isBeingRevived = false;
    // Whoever revived them is credited.
    const reviver = this.lastReviver;
    if (reviver) reviver.stats.revives++;
    this.onRevived?.();
    bus.emit('survivor:revived', { id: this.id, name: this.name });
    if (this.isPlayer) bus.emit('player:revived', {});
    this.lastReviver = null;
  }

  /** The survivor currently performing a revive on this one. */
  lastReviver: Survivor | null = null;

  /**
   * Advance a revive attempt. Teammates and the player call this while holding
   * the revive action; progress resets if they stop.
   */
  tickRevive(dt: number, reviver: Survivor): number {
    if (!this.incapacitated || this.dead) return 1;
    this.isBeingRevived = true;
    this.lastReviver = reviver;
    // Hold-to-revive: the first 0.25 s ramps in so a tapped key cannot cheese
    // the revive, and the hold timer resets whenever the attempt is broken.
    this.reviveHoldTimer += dt;
    const ramp = Math.min(1, this.reviveHoldTimer / 0.25);
    this.reviveProgress += (dt / COMBAT.reviveTime) * ramp;
    bus.emit('survivor:reviveProgress', { id: this.id, progress: this.reviveProgress });
    if (this.reviveProgress >= 1) {
      this.revive();
      return 1;
    }
    return this.reviveProgress;
  }

  resetReviveProgress(): void {
    this.reviveHoldTimer = 0;
    if (this.reviveProgress > 0 && this.incapacitated) {
      this.reviveProgress = Math.max(0, this.reviveProgress - 0.6);
    }
    this.isBeingRevived = false;
  }

  // --- pinning (special infected) -----------------------------------------

  pinBy(attacker: ZTarget, kind: SurvivorPinKind): void {
    if (this.dead) return;
    this.pinnedBy = attacker;
    this.pinKind = kind;
    // Being grabbed interrupts whatever you were doing.
    this.isBeingRevived = false;
    this.reviveProgress = 0;
    if (kind === 'tongue') {
      // Smokers drag you away from the group.
      this.incapacitated = false;
    }
    if (kind === 'ride') {
      this.incapacitated = false;
    }
    this.onPinned?.(attacker, kind);
    bus.emit('special:attack', { variant: attacker.variant, target: this.name });
  }

  releasePin(reason: 'rescued' | 'killed' | 'died' | 'escaped'): void {
    if (!this.pinnedBy) return;
    const wasPinner = this.pinnedBy;
    this.pinnedBy = null;
    this.pinKind = null;
    this.externalSteer.set(0, 0);
    this.onUnpinned?.(reason === 'rescued');
    bus.emit('survivor:revived', { id: this.id, name: this.name });
    void wasPinner;
  }

  /** True while a special infected has removed this survivor's agency. */
  get isHelpless(): boolean {
    return this.pinnedBy !== null || this.dead;
  }

  /** Pinned survivors take continuous damage from their captor. */
  private updatePin(dt: number): void {
    if (!this.pinnedBy) return;
    this.pinDamageTimer -= dt;
    if (this.pinnedBy.state === 'dead') {
      this.releasePin('killed');
      return;
    }
    // Pinned survivors are slowly drained; the real threat is the bleed-out.
    if (this.pinDamageTimer <= 0) {
      this.pinDamageTimer = 1;
      const dmg = this.pinKind === 'tongue' ? 7 : 9;
      this.health = Math.max(0, this.health - dmg);
      this.onDamagedFeedback?.(dmg, undefined);
      if (this.health <= 0 && !this.incapacitated) this.goDown(this.pinnedBy);
    }
  }

  // --- impulses ------------------------------------------------------------

  knockback(dir: THREE.Vector3, force: number): void {
    this.char.velocity.addScaledVector(dir, force);
    this.char.grounded = false;
  }

  /** Pulled toward a position (Smoker tongue). */
  dragTo(x: number, z: number, dt: number): void {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) return;
    const pull = Math.min(6, d * 1.4);
    this.char.position.x += (dx / d) * pull * dt;
    this.char.position.z += (dz / d) * pull * dt;
  }

  /** Jockey steering intent. */
  steerTo(x: number, z: number): void {
    this.externalSteer.set(x, z);
  }

  // --- per-frame housekeeping ---------------------------------------------

  updateStatus(dt: number): void {
    this.time += dt;
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.voiceCooldown = Math.max(0, this.voiceCooldown - dt);

    // Temporary health decay.
    if (this.tempHealth > 0) {
      if (this.tempDecayDelay > 0) {
        this.tempDecayDelay -= dt;
      } else {
        this.tempHealth = Math.max(0, this.tempHealth - this.tempDecayRate * dt);
      }
    }

    if (this.incapacitated) {
      this.bleedOut -= dt;
      if (!this.isBeingRevived) this.resetReviveProgress();
      if (this.bleedOut <= 0) this.die(null, 'bleed out');
    }
    this.updatePin(dt);

    this.centre.set(this.position.x, this.position.y + 0.95, this.position.z);
  }

  /** Seconds since this survivor last took damage (AI + Director use this). */
  get secondsSinceDamage(): number {
    return this.time - this.lastDamageTime;
  }

  /** Am I currently safe (no infected within a small radius)? */
  isThreatened(nearestThreatDistance: number): boolean {
    return nearestThreatDistance < 6;
  }

  /** Debug/UI helper: how hurt does this survivor look (0..1)? */
  get hurtAmount(): number {
    return clamp(1 - (this.health + this.tempHealth * 0.5) / this.maxHealth, 0, 1);
  }

  /** Smoothly interpolated facing for AI survivors. */
  faceTowards(x: number, z: number, dt: number, rate = 8): void {
    const desired = Math.atan2(x - this.position.x, z - this.position.z);
    let diff = ((desired - this.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    diff = clamp(diff, -rate * dt, rate * dt);
    this.facing += diff;
  }

  /** Set by subclasses: where is this survivor looking/firing from? */
  abstract aimOrigin(out: THREE.Vector3): THREE.Vector3;
  abstract aimDirection(out: THREE.Vector3): THREE.Vector3;

  /** Fade a value toward a target (small helper used by HUD/AI). */
  protected approach(current: number, target: number, rate: number, dt: number): number {
    return damp(current, target, rate, dt);
  }
}

export type { Damageable, DamageOptions };
