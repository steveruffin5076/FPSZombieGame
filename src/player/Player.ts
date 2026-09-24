/**
 * PLAYER
 * ======
 * The player is a `Survivor` with a camera, a keyboard and a weapon.
 *
 * Everything about *being* a survivor — health, temporary health, going down,
 * bleeding out, being pinned, being revived — lives in `Survivor`, which the AI
 * teammates extend as well. That is deliberate: the teammate that revives you is
 * running the same state machine you are, and the friendly-fire path is the same
 * code as the zombie-melee path. Nothing here is special-cased for "the player"
 * except input, the camera and the view model.
 *
 * Responsibilities:
 *   - read input -> movement/aim/actions (and nothing else reads the keyboard)
 *   - own the camera transform (yaw/pitch, recoil, shake, bob, lean)
 *   - run the weapon system and route its damage/impacts into the world
 *   - interact with doors, breakables, pickups, and downed teammates
 *   - feed audio (footsteps, breathing) and the Director (via events)
 */

import * as THREE from 'three';
import { bus } from '@/core/Events';
import { clamp, clamp01, damp } from '@/core/MathUtil';
import { COMBAT } from '@/config/zombies';
import type { DamageOptions } from '@/core/Types';
import type { GameSettings } from '@/core/Settings';
import type { Input } from '@/core/Input';
import type { CollisionScratch, CollisionWorld, MoveResult } from '@/physics/Collision';
import { Survivor } from '@/entities/Survivor';
import type { EntityManager } from '@/entities/EntityManager';
import type { Level } from '@/world/Level';
import type { ItemManager } from '@/world/Items';
import type { WeaponSystem, WeaponHost } from '@/weapons/Weapons';
import type { Effects } from '@/vfx/Effects';
import type { AudioSystem } from '@/audio/Audio';

/** Movement input already resolved from the input device. */
interface MoveState {
  forward: number;
  strafe: number;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
}

const EYE_SCRATCH = new THREE.Vector3();
const DIR_SCRATCH = new THREE.Vector3();

// --- view recoil spring ----------------------------------------------------
// Critically-ish damped (ζ ≈ 0.8): the kick lands instantly and the muzzle walks
// back to the aim point. Kept here rather than in `Player` so the impulse maths
// in `applyRecoil` stays readable.
const RECOIL_STIFF = 190;
const RECOIL_ZETA = 0.8;
/** Hard ceiling on muzzle climb/yaw drift, in radians (~14°). */
const RECOIL_MAX = 0.25;
const CENTRE_SCRATCH = new THREE.Vector3();
const LEAN_SCRATCH = new THREE.Vector2();

export class Player extends Survivor implements WeaponHost {

  /** The render camera. The player owns the transform; the renderer owns the rig. */
  readonly camera: THREE.PerspectiveCamera;

  yaw = 0;
  pitch = 0;
  /** Recoil is a spring: `recoilPitch/Yaw` are offsets applied on top of aim. */
  private recoilPitch = 0;
  private recoilYaw = 0;
  private recoilVelPitch = 0;
  private recoilVelYaw = 0;
  private shake = 0;
  private bob = 0;
  private lean = 0;
  private landingDip = 0;

  weapons: WeaponSystem | null = null;
  /** Interaction target shown in the HUD ("Hold E to revive Rook"). */
  interactPrompt: string | null = null;
  /** Set while the player holds a revivable teammate. */
  private reviving: Survivor | null = null;

  private flashlightOn = false;
  private stepDistance = 0;
  private fallStartY = 0;
  private spreadMove = 0;

  /** Shared raycast scratch (interaction reach checks, pickups). */
  private readonly scratch: CollisionScratch;
  private readonly moveResult: MoveResult;

