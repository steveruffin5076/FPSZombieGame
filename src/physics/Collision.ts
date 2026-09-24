/**
 * COLLISION WORLD
 * ===============
 * A deliberately small, fast, *sufficient* physics layer for a horde shooter:
 * yaw-rotatable boxes, walkable ramps, a uniform-grid broadphase, DDA raycasts
 * and a Quake-style character controller.
 *
 * Why not a physics engine (Rapier/Ammo/Bullet)?
 *  - A chapter level is a static shell plus a few animated doors. The only
 *    bodies needing real dynamics are ragdolls (cosmetic, own solver) and
 *    projectiles (analytic, own solver). A general solver would add bundle
 *    weight, non-determinism and debugging cost for zero gameplay gain.
 *  - Determinism matters: identical input must produce identical positions,
 *    because the co-op netcode (see `docs/MULTIPLAYER.md`) will roll this back.
 *    Hand-written, allocation-free maths is far easier to keep deterministic.
 *
 * Data model
 * ----------
 *  - `BoxCollider`: centre + half extents + yaw about Y (two multiplies to
 *    rotate into local space). `solid` blocks movement, `blocksBullets` blocks
 *    raycasts, `doorId` links a collider to an animated door, `enabled` lets a
 *    door be switched off without touching the grid.
 *  - `RampCollider`: a sloped rectangle used for stairs and debris ramps. Ramps
 *    are *walkable surfaces*, not obstacles — the character controller samples
 *    their height exactly like a floor.
 *  - The broadphase is a uniform 6 m grid; the character controller works on a
 *    capsule approximated by a vertical cylinder, with axis-separated
 *    resolution (predictable corner behaviour, cheap to reason about).
 */
import * as THREE from 'three';
import type { BoxCollider, Damageable, HitZone, RayHit, SurfaceType } from '@/core/Types';

/** A sloped walkable rectangle (stairs, ramps, debris piles). */
export interface RampCollider {
  id: number;
  /** Start edge (low end). */
  x0: number;
  z0: number;
  y0: number;
  /** End edge (high end). */
  x1: number;
  z1: number;
  y1: number;
  /** Width across the ramp (perpendicular to its direction). */
  width: number;
  surface: SurfaceType;
  enabled: boolean;
}

export interface MoveResult {
  /** Ground height under the character (-Infinity over the void). */
  floorY: number;
  grounded: boolean;
  /** Lowest ceiling above the character. */
  ceilingY: number;
  blockedX: boolean;
  blockedZ: boolean;
  blockedUp: boolean;
  /** True if anything was touched this frame. */
  contacted: boolean;
  floorSurface: SurfaceType;
  /** True when the character was lifted onto a step this frame. */
  steppedUp: boolean;
}

/**
 * Per-system scratch storage. Everything the collision layer needs is owned by
 * the caller so the steady-state cost of a physics query is zero allocations.
 */
/** Output sink for `groundAt`: either a reusable index list or a surface report. */
export type GroundOut = number[] | { surface?: SurfaceType; floorSurface?: SurfaceType };

export class CollisionScratch {
  readonly hit: RayHit = newRayHit();
  readonly indices: number[] = [];
  readonly boxes: BoxCollider[] = [];
  readonly vec = new THREE.Vector3();
  readonly vec2 = new THREE.Vector3();
  readonly vec3 = new THREE.Vector3();
  readonly result: MoveResult = makeMoveResult();
}

const EPS = 0.001;
/** Character snap distance to the ground (keeps stairs smooth). */
const SNAP_DISTANCE = 0.14;
const CELL = 6;

/** Collision masks used by `raycast`. */
export type RayMask = 'bullets' | 'vision' | 'movement';
/** Custom ray filter: return false to ignore a collider entirely. */
export type RayFilter = (b: BoxCollider) => boolean;

export class CollisionWorld {
  readonly boxes: BoxCollider[] = [];
  readonly ramps: RampCollider[] = [];
  /** Highest geometry in the world (used for spawn/ray bounds). */
  maxY = 0;
  minY = 0;
  /** Bumped whenever geometry changes, so consumers can invalidate caches. */
  version = 1;
  /** Increments each time a door/dynamic collider changes state. */
  dynamicVersion = 1;
  private nextId = 1;
  private gridMinX = 0;
  private gridMinZ = 0;
  private gridW = 0;
  private gridH = 0;
  private cells: number[][] = [];
  private cellBounds = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  private built = false;

