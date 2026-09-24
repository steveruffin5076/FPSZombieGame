/**
 * BALLISTICS
 * ==========
 * One shared hit-resolution path used by the player, AI teammates and infected
 * abilities. Keeping it shared is what makes friendly fire, damage falloff and
 * head-shot multipliers behave identically no matter who pulls the trigger.
 *
 * A bullet is a ray that can *penetrate*: it steps forward through entities and
 * thin surfaces, losing energy each time, until either its penetration budget or
 * its damage runs out. That gives shotguns their "through-a-crowd" feel and
 * makes cover meaningful without a full voxel-destruction model.
 */
import * as THREE from 'three';
import type { Damageable, HitZone, RayHit } from '@/core/Types';
import type { CollisionWorld } from '@/physics/Collision';
import type { WeaponDef } from '@/config/weapons';
import { SURFACES } from '@/config/weapons';
import type { Rng } from '@/core/MathUtil';

/** Broad-phase access to damageable entities (zombies + survivors). */
export interface EntityIndex {
  /** Fill `out` with every entity whose bounds overlap the AABB. */
  queryBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: Damageable[]): void;
}

export interface BulletHitEntity {
  entity: Damageable;
  damage: number;
  zone: HitZone;
  point: THREE.Vector3;
}

export interface BulletConfig {
  /** Muzzle / eye origin (world space). */
  origin: THREE.Vector3;
  /** Normalised fire direction. */
  dir: THREE.Vector3;
  def: WeaponDef;
  attacker: Damageable | null;
  world: CollisionWorld;
  entities: EntityIndex;
  rand: Rng;
  /** 0 = friendly fire off. */
  friendlyFire: number;
  /** Global damage multiplier (difficulty). */
  damageMul: number;
  /** Distance-based damage falloff for the primary ray (already includes spread). */
  /** Callbacks for VFX/SFX/audio; the caller owns presentation. */
  onEntityHit?: (hit: BulletHitEntity) => void;
  onSurfaceHit?: (hit: RayHit, distanceTravelled: number) => void;
  /**
   * Return false to skip a candidate entity. The shooter always passes one so a
   * weapon fired from inside its owner's own capsule cannot hit them.
   */
  filterEntity?: (e: Damageable) => boolean;
}

export interface BulletResult {
  /** Where the bullet finally stopped. */
  end: THREE.Vector3;
  /** Total distance travelled by the bullet (for falloff/statistics). */
  distance: number;
  hits: BulletHitEntity[];
  hitSurface: boolean;
  surface: string;
}

const MAX_RANGE = 220;
/** Energy retained when the bullet exits a body. */
const ENTITY_PENETRATION_LOSS = 0.72;

/**
 * Cast one projectile. Handles multi-penetration, falloff, hit zones and
 * friendly-fire policy. All state is passed in; nothing is allocated except the
 * returned result and per-hit vectors.
 */
