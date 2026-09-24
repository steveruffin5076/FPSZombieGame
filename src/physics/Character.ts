/**
 * CHARACTER CONTROLLER
 * ====================
 * Shared movement for the player and every simulated survivor. The infected use
 * the same integrator through their own `ZombieMotor` so that AI and players
 * obey identical physics — which is the difference between "the AI cheats" and
 * "the AI is a person".
 *
 * Model
 * -----
 *   - Velocity-based with explicit friction, so stopping is crisp.
 *   - Ground acceleration is capped at the max speed, which removes the
 *     Quake-style air-strafe exploit while keeping air control useful.
 *   - Gravity with a terminal velocity clamp and a small "coyote time" so
 *     climbing stairs and walking off kerbs does not stutter.
 *   - Crouch changes the capsule height; standing up is refused when a ceiling
 *     is in the way (no clipping through floors).
 *   - `stepHeight` allows kerbs and stairs to be walked up without a jump.
 */
import * as THREE from 'three';
import type { SurfaceType } from '@/core/Types';
import { CollisionWorld, makeMoveResult, type MoveResult } from '@/physics/Collision';

export interface CharacterOptions {
  radius?: number;
  height?: number;
  crouchHeight?: number;
  eyeHeight?: number;
  /** Max walking speed (m/s). */
  walkSpeed?: number;
  crouchSpeed?: number;
  sprintSpeed?: number;
  /** Jump impulse (m/s). */
  jumpSpeed?: number;
  gravity?: number;
  stepHeight?: number;
  /** Multiplier applied to all speeds (zombies, limping survivors...). */
  speedScale?: number;
  /** Can this character jump? */
  canJump?: boolean;
}

export interface MoveInput {
  /**
   * Movement in the local frame: `forward`/`strafe` are -1..1 and `yaw` is the
   * direction they are relative to. All three are optional because AI callers
   * pass a world-space `dirX`/`dirZ` instead.
   */
  forward?: number;
  strafe?: number;
  yaw?: number;
  /** Is the character sprinting (uses sprintSpeed)? */
  sprint?: boolean;
  crouch?: boolean;
  jump?: boolean;
  /** Speed multiplier from status effects (adrenaline, limp, etc). */
  speedMul?: number;
  /** Override for the max speed of this step (used by special infected). */
  speedOverride?: number;
  /** Alias for `speedOverride` (the AI passes `speed`). */
  speed?: number;
  /**
   * When false the character does not accelerate along the wish direction:
   * friction and impulses still apply, but it will not drive itself forward.
   * Used for stagger/recovery states.
   */
  canAccelerate?: boolean;
  /** When true, the character keeps its current velocity and gravity only. */
  ballistic?: boolean;
  /**
   * World-space direction. When supplied it replaces `forward`/`strafe`/`yaw`
   * — this is what the AI uses, since a zombie steering toward a target has a
   * direction but no yaw-relative input frame.
   */
  dirX?: number;
  dirZ?: number;
}

export class Character {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly world: CollisionWorld;
  radius: number;
  height: number;
  crouchHeight: number;
  eyeHeight: number;
  walkSpeed: number;
  crouchSpeed: number;
  sprintSpeed: number;
  jumpSpeed: number;
  gravity: number;
  stepHeight: number;
  speedScale: number;
  canJump: boolean;
  /** True while a jump is held (prevents auto-bhop). */
  jumpHeld = false;
  /** Feet are touching something walkable. */
  grounded = false;
  /** Y of the ground under us (-Infinity over the void). */
  floorY = -Infinity;
  ceilingY = Infinity;
  floorSurface: SurfaceType = 'concrete';
  crouching = false;
  /** Secretly reduce the capsule for a frame (crawling infected). */
  forceCrouch = false;
  /** Set by the controller; read by animation and audio. */
  airTime = 0;
  lastLandingSpeed = 0;
  /** Sub-stepping budget so long frames do not tunnel through walls. */
  maxSubstep = 0.3;
  /** External velocity added by explosions/knockback decays over time. */
  readonly impulse = new THREE.Vector3();
  /** Speed modifier applied on top of everything (adrenaline, limping). */
  speedMultiplier = 1;
  /** Facing yaw used by AI (the player uses the camera yaw instead). */
  facing = 0;
  /** Ticks a "footstep" flag when the walk cycle crosses a threshold. */
  lastStepPhase = 0;
  stepPhase = 0;
  /** Yaw of the surface we are standing on (stairs alignment). */
  groundYaw = 0;
  /** True for the frame in which a landing occurred. */
  justLanded = false;
  /** True while the character is on a slope/stair (used for smoothing). */
  onStairs = false;
  /** Set by the owner each frame to disable gravity (pounce arcs, cutscenes). */
  gravityEnabled = true;
  /** Internal result object reused every move. */
  private result: MoveResult = makeMoveResult();
  /** Head bob accumulator (the camera reads this). */
  bobTime = 0;

