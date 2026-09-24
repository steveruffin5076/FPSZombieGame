/**
 * Shared low-level types used across every subsystem.
 *
 * Keeping these in one file avoids circular imports between physics, entities,
 * weapons and AI, and gives the future networking layer a single vocabulary to
 * serialise.
 */
import type * as THREE from 'three';

/** Physical surface classification — drives impact VFX/SFX and bullet penetration. */
export type SurfaceType = 'concrete' | 'metal' | 'wood' | 'glass' | 'flesh' | 'dirt' | 'water' | 'foliage';

export interface SurfaceProfile {
  /** Impact particle colour. */
  color: number;
  /** How many particles a hit spawns. */
  particleCount: number;
  /** 0..1 chance a decal is stamped. */
  decalChance: number;
  /** Bullet penetration energy retention (1 = passes through freely). */
  penetration: number;
  /** Multiplier applied to impact sound loudness (noise that attracts zombies). */
  noise: number;
  /** Synth preset id used for the impact sound. */
  sfx: 'impact_concrete' | 'impact_metal' | 'impact_wood' | 'impact_glass' | 'impact_flesh' | 'impact_dirt';
}

/** Result of any ray / shape query against the collision world. */
export interface RayHit {
  hit: boolean;
  /** World-space contact point. */
  point: THREE.Vector3;
  /** World-space surface normal (points away from the surface). */
  normal: THREE.Vector3;
  distance: number;
  surface: SurfaceType;
  /** Numeric id of the static collider (0 when nothing was hit). */
  colliderId: number;
  /** Damageable entity that was hit, if any (bullet path). */
  entity: Damageable | null;
  /** Which body part was struck (drives head-shot multipliers). */
  hitZone: HitZone;
}

export type HitZone = 'head' | 'torso' | 'limb' | 'none';

/** Anything that can receive damage. Implemented by zombies, survivors and the player. */
export interface Damageable {
  readonly id: number;
  readonly isZombie: boolean;
  readonly isSurvivor: boolean;
  readonly alive: boolean;
  readonly position: THREE.Vector3;
  /** Centre of mass used for hit tests / aim assistance. */
  readonly centre: THREE.Vector3;
  takeDamage(amount: number, opts: DamageOptions): void;
}

export interface DamageOptions {
  /** World position the damage originated from (used for knockback + gore direction). */
  source?: THREE.Vector3;
  /** Entity credited with the damage (player or AI teammate) — used for stats. */
  attacker?: Damageable | null;
  /** Bullet vs. explosion vs. melee vs. fire changes gore + audio. */
  kind: 'bullet' | 'melee' | 'explosion' | 'fire' | 'acid' | 'pounce' | 'crush';
  hitZone?: HitZone;
  /** Damage is dealt over time and should not stagger. */
  dot?: boolean;
  /** Extra force applied to the ragdoll / body (N·s). */
  impulse?: number;
}

/** Axis-aligned collision volume used for static level geometry + dynamic props. */
export interface BoxCollider {
  id: number;
  /** Centre of the box in world space. */
  cx: number;
  cy: number;
  cz: number;
  /** Half extents. */
  hx: number;
  hy: number;
  hz: number;
  surface: SurfaceType;
  /** Blocks movement. */
  solid: boolean;
  /** Blocks bullets (thin fences / railings don't). */
  blocksBullets: boolean;
  /** Non-zero for doors: colliders sharing a doorId can be toggled at once. */
  doorId: number;
  /** Yaw rotation about Y (0 = axis-aligned). Rotation is applied to queries only. */
  yaw: number;
  enabled: boolean;
}