export function castBullet(cfg: BulletConfig, scratchHit: RayHit, entityScratch: Damageable[]): BulletResult {
  const { world, rand } = cfg;
  const origin = cfg.origin;
  const dir = cfg.dir;

  const hits: BulletHitEntity[] = [];
  let cursorDist = 0; // distance travelled so far (for falloff)
  let penetrationLeft = Math.max(0, cfg.def.maxPenetrations);
  let damage = cfg.def.damage * cfg.damageMul;
  let hitSurface = false;
  let surface = 'concrete';
  const end = new THREE.Vector3().copy(origin);
  const stepOrigin = new THREE.Vector3().copy(origin);

  for (let iteration = 0; iteration < 6; iteration++) {
    const wallHit = world.raycastStatic(scratchHit, stepOrigin, dir, MAX_RANGE);
    const wallDist = wallHit.hit ? wallHit.distance : MAX_RANGE;

    // Entity candidates along this segment.
    const minX = Math.min(stepOrigin.x, stepOrigin.x + dir.x * wallDist) - 1;
    const minY = Math.min(stepOrigin.y, stepOrigin.y + dir.y * wallDist) - 2.2;
    const minZ = Math.min(stepOrigin.z, stepOrigin.z + dir.z * wallDist) - 1;
    const maxX = Math.max(stepOrigin.x, stepOrigin.x + dir.x * wallDist) + 1;
    const maxY = Math.max(stepOrigin.y, stepOrigin.y + dir.y * wallDist) + 2.2;
    const maxZ = Math.max(stepOrigin.z, stepOrigin.z + dir.z * wallDist) + 1;
    entityScratch.length = 0;
    cfg.entities.queryBox(minX, minY, minZ, maxX, maxY, maxZ, entityScratch);

    let closest: Damageable | null = null;
    let closestDist = wallDist;
    let closestZone: HitZone = 'none';
    const probe = new THREE.Vector3();
    for (const e of entityScratch) {
      if (!e.alive) continue;
      if (cfg.filterEntity && !cfg.filterEntity(e)) continue;
      const zone = rayEntityDistance(stepOrigin, dir, e, closestDist, probe);
      if (zone) {
        closest = e;
        closestDist = probe.distanceTo(stepOrigin);
        closestZone = zone;
      }
    }

    if (closest) {
      const hitPoint = new THREE.Vector3().copy(stepOrigin).addScaledVector(dir, closestDist);
      cursorDist += closestDist;
      const falloff = falloffFactor(cfg.def, cursorDist);
      const zoneMult = cfg.def.class === 'melee' ? 1 : zoneMultiplier(closest, closestZone);
      let dmg = damage * falloff * zoneMult;
      // Friendly-fire policy lives here, not at the call site: a bullet that
      // reaches a survivor while the setting is off simply carries no damage.
      if (!closest.isZombie && cfg.friendlyFire <= 0) dmg = 0;
      // Defence in depth: a non-finite number anywhere upstream (a bad aim
      // vector, a degenerate spread) must not silently poison a health value
      // into NaN, which would make the victim unkillable and undetectable.
      if (!Number.isFinite(dmg)) dmg = 0;
      hits.push({ entity: closest, damage: dmg, zone: closestZone, point: hitPoint });
      cfg.onEntityHit?.(hits[hits.length - 1]);

      if (penetrationLeft <= 0) {
        return { end: hitPoint.clone(), distance: cursorDist, hits, hitSurface, surface };
      }
      penetrationLeft--;
      damage *= ENTITY_PENETRATION_LOSS;
      if (damage < 1) {
        return { end: hitPoint.clone(), distance: cursorDist, hits, hitSurface, surface };
      }
      stepOrigin.copy(hitPoint).addScaledVector(dir, 0.12);
      continue;
    }

    // No entity closer than the wall → resolve against the surface.
    if (wallHit.hit) {
      cursorDist += wallDist;
      hitSurface = true;
      surface = wallHit.surface;
      end.copy(wallHit.point);
      cfg.onSurfaceHit?.(wallHit, cursorDist);
      const surfacePen = SURFACES[wallHit.surface]?.penetration ?? 0.5;
      const canPenetrate = penetrationLeft > 0 && rand.next() < Math.min(0.95, surfacePen * cfg.def.penetration);
      if (canPenetrate) {
        penetrationLeft--;
        damage *= 0.55 * surfacePen;
        if (damage >= 4) {
          stepOrigin.copy(wallHit.point).addScaledVector(dir, 0.08);
          continue;
        }
      }
      return { end: end.clone(), distance: cursorDist, hits, hitSurface, surface };
    }

    // Nothing at all: the bullet flies off into the distance.
    cursorDist += MAX_RANGE;
    end.copy(stepOrigin).addScaledVector(dir, MAX_RANGE);
    return { end: end.clone(), distance: cursorDist, hits, hitSurface, surface };
  }

  return { end: end.clone(), distance: cursorDist, hits, hitSurface, surface };
}

/** Distance-based damage falloff (100% until falloffStart, then linear to falloffMin). */
export function falloffFactor(def: WeaponDef, distance: number): number {
  if (distance <= def.falloffStart) return 1;
  if (distance >= def.falloffEnd) return def.falloffMin;
  const t = (distance - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return 1 + (def.falloffMin - 1) * t;
}

/**
 * Hit-zone multiplier: zombies expose their own table (armoured commons resist
 * torso shots), survivors use a fixed 2x head / 1x torso / 0.8x limb model.
 */
export function zoneMultiplier(target: Damageable, zone: HitZone): number {
  if (zone === 'none') return 1;
  if (target.isZombie) {
    const table = (target as Damageable & { zoneMultipliers?: Partial<Record<HitZone, number>> }).zoneMultipliers;
    if (table && table[zone] !== undefined) return table[zone]!;
    return zone === 'head' ? 3 : zone === 'torso' ? 1 : 0.6;
  }
  if (zone === 'head') return 2.2;
  if (zone === 'limb') return 0.8;
  return 1;
}

/** Capsule/cylinder intersection that also reports the hit zone. */
export function rayEntityDistance(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  e: Damageable,
  maxDist: number,
  outPoint: THREE.Vector3,
): HitZone | null {
  const radius = e.isZombie ? 0.4 : 0.36;
  const height = 1.8;
  const ox = origin.x - e.position.x;
  const oz = origin.z - e.position.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a < 1e-9) {
    // Vertical shot: just check the cylinder in plan view.
    if (ox * ox + oz * oz > radius * radius) return null;
    const y = origin.y + dir.y * maxDist;
    const t = (y - e.position.y) / Math.max(0.001, dir.y);
    if (t < 0 || t > maxDist) return null;
    const py = origin.y + dir.y * t;
    outPoint.set(origin.x + dir.x * t, py, origin.z + dir.z * t);
    return zoneFromHeight(py - e.position.y, height);
  }
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0 || t > maxDist) return null;
  const y = origin.y + dir.y * t;
  const base = e.position.y;
  if (y < base - 0.25 || y > base + height + 0.25) return null;
  outPoint.set(origin.x + dir.x * t, y, origin.z + dir.z * t);
  return zoneFromHeight(y - base, height);
}