  constructor(world: CollisionWorld, opts: CharacterOptions = {}) {
    this.world = world;
    this.radius = opts.radius ?? 0.35;
    this.height = opts.height ?? 1.78;
    this.crouchHeight = opts.crouchHeight ?? 1.15;
    this.eyeHeight = opts.eyeHeight ?? 1.62;
    this.walkSpeed = opts.walkSpeed ?? 3.9;
    this.crouchSpeed = opts.crouchSpeed ?? 1.75;
    this.sprintSpeed = opts.sprintSpeed ?? 5.4;
    this.jumpSpeed = opts.jumpSpeed ?? 5.0;
    this.gravity = opts.gravity ?? 21;
    this.stepHeight = opts.stepHeight ?? 0.42;
    this.speedScale = opts.speedScale ?? 1;
    this.canJump = opts.canJump ?? true;
  }

  get eyeY(): number {
    return this.position.y + (this.crouching ? this.eyeHeight * 0.72 : this.eyeHeight);
  }

  /** Current capsule height (crouch aware). */
  get capsuleHeight(): number {
    return this.crouching || this.forceCrouch ? this.crouchHeight : this.height;
  }

  /** The result of the last move (ground flags, contacts). */
  get moveResult(): MoveResult {
    return this.result;
  }

  /** Teleport without collision resolution (spawns, revives, debug). */
  teleport(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.airTime = 0;
  }

  /** Snap to the nearest walkable floor below the current position. */
  snapToGround(maxDrop = 4): boolean {
    const floor = this.world.walkableSurfaceAt(this.position.x, this.position.y + 0.35, this.position.z, this.capsuleHeight * 0.9, maxDrop);
    if (!isFinite(floor)) return false;
    this.position.y = floor;
    this.velocity.y = 0;
    this.grounded = true;
    this.floorY = floor;
    return true;
  }

  addImpulse(x: number, y: number, z: number): void {
    this.impulse.x += x;
    this.impulse.y += y;
    this.impulse.z += z;
    if (Math.abs(y) > 0.5) {
      this.grounded = false;
      this.airTime = 0.12;
    }
  }

  /**
   * Integrate one frame.
   * Returns the distance travelled horizontally (useful for footsteps/AI).
   */
  update(dt: number, input: MoveInput): number {
    if (dt <= 0) return 0;
    this.justLanded = false;
    const wasGrounded = this.grounded;

    // --- crouch state ------------------------------------------------------
    const wantsCrouch = input.crouch || this.forceCrouch;
    if (wantsCrouch) {
      this.crouching = true;
    } else if (this.crouching) {
      // Only stand if there is room.
      if (this.world.canStand(this.position.x, this.position.y, this.position.z, this.height, this.radius * 1.02)) {
        this.crouching = false;
      }
    }

    // --- desired horizontal velocity ---------------------------------------
    let wishX: number;
    let wishZ: number;
    if (input.dirX !== undefined || input.dirZ !== undefined) {
      // World-space direction (AI).
      wishX = input.dirX ?? 0;
      wishZ = input.dirZ ?? 0;
    } else {
      const cos = Math.cos(input.yaw ?? 0);
      const sin = Math.sin(input.yaw ?? 0);
      // MoveInput is (forward, strafe) in local space, and the project's single
      // orientation convention is "yaw 0 looks down +Z" (see `facing` in
      // TeammateAI/Zombie and `root.rotation.y = facing` in render/Characters).
      // Right is therefore forward x up = (-cos yaw, 0, +sin yaw): the *minus*
      // on strafe is what keeps `D` moving to the player's right on screen.
      wishX = (input.forward ?? 0) * sin - (input.strafe ?? 0) * cos;
      wishZ = (input.forward ?? 0) * cos + (input.strafe ?? 0) * sin;
    }
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1e-5) {
      wishX /= wishLen;
      wishZ /= wishLen;
    }

    const baseSpeed =
      input.speedOverride ??
      input.speed ??
      (this.crouching ? this.crouchSpeed : input.sprint ? this.sprintSpeed : this.walkSpeed);
    const maxSpeed = baseSpeed * this.speedScale * this.speedMultiplier * (input.speedMul ?? 1);