  constructor(
    id: number,
    world: CollisionWorld,
    camera: THREE.PerspectiveCamera,
    private readonly input: Input,
    private readonly entities: EntityManager,
    private readonly level: Level,
    private readonly items: ItemManager | null,
    private readonly effects: Effects,
    private readonly audio: AudioSystem,
    private readonly settings: GameSettings,
    scratch: CollisionScratch,
  ) {
    super(id, 'You', true, world, null);
    this.camera = camera;
    this.scratch = scratch;
    this.moveResult = this.char.moveResult;
    this.onDamagedFeedback = () => this.onDamaged();
    this.onDowned = () => {
      this.audio.play('downed', { ui: true, volume: 0.85 });
    };
    this.onRevived = () => this.audio.play('revived', { ui: true, volume: 0.7 });
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /** Place the player at a chapter spawn point. */
  /**
   * Last position at which the player stood on solid ground. Used by the void
   * guard below: if anything ever drops the player out of the world (a gap in
   * the level, a bad spawn, a physics glitch) they are put back instead of
   * falling forever.
   */
  private readonly lastSafe = new THREE.Vector3();
  private voidTimer = 0;

  /**
   * Anything below this counts as "out of the world". The generated terrain
   * floor is y = 0 and the deepest basements sit a few metres under it, so the
   * guard is deliberately far below anything reachable on purpose.
   */
  private get voidY(): number {
    return Math.min(-14, this.world.minY - 10);
  }

  spawnAt(x: number, y: number, z: number, yaw: number): void {
    this.reset();
    this.lastSafe.set(x, y, z);
    this.char.teleport(x, y, z);
    this.char.facing = yaw;
    this.yaw = yaw;
    this.pitch = 0;
    this.recoilPitch = this.recoilYaw = 0;
    this.recoilVelPitch = this.recoilVelYaw = 0;
    this.shake = 0;
    this.bob = 0;
    this.applyCamera();
  }

  applySettings(settings: GameSettings): void {
    this.camera.fov = settings.fov;
    this.camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // WeaponHost
  // -------------------------------------------------------------------------

  /**
   * Kick the view. `pitch`/`yaw` arrive in **degrees** (the unit the weapon
   * configs use) and are converted to the off	set the spring settles at:
   * impulse = ω · θ · 1.2, so a 0.6° kick lifts the muzzle about 0.7° and the
   * spring walks it back at `RECOIL_STIFF`. Feeding degrees straight into a
   * radian spring — as this used to — throws the muzzle 20-45° skyward.
   */
  applyRecoil(pitchDeg: number, yawDeg: number): void {
    if (!Number.isFinite(pitchDeg) || !Number.isFinite(yawDeg)) return;
    const toRad = Math.PI / 180;
    const omega = Math.sqrt(RECOIL_STIFF);
    this.recoilVelPitch += pitchDeg * toRad * omega * 1.2;
    this.recoilVelYaw += yawDeg * toRad * omega * 1.2;
    this.recoilPitch = clamp(this.recoilPitch, -RECOIL_MAX, RECOIL_MAX);
    this.recoilYaw = clamp(this.recoilYaw, -RECOIL_MAX, RECOIL_MAX);
  }

  /** Current muzzle climb, in radians on top of `pitch` (used by AI/telemetry). */
  get recoilOffsetPitch(): number {
    return this.recoilPitch;
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  aimOrigin(out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.camera.position);
    // Bullets leave the barrel, not the eye: subtract a little so close-range
    // shots do not clip through the wall the player is leaning on.
    out.addScaledVector(this.aimDirection(DIR_SCRATCH), 0.18);
    return out;
  }

  /**
   * Where the player is aiming, in world space.
   *
   * Convention: yaw 0 faces **+Z** and increases towards +X, matching `facing`
   * on every other character in the game (`atan2(dx, dz)`) and the level
   * generator's route yaw. three.js cameras look down their local -Z, so the
   * camera transform below adds half a turn — see `applyCamera`.
   */
  aimDirection(out: THREE.Vector3): THREE.Vector3 {
    const yaw = this.yaw + this.recoilYaw;
    const pitch = this.pitch + this.recoilPitch;
    const cp = Math.cos(pitch);
    return out.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp).normalize();
  }

  /** Camera eye height, adjusted for crouch, bob and landing dip. */
  private eyeOffset(): number {
    const stand = this.char.crouching ? this.char.eyeHeight * 0.72 : this.char.eyeHeight;
    return stand + this.bob - this.landingDip;
  }

  private applyCamera(): void {
    const bobX = Math.sin(this.bob * 2.6) * this.bob * 0.3;
    const bobY = Math.cos(this.bob * 1.7) * this.bob * 0.22;
    // Bob sway is applied along the player's right-hand axis: (-cos yaw, +sin yaw).
    this.camera.position.set(
      this.position.x - bobX * Math.cos(this.yaw),
      this.position.y + this.eyeOffset() + bobY,
      this.position.z + bobX * Math.sin(this.yaw),
    );
    // The half-turn: three.js cameras look down local -Z, while the game's yaw
    // convention faces +Z. `rotateY` then `rotateX` composes as Ry * Rx, which
    // keeps pitch (the second rotation) signed the way `aimDirection` expects.
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw + Math.PI + this.recoilYaw);
    this.camera.rotateX(this.pitch + this.recoilPitch);
    this.camera.rotateZ(this.lean * 0.06 + (this.incapacitated ? 0.5 : 0));
  }