function zoneFromHeight(rel: number, height: number): HitZone {
  const f = rel / height;
  if (f > 0.84) return 'head';
  if (f < 0.34) return 'limb';
  return 'torso';
}

/**
 * Cone test used by melee attacks and shoves: returns the entities inside an arc
 * in front of the attacker, sorted by distance.
 */
export function coneQuery(
  entities: EntityIndex,
  origin: THREE.Vector3,
  forward: THREE.Vector3,
  range: number,
  halfAngleDeg: number,
  maxTargets: number,
  out: Damageable[],
  filter?: (e: Damageable) => boolean,
): Damageable[] {
  out.length = 0;
  const scratch: Damageable[] = [];
  entities.queryBox(origin.x - range, origin.y - 2, origin.z - range, origin.x + range, origin.y + 2, origin.z + range, scratch);
  const cosLimit = Math.cos((halfAngleDeg * Math.PI) / 180);
  const candidates: { e: Damageable; d: number }[] = [];
  for (const e of scratch) {
    if (!e.alive) continue;
    if (filter && !filter(e)) continue;
    const dx = e.position.x - origin.x;
    const dz = e.position.z - origin.z;
    const dy = e.position.y + 0.9 - origin.y;
    const d = Math.hypot(dx, dz);
    if (d > range) continue;
    if (Math.abs(dy) > 2.0) continue;
    const inv = d < 1e-4 ? 1 : 1 / d;
    const dot = (dx * inv) * forward.x + (dz * inv) * forward.z;
    if (dot < cosLimit) continue;
    candidates.push({ e, d });
  }
  candidates.sort((a, b) => a.d - b.d);
  for (let i = 0; i < candidates.length && out.length < maxTargets; i++) out.push(candidates[i].e);
  return out;
}

/**
 * Apply spread to a direction: a random deviation inside a cone. Uses the seeded
 * RNG so shots are reproducible in replays.
 */
export function applySpread(dir: THREE.Vector3, degrees: number, rand: Rng, out: THREE.Vector3): THREE.Vector3 {
  if (degrees <= 0.0001) return out.copy(dir);
  const rad = (degrees * Math.PI) / 180;
  // Build an orthonormal basis around `dir`.
  const up = Math.abs(dir.y) > 0.95 ? UP_ALT : UP;
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  const realUp = new THREE.Vector3().crossVectors(right, dir).normalize();
  // Concentrate the distribution toward the centre (sqrt for uniform disc area).
  const angle = rand.next() * Math.PI * 2;
  const r = Math.sqrt(rand.next()) * Math.tan(rad);
  out.copy(dir);
  out.addScaledVector(right, Math.cos(angle) * r);
  out.addScaledVector(realUp, Math.sin(angle) * r);
  return out.normalize();
}

const UP = new THREE.Vector3(0, 1, 0);
const UP_ALT = new THREE.Vector3(1, 0, 0);

/** Effective spread of a weapon given movement + aim state. */
export function effectiveSpread(
  def: WeaponDef,
  adsAmount: number,
  speed: number,
  airborne: boolean,
  crouching: boolean,
  bloom: number,
): number {
  const moveSpread = def.spreadHip + (def.spreadMove - def.spreadHip) * Math.min(1, speed / 5);
  const base = moveSpread * (1 - adsAmount) + def.spreadAds * adsAmount;
  let s = base + bloom;
  if (airborne) s *= 2.1;
  if (crouching) s *= 0.72;
  return s;
}