  constructor() {
    this.cells = [];
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /**
   * Add a box collider. Half extents define its size; yaw is in radians.
   */
  addBox(
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    surface: SurfaceType = 'concrete',
    opts: {
      solid?: boolean;
      blocksBullets?: boolean;
      yaw?: number;
      doorId?: number;
      enabled?: boolean;
      /** Movement blocking can be disabled with `solid: false`. */
      blocksMovement?: boolean;
    } = {},
  ): BoxCollider {
    const box: BoxCollider = {
      id: this.nextId++,
      cx,
      cy,
      cz,
      hx,
      hy,
      hz,
      surface,
      solid: opts.solid ?? true,
      blocksBullets: opts.blocksBullets ?? opts.solid ?? true,
      doorId: opts.doorId ?? 0,
      yaw: opts.yaw ?? 0,
      enabled: opts.enabled ?? true,
    };
    this.boxes.push(box);
    const top = cy + hy;
    if (top > this.maxY) this.maxY = top;
    const bottom = cy - hy;
    if (bottom < this.minY) this.minY = bottom;
    this.version++;
    this.built = false;
    return box;
  }

  /** Add an axis-aligned box from min/max corners (convenience). */
  addBoxFromCorners(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, surface: SurfaceType = 'concrete', opts: Parameters<CollisionWorld['addBox']>[7] = {}): BoxCollider {
    return this.addBox(
      (minX + maxX) * 0.5,
      (minY + maxY) * 0.5,
      (minZ + maxZ) * 0.5,
      Math.abs(maxX - minX) * 0.5,
      Math.abs(maxY - minY) * 0.5,
      Math.abs(maxZ - minZ) * 0.5,
      surface,
      opts,
    );
  }

  /** Add a walkable ramp from (x0,z0,y0) to (x1,z1,y1). */
  addRamp(
    x0: number,
    z0: number,
    y0: number,
    x1: number,
    z1: number,
    y1: number,
    width: number,
    surface: SurfaceType = 'concrete',
  ): RampCollider {
    const ramp: RampCollider = { id: this.nextId++, x0, z0, y0, x1, z1, y1, width, surface, enabled: true };
    this.ramps.push(ramp);
    if (Math.max(y0, y1) > this.maxY) this.maxY = Math.max(y0, y1);
    this.version++;
    this.built = false;
    return ramp;
  }

  clear(): void {
    this.boxes.length = 0;
    this.ramps.length = 0;
    this.cells = [];
    this.built = false;
    this.maxY = 0;
    this.minY = 0;
    this.version++;
  }

  /** Remove boxes flagged as dynamic (used when reloading a chapter). */
  removeDynamic(): void {
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      if (this.boxes[i].doorId !== 0) this.boxes.splice(i, 1);
    }
    this.built = false;
    this.version++;
  }

  get boxCount(): number {
    return this.boxes.length;
  }