  // -------------------------------------------------------------------------
  // Per-step update
  // -------------------------------------------------------------------------

  override updateStatus(dt: number): void {
    super.updateStatus(dt);
    if (!this.incapacitated && this.tempHealth <= 0 && this.health < COMBAT.playerMaxHealth * 0.35) {
      // Low health: the renderer desaturates and the heartbeat picks up.
      this.audio.setDeafen(clamp01(1 - this.health / (COMBAT.playerMaxHealth * 0.35)) * 0.25);
    } else {
      this.audio.setDeafen(0);
    }
  }

  /**
   * One simulation step.
   * @param canAct false while the game is in a menu or a scripted moment.
   */
  step(dt: number, canAct: boolean): void {
    const settings = this.settings;

    // --- look ---------------------------------------------------------------
    if (canAct && !this.dead) {
      const look = { x: 0, y: 0 };
      const adsMult = this.weapons?.ads && settings.adsSensitivityMultiplier > 0 ? settings.adsSensitivityMultiplier : 1;
      // `lookDelta` returns radians already scaled by sensitivity/invert-Y.
      this.input.lookDelta(look, adsMult);
      this.yaw -= look.x;
      this.pitch -= look.y;
      this.pitch = clamp(this.pitch, -1.5, 1.5);
      // Mouse wheel weapon switching (wheel delta is per-frame input state).
      const wheel = this.input.wheel;
      if (wheel !== 0 && this.weapons) this.weapons.cycleWeapon(wheel > 0 ? 1 : -1);
    }

    // --- recoil spring ------------------------------------------------------
    // A spring: the kick lands instantly, then the muzzle walks back down to
    // where the player is actually aiming. Both halves of the integrator take
    // `dt` — integrating the acceleration over a full second is an instability,
    // not a spring, and it eventually overflows into NaN recoil.
    //   ζ = damping / (2·√stiff) = 22 / 27.6 ≈ 0.8  (slightly under-damped)
    const damping = 2 * RECOIL_ZETA * Math.sqrt(RECOIL_STIFF);
    this.recoilVelPitch += (-RECOIL_STIFF * this.recoilPitch - damping * this.recoilVelPitch) * dt;
    this.recoilVelYaw += (-RECOIL_STIFF * this.recoilYaw - damping * this.recoilVelYaw) * dt;
    this.recoilPitch = clamp(this.recoilPitch + this.recoilVelPitch * dt, -RECOIL_MAX, RECOIL_MAX);
    this.recoilYaw = clamp(this.recoilYaw + this.recoilVelYaw * dt, -RECOIL_MAX, RECOIL_MAX);
    this.shake = Math.max(0, this.shake - dt * 2.4);
    this.landingDip = damp(this.landingDip, 0, 6, dt);

    // --- void guard ---------------------------------------------------------
    // Falling out of the world is unrecoverable, so treat it as a soft respawn:
    // put the player back on the last solid ground they stood on and charge a
    // little health for the trouble (reads the same as a hard landing).
    if (this.position.y < this.voidY) {
      this.voidTimer += dt;
      if (this.voidTimer > 0.35) {
        this.voidTimer = 0;
        this.char.teleport(this.lastSafe.x, this.lastSafe.y + 0.2, this.lastSafe.z);
        this.char.velocity.set(0, 0, 0);
        this.char.snapToGround(3);
        this.takeDamage(6, { kind: 'crush', hitZone: 'torso' });
        this.speak('Off the edge — back on solid ground.');
      }
    } else {
      this.voidTimer = 0;
      if (this.char.grounded && this.position.y > this.voidY + 1) this.lastSafe.copy(this.position);
    }

    // --- movement -----------------------------------------------------------
    const move = this.readMove(canAct);
    const before = this.char.grounded;
    this.char.update(dt, {
      forward: move.forward,
      strafe: move.strafe,
      yaw: this.yaw,
      sprint: move.sprint,
      crouch: move.crouch,
      jump: move.jump && canAct,
      // Reviving pins you in place: that risk is the point of the mechanic.
      speedMul: this.incapacitated ? 0.45 : this.reviving ? 0.35 : 1,
    });

    // Landing: dip the camera, hurt a little if it was a long way down.
    if (!before && this.char.grounded) {
      const impact = this.char.lastLandingSpeed;
      if (impact > 3) {
        this.landingDip = Math.min(0.18, impact * 0.012) * (this.incapacitated ? 1.6 : 1);
        if (impact > 5.5) this.audio.footstep('concrete', this.position, clamp01(impact / 12));
      }
      const drop = this.fallStartY - this.position.y;
      if (drop > 3.2 && !this.dead) {
        // Fall damage scales with the drop, not the speed, so a stair-step
        // descent can never hurt you but a two-storey drop will.
        const dmg = (drop - 3.2) * 9;
        this.takeDamage(dmg, { kind: 'crush', source: this.position.clone().setY(this.position.y + 1) });
        this.addShake(clamp01(dmg / 40));
      }
    }
    if (this.char.grounded) this.fallStartY = this.position.y;

    // --- view bob + footsteps ----------------------------------------------
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const bobTarget = this.char.grounded ? clamp01(speed / 5) * 0.055 : 0.012;
    this.bob = damp(this.bob, bobTarget, 8, dt);
    this.spreadMove = damp(this.spreadMove, clamp01(speed / 5.4), 8, dt);

    if (this.char.grounded && speed > 0.6) {
      const phase = this.char.stepPhase;
      // Each step fires when the sine crosses zero going forward.
      const prev = this.stepDistance;
      this.stepDistance = phase;
      if (prev > phase) {
        const surface = this.surfaceUnderFeet();
        this.audio.footstep(surface, this.position, this.char.crouching ? 0.28 : move.sprint ? 0.75 : 0.5);
        if (move.sprint) this.audio.emitNoise(this.position, 12, 'footstep');
      }
    }

    // --- weapons ------------------------------------------------------------
    this.weapons?.update(dt, {
      fire: canAct && !this.incapacitated && this.input.action('fire'),
      firePressed: canAct && this.input.actionPressed('fire'),
      ads: canAct && this.input.action('ads'),
      reload: canAct && this.input.actionPressed('reload'),
      use: canAct && this.input.action('use'),
      lean: LEAN_SCRATCH.set(this.leanAmount(), this.char.grounded ? 0 : 0.35),
    });
    if (canAct) this.updateSwitching();

    // --- interaction --------------------------------------------------------
    this.updateInteraction(dt, canAct);

    // --- aim-down-sights lean ----------------------------------------------
    const strafeLean = -move.strafe * clamp01(speed / 4) * (this.weapons?.ads ? 0.4 : 1);
    this.lean = damp(this.lean, strafeLean + this.shake * (Math.random() - 0.5) * 0.12, 9, dt);

    this.centre.set(this.position.x, this.position.y + this.char.capsuleHeight * 0.62, this.position.z);
    this.applyCamera();
  }