    // --- acceleration ------------------------------------------------------
    const accel = this.grounded ? 62 : 14;
    const friction = this.grounded ? 12 : 0.6;
    if (!input.ballistic) {
      if (!this.grounded && friction > 0) {
        // Air drag: keeps air control useful but bounded.
        const drag = Math.max(0, 1 - friction * dt);
        this.velocity.x *= drag;
        this.velocity.z *= drag;
      } else if (this.grounded) {
        const speed = Math.hypot(this.velocity.x, this.velocity.z);
        if (speed > 0.01 && wishLen > 1e-5) {
          // Ground friction, but never below the speed we are trying to reach.
          const drop = Math.max(0, speed - maxSpeed) + speed * friction * dt;
          const scale = Math.max(0, speed - drop) / speed;
          this.velocity.x *= scale;
          this.velocity.z *= scale;
        } else if (speed > 0.01) {
          const drop = speed * friction * dt;
          const scale = Math.max(0, speed - drop) / speed;
          this.velocity.x *= scale;
          this.velocity.z *= scale;
        }
      }
      // Add acceleration along the wish direction, capped at max speed.
      if (wishLen > 1e-5 && input.canAccelerate !== false) {
        const current = this.velocity.x * wishX + this.velocity.z * wishZ;
        const add = maxSpeed - current;
        if (add > 0) {
          const applied = Math.min(add, accel * dt * Math.max(0.35, 1 - current / Math.max(0.5, maxSpeed)));
          this.velocity.x += wishX * applied;
          this.velocity.z += wishZ * applied;
        }
      }
    }

    // --- jump / gravity ----------------------------------------------------
    const jumpWanted = input.jump && this.canJump && this.grounded && !this.jumpHeld;
    if (jumpWanted) {
      this.velocity.y = this.jumpSpeed;
      this.grounded = false;
      this.jumpHeld = true;
    }
    if (!input.jump) this.jumpHeld = false;

    if (this.gravityEnabled && !this.grounded) {
      this.velocity.y -= this.gravity * dt;
      if (this.velocity.y < -55) this.velocity.y = -55;
    } else if (this.grounded && this.velocity.y < 0) {
      // Grounded: small downforce keeps us glued to stairs/slopes.
      this.velocity.y = -1.5;
    }

    // --- impulses decay ----------------------------------------------------
    const impulseMag = this.impulse.length();
    if (impulseMag > 0.01) {
      this.velocity.add(this.impulse);
      this.impulse.multiplyScalar(Math.max(0, 1 - dt * 6));
      if (this.impulse.lengthSq() < 0.01) this.impulse.set(0, 0, 0);
    }

    // --- integrate with sub-stepping ---------------------------------------
    const totalX = this.velocity.x * dt;
    const totalY = this.velocity.y * dt;
    const totalZ = this.velocity.z * dt;
    const totalDist = Math.hypot(totalX, totalY, totalZ);
    const substeps = Math.max(1, Math.min(6, Math.ceil(totalDist / this.maxSubstep)));
    const inv = 1 / substeps;
    const height = this.capsuleHeight;
    let contacted = false;
    for (let i = 0; i < substeps; i++) {
      const res = this.world.moveCharacter(
        this.position,
        this.radius,
        height,
        totalX * inv,
        totalY * inv,
        totalZ * inv,
        this.stepHeight,
        this.result,
      );
      contacted = contacted || res.contacted;
      if (res.blockedX) {
        this.velocity.x = 0;
        this.velocity.z *= 0.94;
      }
      if (res.blockedZ) {
        this.velocity.z = 0;
        this.velocity.x *= 0.94;
      }
      if (res.blockedUp && this.velocity.y > 0) this.velocity.y = 0;
      if (res.grounded) {
        if (!wasGrounded && this.airTime > 0.08) {
          this.justLanded = true;
          this.lastLandingSpeed = Math.max(0, -this.velocity.y);
        }
        this.velocity.y = 0;
      }
    }
    this.grounded = this.result.grounded;
    this.floorY = this.result.floorY;
    this.ceilingY = this.result.ceilingY;
    this.floorSurface = this.result.floorSurface;
    void contacted;

    // --- bookkeeping -------------------------------------------------------
    if (this.grounded) {
      this.airTime = 0;
    } else {
      this.airTime += dt;
    }
    // Footstep phase from horizontal movement.
    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.stepPhase += horizSpeed * dt * 1.35;
    if (this.stepPhase > 1) this.stepPhase -= 1;
    this.bobTime += dt * (2.6 + horizSpeed * 1.9);
    this.onStairs = Math.abs(this.result.floorY - this.position.y) < 0.02 && this.result.steppedUp;
    if (this.velocity.lengthSq() < 1e-6 && !this.grounded) this.velocity.y = Math.min(this.velocity.y, 0);
    return horizSpeed * dt;
  }

  /** Nearest surface for audio: what are we standing on? */
  get surfaceUnderfoot(): SurfaceType {
    return this.floorSurface;
  }

  /** How fast are we moving (horizontal)? */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Is the character currently able to jump? */
  get canJumpNow(): boolean {
    return this.canJump && this.grounded;
  }

  /** Used by the AI for "am I stuck" detection. */
  horizontalDistanceTo(x: number, z: number): number {
    return Math.hypot(this.position.x - x, this.position.z - z);
  }

  /** Eye position in world space (allocates nothing). */
  eyePosition(out: THREE.Vector3, pitchOffset = 0): THREE.Vector3 {
    return out.set(this.position.x, this.eyeY + pitchOffset, this.position.z);
  }
}