  /** Build the broadphase grid. Must be called after the level is generated. */
  build(boundsMinX?: number, boundsMinZ?: number, boundsMaxX?: number, boundsMaxZ?: number): void {
    let minX = boundsMinX ?? Infinity;
    let minZ = boundsMinZ ?? Infinity;
    let maxX = boundsMaxX ?? -Infinity;
    let maxZ = boundsMaxZ ?? -Infinity;
    if (boundsMinX === undefined) {
      for (const b of this.boxes) {
        const ext = Math.abs(Math.sin(b.yaw)) > 1e-3 ? Math.max(b.hx, b.hz) * 1.42 : 0;
        minX = Math.min(minX, b.cx - b.hx - ext);
        maxX = Math.max(maxX, b.cx + b.hx + ext);
        minZ = Math.min(minZ, b.cz - b.hz - ext);
        maxZ = Math.max(maxZ, b.cz + b.hz + ext);
      }
      for (const r of this.ramps) {
        minX = Math.min(minX, r.x0, r.x1);
        maxX = Math.max(maxX, r.x0, r.x1);
        minZ = Math.min(minZ, r.z0, r.z1);
        maxZ = Math.max(maxZ, r.z0, r.z1);
      }
      if (!isFinite(minX)) {
        minX = minZ = -100;
        maxX = maxZ = 100;
      }
    }
    this.cellBounds = { minX: minX - 4, minZ: minZ - 4, maxX: maxX + 4, maxZ: maxZ + 4 };
    this.gridMinX = this.cellBounds.minX;
    this.gridMinZ = this.cellBounds.minZ;
    this.gridW = Math.max(1, Math.ceil((this.cellBounds.maxX - this.gridMinX) / CELL));
    this.gridH = Math.max(1, Math.ceil((this.cellBounds.maxZ - this.gridMinZ) / CELL));
    const total = this.gridW * this.gridH;
    this.cells = new Array(total);
    for (let i = 0; i < total; i++) this.cells[i] = [];
    // Ramps are registered in the same grid for fast lookup.
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const ext = Math.abs(Math.sin(b.yaw)) > 1e-3 ? Math.max(b.hx, b.hz) * 1.42 : 0;
      const x0 = this.cellX(b.cx - b.hx - ext);
      const x1 = this.cellX(b.cx + b.hx + ext);
      const z0 = this.cellZ(b.cz - b.hz - ext);
      const z1 = this.cellZ(b.cz + b.hz + ext);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const list = this.cells[cz * this.gridW + cx];
          if (list) list.push(i);
        }
      }
    }
    this.built = true;
  }

  private cellX(x: number): number {
    return Math.max(0, Math.min(this.gridW - 1, Math.floor((x - this.gridMinX) / CELL)));
  }

  private cellZ(z: number): number {
    return Math.max(0, Math.min(this.gridH - 1, Math.floor((z - this.gridMinZ) / CELL)));
  }

  /** Ensure the broadphase exists (lazy, so callers never have to remember). */
  ensureBuilt(): void {
    if (!this.built) this.build();
  }

  /**
   * All box colliders whose footprint contains (or nearly contains) a point.
   * Used by the navigation bake (per cell) and spawn validation.
   */
  cellBoxes(cx: number, cz: number, margin = 0.85): BoxCollider[] {
    this.ensureBuilt();
    const out = SCRATCH_LIST;
    out.length = 0;
    const x0 = this.cellX(cx - margin);
    const x1 = this.cellX(cx + margin);
    const z0 = this.cellZ(cz - margin);
    const z1 = this.cellZ(cz + margin);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells[iz * this.gridW + ix];
        if (!list) continue;
        for (const i of list) {
          const b = this.boxes[i];
          if (pointInBoxXZ(b, cx, cz, margin)) out.push(b);
        }
      }
    }
    return out;
  }

  /** All ramps whose footprint is near a point. */
  cellRamps(cx: number, cz: number, margin = 0.85): RampCollider[] {
    const out = SCRATCH_RAMP_LIST;
    out.length = 0;
    for (const r of this.ramps) {
      if (!r.enabled) continue;
      const minX = Math.min(r.x0, r.x1) - r.width * 0.5 - margin;
      const maxX = Math.max(r.x0, r.x1) + r.width * 0.5 + margin;
      const minZ = Math.min(r.z0, r.z1) - r.width * 0.5 - margin;
      const maxZ = Math.max(r.z0, r.z1) + r.width * 0.5 + margin;
      if (cx < minX || cx > maxX || cz < minZ || cz > maxZ) continue;
      if (rampHeightAt(r, cx, cz) === null) continue;
      out.push(r);
    }
    return out;
  }

  /** Box indices overlapping a world AABB (broadphase candidates). */
  queryAABB(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: number[], includeDisabled = false): number[] {
    this.ensureBuilt();
    out.length = 0;
    const x0 = this.cellX(minX);
    const x1 = this.cellX(maxX);
    const z0 = this.cellZ(minZ);
    const z1 = this.cellZ(maxZ);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells[iz * this.gridW + ix];
        if (!list) continue;
        for (const i of list) {
          if (out.includes(i)) continue;
          const b = this.boxes[i];
          if (!includeDisabled && !b.enabled) continue;
          const ext = Math.abs(Math.sin(b.yaw)) > 1e-3 ? Math.max(b.hx, b.hz) * 1.42 : 0;
          if (b.cx + b.hx + ext < minX || b.cx - b.hx - ext > maxX) continue;
          if (b.cz + b.hz + ext < minZ || b.cz - b.hz - ext > maxZ) continue;
          if (b.cy + b.hy < minY || b.cy - b.hy > maxY) continue;
          out.push(i);
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Raycasting
  // -------------------------------------------------------------------------

  /**
   * Ray vs. the static world. `skipBullets: true` ignores colliders whose
   * `blocksBullets` is false (glass, fences) — used for vision checks.
   */
  raycast(
    out: RayHit,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    maskOrFilter: RayMask | RayFilter = 'bullets',
  ): RayHit {
    this.ensureBuilt();
    out.hit = false;
    out.distance = maxDist;
    out.point.set(0, 0, 0);
    out.normal.set(0, 0, 0);
    out.entity = null;
    out.hitZone = 'none';
    out.colliderId = 0;

    const stepX = dir.x > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const invX = dir.x !== 0 ? 1 / Math.abs(dir.x) : Infinity;
    const invZ = dir.z !== 0 ? 1 / Math.abs(dir.z) : Infinity;
    let cx = this.cellX(origin.x);
    let cz = this.cellZ(origin.z);
    const cellX0 = this.gridMinX + cx * CELL;
    const cellZ0 = this.gridMinZ + cz * CELL;
    let tMaxX = dir.x === 0 ? Infinity : (dir.x > 0 ? cellX0 + CELL - origin.x : origin.x - cellX0) * invX;
    let tMaxZ = dir.z === 0 ? Infinity : (dir.z > 0 ? cellZ0 + CELL - origin.z : origin.z - cellZ0) * invZ;
    const tDeltaX = dir.x === 0 ? Infinity : CELL * invX;
    const tDeltaZ = dir.z === 0 ? Infinity : CELL * invZ;
    const filter = typeof maskOrFilter === 'function' ? maskOrFilter : null;
    const mask: RayMask = typeof maskOrFilter === 'function' ? 'bullets' : maskOrFilter;
    let best = maxDist;
    let bestBox: BoxCollider | null = null;
    let travelled = 0;
    let guard = 0;
    const limit = Math.max(8, (this.gridW + this.gridH) * 2);

    while (guard++ < limit) {
      const list = this.cells[cz * this.gridW + cx];
      if (list) {
        for (const i of list) {
          const b = this.boxes[i];
          if (!b.enabled) continue;
          if (filter) {
            if (!filter(b)) continue;
          } else {
            if (mask === 'bullets' && !b.blocksBullets) continue;
            if (mask === 'vision' && !b.solid) continue;
          }
          const t = rayBox(origin, dir, b, best);
          if (t !== null && t < best) {
            best = t;
            bestBox = b;
          }
        }
      }
      if (tMaxX < tMaxZ) {
        travelled = tMaxX;
        if (travelled > best) break;
        cx += stepX;
        tMaxX += tDeltaX;
        if (cx < 0 || cx >= this.gridW) break;
      } else {
        travelled = tMaxZ;
        if (travelled > best) break;
        cz += stepZ;
        tMaxZ += tDeltaZ;
        if (cz < 0 || cz >= this.gridH) break;
      }
    }

    if (bestBox) {
      out.hit = true;
      out.distance = best;
      out.surface = bestBox.surface;
      out.colliderId = bestBox.id;
      out.point.copy(origin).addScaledVector(dir, best);
      computeNormal(bestBox, origin, dir, best, out.normal);
    }
    return out;
  }

  /**
   * Raycast that reports wall hits *and* entity hits in one pass, used by AI
   * and by anything that needs "did I hit a person or a wall".
   * The caller supplies an entity index (anything implementing `queryBox`).
   */
  raycastStatic(
    out: RayHit,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    maskOrFilter: RayMask | RayFilter = 'bullets',
  ): RayHit {
    return this.raycast(out, origin, dir, maxDist, maskOrFilter);
  }

  /** Convenience wrapper that allocates its own result object. */
  raycastAllocate(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit {
    return this.raycast(newRayHit(), origin, dir, maxDist);
  }

  /**
   * Ray against a set of entities (zombies/survivors), nearest first.
   * `index` is duck-typed so the entity manager does not need a new interface.
   */
  raycastEntities(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    index: { queryBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: Damageable[]): void },
  ): { entity: Damageable; distance: number; point: THREE.Vector3; zone: HitZone } | null {
    entityScratch.length = 0;
    index.queryBox(
      origin.x - 1,
      origin.y - 2.2,
      origin.z - 1,
      origin.x + dir.x * maxDist + 1,
      origin.y + dir.y * maxDist + 2.2,
      origin.z + dir.z * maxDist + 1,
      entityScratch,
    );
    let best: Damageable | null = null;
    let bestDist = maxDist;
    let bestZone: HitZone = 'none';
    const point = ENTITY_POINT;
    for (const e of entityScratch) {
      if (!e.alive) continue;
      const zone = rayEntityDistance(origin, dir, e, bestDist, point);
      if (zone) {
        best = e;
        bestDist = point.distanceTo(origin);
        bestZone = zone;
      }
    }
    if (!best) return null;
    return { entity: best, distance: bestDist, point: point.clone(), zone: bestZone };
  }

  /** True when the straight segment is blocked by a solid collider. */
  lineBlocked(from: THREE.Vector3, to: THREE.Vector3, mask: 'bullets' | 'vision' | 'movement' = 'bullets'): boolean {
    DIR_A.subVectors(to, from);
    const dist = DIR_A.length();
    if (dist < EPS) return false;
    DIR_A.multiplyScalar(1 / dist);
    this.raycast(HIT_A, from, DIR_A, dist * 0.995, mask);
    return HIT_A.hit;
  }

  // -------------------------------------------------------------------------
  // Ground queries
  // -------------------------------------------------------------------------

  /**
   * Highest surface top at (x,z) at or below `fromY + tolerance`.
   * `outIndices` (optional) receives the candidate box indices so callers can
   * reuse the list; passing an object with a `surface` field receives the
   * surface type instead (the character controller uses this).
   */
  groundAt(
    x: number,
    z: number,
    fromY: number,
    tolerance = 0.6,
    outIndices?: GroundOut,
  ): number {
    this.ensureBuilt();
    const indices = Array.isArray(outIndices) ? outIndices : SCRATCH_INDICES;
    this.queryAABB(x - 0.06, -1000, z - 0.06, x + 0.06, fromY + tolerance, z + 0.06, indices);
    let best = -Infinity;
    let surface: SurfaceType = 'concrete';
    for (const i of indices) {
      const b = this.boxes[i];
      if (!b.solid) continue;
      if (!pointInBoxXZ(b, x, z, 0)) continue;
      const top = b.cy + b.hy;
      if (top > fromY + tolerance + EPS) continue;
      if (top > best) {
        best = top;
        surface = b.surface;
      }
    }
    // Ramps count as ground too.
    for (const r of this.ramps) {
      if (!r.enabled) continue;
      const ry = rampHeightAt(r, x, z);
      if (ry === null) continue;
      if (ry > fromY + tolerance + EPS) continue;
      if (ry > best) {
        best = ry;
        surface = r.surface;
      }
    }
    if (outIndices && !Array.isArray(outIndices)) {
      if (outIndices.surface !== undefined || 'surface' in outIndices) outIndices.surface = surface;
      if (outIndices.floorSurface !== undefined || 'floorSurface' in outIndices) outIndices.floorSurface = surface;
    }
    return best;
  }

  /** Lowest ceiling above `fromY` (Infinity when nothing is overhead). */
  ceilingAt(x: number, z: number, fromY: number, maxY = fromY + 40): number {
    this.ensureBuilt();
    this.queryAABB(x - 0.06, fromY, z - 0.06, x + 0.06, maxY, z + 0.06, SCRATCH_INDICES);
    let best = Infinity;
    for (const i of SCRATCH_INDICES) {
      const b = this.boxes[i];
      if (!b.solid) continue;
      if (!pointInBoxXZ(b, x, z, 0)) continue;
      const bottom = b.cy - b.hy;
      if (bottom < fromY + 0.03) continue;
      if (bottom < best) best = bottom;
    }
    return best;
  }

  /** Is there room for a standing character of `height` at (x,y,z)? */
  canStand(x: number, y: number, z: number, height: number, radius: number): boolean {
    const ceil = this.ceilingAt(x, z, y, y + height + 1.5);
    if (ceil - y < height) return false;
    this.queryAABB(x - radius, y + 0.05, z - radius, x + radius, y + height * 0.9, z + radius, SCRATCH_INDICES);
    for (const i of SCRATCH_INDICES) {
      const b = this.boxes[i];
      if (!b.solid) continue;
      if (b.cy + b.hy <= y + 0.35 + EPS) continue;
      if (b.cy - b.hy >= y + height - EPS) continue;
      if (circleOverlapsBox(b, x, z, radius)) return false;
    }
    return true;
  }

  /** Nearest walkable floor height, or -Infinity when there is none. */
  walkableSurfaceAt(x: number, y: number, z: number, headroom = 1.8, maxDrop = 30): number {
    const floor = this.groundAt(x, z, y + 0.4, 0.4);
    if (!isFinite(floor)) return -Infinity;
    if (y - floor > maxDrop) return -Infinity;
    const ceil = this.ceilingAt(x, z, floor, floor + headroom + 0.6);
    if (ceil - floor < headroom) return -Infinity;
    return floor;
  }

  // -------------------------------------------------------------------------
  // Character movement
  // -------------------------------------------------------------------------

  /**
   * Move a cylindrical character by (dx,dy,dz), resolving collisions.
   * Axis-separated resolution: predictable corners, cheap, and readable.
   */
  moveCharacter(
    pos: THREE.Vector3,
    radius: number,
    height: number,
    dx: number,
    dy: number,
    dz: number,
    stepHeight: number,
    out: MoveResult,
  ): MoveResult {
    this.ensureBuilt();
    out.blockedX = false;
    out.blockedZ = false;
    out.blockedUp = false;
    out.contacted = false;
    out.steppedUp = false;
    const startFeet = pos.y;

    if (dx !== 0) {
      pos.x += dx;
      if (this.resolveHorizontal(pos, radius, height, stepHeight, 'x')) {
        out.blockedX = true;
        out.contacted = true;
      }
    }
    if (dz !== 0) {
      pos.z += dz;
      if (this.resolveHorizontal(pos, radius, height, stepHeight, 'z')) {
        out.blockedZ = true;
        out.contacted = true;
      }
    }
    if (dy > 0) {
      pos.y += dy;
      const ceil = this.ceilingAt(pos.x, pos.z, startFeet + height * 0.5, pos.y + height + 0.6);
      if (ceil - startFeet < height) {
        pos.y = Math.max(startFeet, ceil - height - EPS);
        out.blockedUp = true;
        out.contacted = true;
      }
    } else if (dy !== 0) {
      pos.y += dy;
    }

    // Ground snap.
    const probeFrom = Math.max(pos.y, startFeet);
    const floor = this.groundAt(pos.x, pos.z, probeFrom, 0.35, out);
    out.floorY = floor;
    out.grounded = false;
    if (isFinite(floor)) {
      if (pos.y - floor <= SNAP_DISTANCE + (stepHeight > 0.3 ? 0.2 : 0) && dy <= 0.001) {
        if (pos.y - floor > 0.02) out.steppedUp = true;
        pos.y = floor;
        out.grounded = true;
      } else if (pos.y < floor) {
        pos.y = floor;
        out.grounded = true;
      }
    }
    out.ceilingY = this.ceilingAt(pos.x, pos.z, pos.y, pos.y + height + 4);
    return out;
  }

  /** Push a character out of anything it overlaps on the horizontal plane. */
  private resolveHorizontal(pos: THREE.Vector3, radius: number, height: number, stepHeight: number, axis: 'x' | 'z'): boolean {
    let blocked = false;
    for (let pass = 0; pass < 4; pass++) {
      let pushed = false;
      const candidates = PASS_INDICES;
      this.queryAABB(pos.x - radius, pos.y + 0.05, pos.z - radius, pos.x + radius, pos.y + height, pos.z + radius, candidates);
      for (const i of candidates) {
        const b = this.boxes[i];
        if (!b.solid) continue;
        const top = b.cy + b.hy;
        const bottom = b.cy - b.hy;
        if (top <= pos.y + stepHeight + EPS) continue;
        if (bottom >= pos.y + height - EPS) continue;
        if (!circleOverlapsBox(b, pos.x, pos.z, radius)) continue;
        // Step up if the obstacle is short enough and there is headroom.
        const rise = top - pos.y;
        if (rise > EPS && rise <= stepHeight) {
          const feet = pos.y;
          pos.y = top + 0.002;
          if (this.canStand(pos.x, pos.y, pos.z, height, radius * 0.9)) {
            blocked = true;
            pushed = false;
            pass = -1;
            break;
          }
          pos.y = feet;
        }
        // Otherwise push out along the shallowest direction.
        const push = pushOut(b, pos.x, pos.z, radius);
        pos.x += push.x;
        pos.z += push.y;
        pushed = true;
        blocked = true;
      }
      if (!pushed) break;
    }
    void axis;
    return blocked;
  }

  /** Is a step from `pos` toward (dx,dz) free for a capsule? */
  canMoveTo(pos: THREE.Vector3, dx: number, dz: number, radius: number, height: number, stepHeight: number): boolean {
    const tx = pos.x + dx;
    const tz = pos.z + dz;
    this.queryAABB(tx - radius, pos.y + 0.1, tz - radius, tx + radius, pos.y + height, tz + radius, SCRATCH_INDICES);
    for (const i of SCRATCH_INDICES) {
      const b = this.boxes[i];
      if (!b.solid) continue;
      if (b.cy + b.hy <= pos.y + stepHeight + EPS) continue;
      if (b.cy - b.hy >= pos.y + height - EPS) continue;
      if (circleOverlapsBox(b, tx, tz, radius)) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const LOCAL = new THREE.Vector2();

/** Rotate a world point into a box's local frame (Y axis only). */
function toLocal(b: BoxCollider, x: number, z: number, out: THREE.Vector2): THREE.Vector2 {
  const dx = x - b.cx;
  const dz = z - b.cz;
  if (b.yaw === 0) return out.set(dx, dz);
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return out.set(dx * c + dz * s, -dx * s + dz * c);
}

/** Exact ray-vs-OBB slab test. Returns the entry distance or null. */
export function rayBox(origin: THREE.Vector3, dir: THREE.Vector3, b: BoxCollider, maxDist: number): number | null {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const ox = origin.x - b.cx;
  const oz = origin.z - b.cz;
  // World → local (rotate by -yaw).
  const lox = ox * c + oz * s;
  const loz = -ox * s + oz * c;
  const ldx = dir.x * c + dir.z * s;
  const ldz = -dir.x * s + dir.z * c;
  const loy = origin.y - b.cy;
  const ldy = dir.y;

  let tmin = 0;
  let tmax = maxDist;
  if (Math.abs(ldx) < 1e-9) {
    if (Math.abs(lox) > b.hx) return null;
  } else {
    const inv = 1 / ldx;
    let t1 = (-b.hx - lox) * inv;
    let t2 = (b.hx - lox) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (Math.abs(ldy) < 1e-9) {
    if (Math.abs(loy) > b.hy) return null;
  } else {
    const inv = 1 / ldy;
    let t1 = (-b.hy - loy) * inv;
    let t2 = (b.hy - loy) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (Math.abs(ldz) < 1e-9) {
    if (Math.abs(loz) > b.hz) return null;
  } else {
    const inv = 1 / ldz;
    let t1 = (-b.hz - loz) * inv;
    let t2 = (b.hz - loz) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0 || tmin > maxDist) return null;
  return tmin;
}

function computeNormal(b: BoxCollider, origin: THREE.Vector3, dir: THREE.Vector3, t: number, out: THREE.Vector3): void {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const ox = origin.x - b.cx;
  const oz = origin.z - b.cz;
  const lox = ox * c + oz * s;
  const loz = -ox * s + oz * c;
  const ldx = dir.x * c + dir.z * s;
  const ldz = -dir.x * s + dir.z * c;
  const px = lox + ldx * t;
  const py = origin.y - b.cy + dir.y * t;
  const pz = loz + ldz * t;
  const dx = Math.abs(Math.abs(px) - b.hx);
  const dy = Math.abs(Math.abs(py) - b.hy);
  const dz = Math.abs(Math.abs(pz) - b.hz);
  let nx = 0;
  let ny = 0;
  let nz = 0;
  if (dx <= dy && dx <= dz) nx = px > 0 ? 1 : -1;
  else if (dy <= dz) ny = py > 0 ? 1 : -1;
  else nz = pz > 0 ? 1 : -1;
  // Local → world.
  out.set(nx * c - nz * s, ny, nx * s + nz * c);
  if (out.dot(dir) > 0) out.negate();
}

/** Circle vs. yawed box overlap in the XZ plane. */
export function circleOverlapsBox(b: BoxCollider, x: number, z: number, radius: number): boolean {
  const l = toLocal(b, x, z, LOCAL);
  const cx = Math.max(-b.hx, Math.min(b.hx, l.x));
  const cz = Math.max(-b.hz, Math.min(b.hz, l.y));
  const dx = l.x - cx;
  const dz = l.y - cz;
  return dx * dx + dz * dz < radius * radius;
}

/** Push a circle out along the shallowest axis (returned in world space). */
function pushOut(b: BoxCollider, x: number, z: number, radius: number): THREE.Vector2 {
  const l = toLocal(b, x, z, LOCAL);
  const insideX = Math.abs(l.x) <= b.hx;
  const insideZ = Math.abs(l.y) <= b.hz;
  let lx = 0;
  let lz = 0;
  if (insideX && insideZ) {
    const overlapX = b.hx + radius - Math.abs(l.x);
    const overlapZ = b.hz + radius - Math.abs(l.y);
    if (overlapX < overlapZ) lx = Math.sign(l.x || 1) * overlapX;
    else lz = Math.sign(l.y || 1) * overlapZ;
  } else if (insideX) {
    lz = Math.sign(l.y || 1) * (b.hz + radius - Math.abs(l.y));
  } else if (insideZ) {
    lx = Math.sign(l.x || 1) * (b.hx + radius - Math.abs(l.x));
  } else {
    // Corner: push along the outward diagonal.
    const cornerX = Math.sign(l.x) * b.hx;
    const cornerZ = Math.sign(l.y) * b.hz;
    const dx = l.x - cornerX;
    const dz = l.y - cornerZ;
    const d = Math.hypot(dx, dz);
    if (d > 1e-6 && d < radius) {
      lx = (dx / d) * (radius - d);
      lz = (dz / d) * (radius - d);
    }
  }
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return PUSH_A.set(lx * c - lz * s, lx * s + lz * c);
}

/** Point-in-box test in the XZ plane with a margin. */
export function pointInBoxXZ(b: BoxCollider, x: number, z: number, margin: number): boolean {
  const l = toLocal(b, x, z, LOCAL);
  return Math.abs(l.x) <= b.hx + margin && Math.abs(l.y) <= b.hz + margin;
}

/** Point-in-box test in 3D with a margin. */
export function pointInBox(b: BoxCollider, x: number, y: number, z: number, margin = 0): boolean {
  if (y > b.cy + b.hy + margin || y < b.cy - b.hy - margin) return false;
  return pointInBoxXZ(b, x, z, margin);
}

/** Height of a ramp at a point, or null when the point is off the ramp. */
export function rampHeightAt(r: RampCollider, x: number, z: number): number | null {
  const dx = r.x1 - r.x0;
  const dz = r.z1 - r.z0;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return null;
  const ux = dx / len;
  const uz = dz / len;
  const px = x - r.x0;
  const pz = z - r.z0;
  const along = px * ux + pz * uz;
  if (along < -0.05 || along > len + 0.05) return null;
  const across = px * -uz + pz * ux;
  if (Math.abs(across) > r.width * 0.5) return null;
  const t = Math.max(0, Math.min(1, along / len));
  return r.y0 + (r.y1 - r.y0) * t;
}

/** Capsule/cylinder intersection reporting the hit zone (used by bullets). */
export function rayEntityDistance(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  e: Damageable,
  maxDist: number,
  outPoint: THREE.Vector3,
): HitZone | null {
  const radius = e.isZombie ? 0.42 : 0.36;
  const height = 1.8;
  const ox = origin.x - e.position.x;
  const oz = origin.z - e.position.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a < 1e-9) {
    if (ox * ox + oz * oz > radius * radius) return null;
    const t = (origin.y + dir.y * maxDist - e.position.y) / Math.max(0.001, dir.y);
    if (t < 0 || t > maxDist) return null;
    const py = origin.y + dir.y * t;
    outPoint.set(origin.x, py, origin.z);
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
  if (y < e.position.y - 0.3 || y > e.position.y + height + 0.3) return null;
  outPoint.set(origin.x + dir.x * t, y, origin.z + dir.z * t);
  return zoneFromHeight(y - e.position.y, height);
}

function zoneFromHeight(rel: number, height: number): HitZone {
  const f = rel / height;
  if (f > 0.84) return 'head';
  if (f < 0.34) return 'limb';
  return 'torso';
}

/** Build a fresh RayHit (never share mutable hit results across systems). */
export function newRayHit(): RayHit {
  return {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    surface: 'concrete',
    colliderId: 0,
    entity: null,
    hitZone: 'none',
  };
}

export function makeMoveResult(): MoveResult {
  return {
    floorY: -Infinity,
    grounded: false,
    ceilingY: Infinity,
    blockedX: false,
    blockedZ: false,
    blockedUp: false,
    contacted: false,
    floorSurface: 'concrete',
    steppedUp: false,
  };
}

/** Module-private scratch (never shared between recursive queries). */
const SCRATCH_INDICES: number[] = [];
const PASS_INDICES: number[] = [];
const SCRATCH_LIST: BoxCollider[] = [];
const SCRATCH_RAMP_LIST: RampCollider[] = [];
const HIT_A = newRayHit();
const DIR_A = new THREE.Vector3();
const PUSH_A = new THREE.Vector2();
const ENTITY_POINT = new THREE.Vector3();
const entityScratch: Damageable[] = [];

export type { BoxCollider, RayHit, SurfaceType };