  private leanAmount(): number {
    return this.lean;
  }

  private readMove(canAct: boolean): MoveState {
    if (!canAct || this.dead || this.incapacitated) {
      return { forward: 0, strafe: 0, sprint: false, crouch: false, jump: false };
    }
    const forward = (this.input.action('forward') ? 1 : 0) - (this.input.action('back') ? 1 : 0);
    const strafe = (this.input.action('right') ? 1 : 0) - (this.input.action('left') ? 1 : 0);
    // Sprinting is only allowed forward-ish and never while aiming.
    const sprinting = this.input.action('sprint') && forward > 0 && !(this.weapons?.ads ?? false) && !this.incapacitated;
    return {
      forward,
      strafe,
      sprint: sprinting,
      crouch: this.input.action('crouch'),
      jump: this.input.actionPressed('jump'),
    };
  }

  private updateSwitching(): void {
    const input = this.input;
    if (input.actionPressed('prevWeapon')) this.weapons?.cycleWeapon(-1);
    if (input.actionPressed('nextWeapon')) this.weapons?.cycleWeapon(1);
    if (input.pressed('Digit1')) this.weapons?.equip('primary');
    if (input.pressed('Digit2')) this.weapons?.equip('secondary');
    if (input.pressed('Digit3')) this.weapons?.equip('melee');
    if (input.pressed('Digit4')) this.weapons?.equip('throwable');
    if (input.actionPressed('melee')) this.weapons?.meleeAttack();
    if (input.actionPressed('heal')) this.weapons?.useHeal();
    if (input.actionPressed('flashlight')) {
      this.flashlightOn = !this.flashlightOn;
      this.audio.play('ui_click', { ui: true, volume: 0.4, pitch: this.flashlightOn ? 1.1 : 0.9 });
    }
    if (input.action('throw')) {
      this.weapons?.throwStart();
    } else if (this.weapons) {
      this.weapons.throwRelease(input.actionPressed('throw') ? 0 : 1);
    }
  }

  /**
   * Interact key: doors, breakables and loot are contextual — the nearest valid
   * thing wins, and downed teammates always take priority over loot (that is the
   * difference between a wipe and a story).
   */
  private updateInteraction(dt: number, canAct: boolean): void {
    this.interactPrompt = null;
    if (!canAct || this.dead) {
      this.reviving = null;
      return;
    }

    // --- revive a teammate --------------------------------------------------
    const downed = this.findRevivable();
    if (downed) {
      if (this.input.action('use')) {
        this.reviving = downed;
        const progress = downed.tickRevive(dt, this);
        this.interactPrompt = `REVIVING ${downed.name.toUpperCase()}  ${Math.round(progress * 100)}%`;
        this.audio.emitNoise(this.position, 6, 'voice');
        if (progress >= 1) {
          this.reviving = null;
          this.audio.play('revived', { position: this.position, volume: 0.6 });
        }
        return;
      }
      this.reviving = null;
      this.interactPrompt = `HOLD [E]  REVIVE ${downed.name.toUpperCase()}`;
      return;
    }

    // --- doors --------------------------------------------------------------
    const door = this.level.nearestDoor(this.position.x, this.position.y, this.position.z, 2.6);
    if (door) {
      if (door.locked) {
        this.interactPrompt = 'LOCKED — FIND ANOTHER WAY';
      } else {
        this.interactPrompt = `${door.open ? 'CLOSE' : 'OPEN'} DOOR  [E]`;
        if (this.input.actionPressed('use')) {
          this.level.setDoorOpen(door.id, !door.open, 'player');
        }
      }
      return;
    }

    // --- loot ---------------------------------------------------------------
    // Reachability check: loot behind a wall is not "in front of you".
    DIR_SCRATCH.copy(this.aimDirection(DIR_SCRATCH));
    const reachBlocked = this.world.raycastStatic(
      this.scratch.hit,
      this.camera.position,
      DIR_SCRATCH,
      1.4,
      'movement',
    ).hit;
    if (this.items && !reachBlocked) {
      const pickup = this.items.query(this.position.x, this.position.y + 1, this.position.z, 2.0);
      if (pickup && !pickup.taken) {
        const prompt = this.items.promptFor(pickup);
        this.interactPrompt = `${prompt}  [E]`;
        if (this.input.actionPressed('use') && this.weapons) {
          this.items.tryPickup(pickup, this.weapons, this, this.input.action('use'));
        }
        return;
      }
    }

    // --- breakables ---------------------------------------------------------
    const breakable = this.level.breakableAt(this.position.x, this.position.y, this.position.z, 2.2);
    if (breakable && !breakable.broken) {
      this.interactPrompt = 'MELEE TO SMASH  [F]';
    }
  }

  private findRevivable(): Survivor | null {
    let best: Survivor | null = null;
    let bestD = 2.4;
    for (const s of this.entities.survivors) {
      if (s === this || s.dead || !s.incapacitated) continue;
      const d = Math.hypot(s.position.x - this.position.x, s.position.z - this.position.z);
      if (d < bestD) {
        bestD = d;
        best = s as Survivor;
      }
    }
    return best;
  }

  /** The surface the player is standing on (footstep + landing sounds). */
  surfaceUnderFeet(): string {
    const out = { floorSurface: undefined as string | undefined };
    this.world.groundAt(this.position.x, this.position.z, this.position.y + 0.4, 0.8, out as never);
    return out.floorSurface ?? 'concrete';
  }

  get flashlight(): boolean {
    return this.flashlightOn;
  }

  /** Movement speed as a fraction of sprint speed — feeds weapon sway/spread. */
  get moveSpread(): number {
    return this.spreadMove;
  }

  /** True while the player is holding a revive. The HUD shows a progress ring. */
  get isReviving(): boolean {
    return this.reviving !== null;
  }

  /** Result of the last character move (contacts, blocking) for debug readouts. */
  get lastMove(): MoveResult {
    return this.moveResult;
  }

  /** Damage entry point: routes feedback into the renderer/audio and the HUD. */
  override takeDamage(amount: number, opts: DamageOptions): void {
    if (this.dead || amount <= 0) return;
    const before = this.health;
    super.takeDamage(amount, opts);
    const taken = Math.max(0, before - this.health);
    if (taken > 0) {
      this.audio.play(taken > 18 ? 'hurt_heavy' : 'hurt_light', { ui: true, volume: clamp01(taken / 30) });
      this.addShake(clamp01(taken / 25) * 0.5);
    }
  }

  private onDamaged(): void {
    // A short spray toward the camera reads as "you are bleeding" without
    // occluding the screen the way a full-screen red flash would.
    this.effects.bloodSpray(this.position.x, this.position.y + 1.35, this.position.z, 0, 0.5, 0, 0.35);
    this.audio.impactFlesh(this.position, false);
  }

  /** The weapon the player is holding (HUD + pickups). */
  get currentWeaponName(): string {
    return this.weapons?.active?.def.name ?? 'unarmed';
  }

  /** Movement state passthroughs (part of the WeaponHost contract). */
  get grounded(): boolean {
    return this.char.grounded;
  }

  get crouching(): boolean {
    return this.char.crouching;
  }

  /** Zombie variants the player can see, for the HUD threat strip. */
  visibleThreatCount(): number {
    const dir = this.aimDirection(DIR_SCRATCH);
    let count = 0;
    for (const z of this.entities.zombies) {
      if (!z.alive) continue;
      if (z.position.distanceToSquared(this.position) > 2500) continue;
      CENTRE_SCRATCH.subVectors(z.centre, this.camera.position).normalize();
      if (CENTRE_SCRATCH.dot(dir) > 0.2) count++;
    }
    return count;
  }

  /** Chapter reset: full health, weapons restocked by the safe room. */
  reset(): void {
    this.health = this.maxHealth;
    this.tempHealth = 0;
    this.incapacitated = false;
    this.dead = false;
    this.pinnedBy = null;
    this.isBeingRevived = false;
    this.reviveProgress = 0;
    this.bleedOut = COMBAT.bleedOutTime;
    this.invulnerable = COMBAT.spawnProtectionTime;
    this.causeOfDeath = '';
    this.velocity.set(0, 0, 0);
  }

  /** Respawn after a death screen: back on the route with the squad. */
  respawnAtSquad(lead: THREE.Vector3, yaw: number): void {
    this.reset();
    this.char.teleport(lead.x, lead.y + 0.2, lead.z);
    this.char.snapToGround(3);
    this.yaw = yaw;
    this.applyCamera();
  }

  /** Pitch/yaw for the death camera (looks at whoever killed you). */
  lookAt(x: number, y: number, z: number): void {
    const dx = x - this.camera.position.x;
    const dy = y - this.camera.position.y;
    const dz = z - this.camera.position.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.applyCamera();
  }

  speak(line: string, duration = 1.6): void {
    bus.emit('survivor:voice', { id: this.id, name: this.name, line, duration });
  }

  /** Called by the engine when a chapter ends so the view settles. */
  setInputSuppressed(): void {
    this.reviving = null;
  }

  get eyePosition(): THREE.Vector3 {
    return EYE_SCRATCH.copy(this.camera.position);
  }

  /** Speed multiplier while limping / downed — used by the Director's mercy read. */
  get wounded(): boolean {
    return this.health < this.maxHealth * 0.35 || this.incapacitated;
  }
}


