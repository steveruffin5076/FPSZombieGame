/**
 * NAVIGATION
 * ==========
 * Hordes need cheap, robust pathing for 100+ agents at 60 fps, so instead of
 * A* per agent we bake a **layered walkable grid** and run one breadth-first
 * *flow field* per target. Every zombie simply follows the gradient of the
 * field belonging to the survivor it is chasing — O(1) per agent per frame, and
 * at most 4 field rebuilds per interest change.
 *
 * LAYERS
 * ------
 * Each grid cell stores up to `LAYERS` walkable heights (e.g. ground floor,
 * upper floor, roof). Nodes are `(cell, layer)` pairs, and two nodes are linked
 * when their heights differ by at most `stepUp` (0.6 m) — which means ramps and
 * staircases connect layers *automatically*, with no hand-authored navmesh, and
 * a zombie on the second floor can path outside through the stairwell.
 *
 * The agent-facing API is intentionally tiny:
 *   `nodeAt(x,y,z)` → node under an entity
 *   `buildFlow(node)` / `flowDirection(node, out)` → where do I go next
 *   `isWalkable(x,z)` / `randomPointNear(...)` → Director & spawn helpers
 */
import * as THREE from 'three';
import type { CollisionWorld } from '@/physics/Collision';
import { rampHeightAt } from '@/physics/Collision';

/** How many vertically stacked walkable surfaces a single cell can hold. */
export const LAYERS = 3;
/** Height value meaning "no floor on this layer". */
const CELL_EMPTY_Y = -1e6;
/** Height an agent needs above a surface for it to count as walkable. */
const CLEARANCE = 1.75;
/** Maximum height difference that still counts as a walkable link. */
export const STEP_UP = 0.62;
/**
 * Simultaneous flow fields: one per survivor (player + 3 AI teammates), plus the
 * reserved objective slot below.
 */
export const FLOW_SLOTS = 4;
/**
 * Extra slot reserved for a guide field that points at the chapter objective
 * rather than at a survivor. Nothing in the AI uses it yet — headless tooling
 * (the route-following sim bot) builds it to prove the route is walkable — but
 * it costs one 16k-entry Int32 pair and keeps the reserved index in one place.
 */
export const FLOW_SLOT_OBJECTIVE = 4;
const UNREACHABLE = -1;

interface CellLayerSample {
  y: number;
  ramp: boolean;
}

export class NavGrid {
  readonly cellSize: number;
  readonly w: number;
  readonly h: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxY: number;

  /** [cell * LAYERS + layer] → surface height (NaN/very low = empty). */
  private heights: Float32Array;
  /** Bit flags per cell: 1 = outdoor, 2 = on the main route, 4 = doorway, 8 = interior. */
  private cellFlags: Uint8Array;
  readonly nodeCount: number;

  // --- flow field bank -----------------------------------------------------
  // Multiple survivors are chased simultaneously, and each needs its own
  // flow field. `FLOW_SLOTS` fields are kept side by side (one per survivor)
  // so a zombie can follow the field belonging to *its* target.
  private dist: Int32Array[] = [];
  private next: Int32Array[] = [];
  private queue: Int32Array;
  /** Node each slot's field was built from (-1 = none). */
  flowSource: number[] = [];
  /** Distance (in cells) from the source to the farthest reachable node. */
  flowRadius: number[] = [];

  private static _v = new THREE.Vector3();

  /**
   * `minX/minZ/maxX/maxZ/maxY` describe the navigation volume; the engine
   * constructs a placeholder grid before the first chapter, which is why every
   * argument has a default.
   */
  constructor(minX = 0, minZ = 0, maxX = 1, maxZ = 1, maxY = 4, cellSize = 1.25) {
    this.cellSize = cellSize;
    this.minX = minX;
    this.minZ = minZ;
    this.maxY = maxY;
    this.w = Math.max(1, Math.ceil((maxX - minX) / cellSize));
    this.h = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
    const cells = this.w * this.h;
    this.nodeCount = cells * LAYERS;
    this.heights = new Float32Array(this.nodeCount).fill(-1000);
    this.cellFlags = new Uint8Array(cells);
    for (let i = 0; i < FLOW_SLOTS + 1; i++) {
      this.dist.push(new Int32Array(this.nodeCount).fill(UNREACHABLE));
      this.next.push(new Int32Array(this.nodeCount).fill(-1));
      this.flowSource.push(-1);
      this.flowRadius.push(0);
    }
    this.queue = new Int32Array(this.nodeCount);
  }

  // -------------------------------------------------------------------------
  // Index helpers
  // -------------------------------------------------------------------------

  cellIndex(x: number, z: number): number {
    const ix = Math.floor((x - this.minX) / this.cellSize);
    const iz = Math.floor((z - this.minZ) / this.cellSize);
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.h) return -1;
    return iz * this.w + ix;
  }

  nodeIndex(cell: number, layer: number): number {
    return cell * LAYERS + layer;
  }

  nodeHeight(node: number): number {
    return this.heights[node];
  }

  isWalkableNode(node: number): boolean {
    return node >= 0 && this.heights[node] > -999;
  }

  /** Nearest walkable node to a world position, preferring the closest height. */
  nodeAt(x: number, y: number, z: number, searchRadius = 3): number {
    const cell = this.cellIndex(x, z);
    if (cell < 0) return -1;
    let best = -1;
    let bestScore = Infinity;
    for (let l = 0; l < LAYERS; l++) {
      const n = this.nodeIndex(cell, l);
      const hy = this.heights[n];
      if (hy <= -999) continue;
      const dy = Math.abs(hy - y);
      if (dy > 2.2) continue;
      if (dy < bestScore) {
        bestScore = dy;
        best = n;
      }
    }
    if (best >= 0) return best;
    // Nothing at the exact cell: search a small ring (agent is clipping a wall).
    for (let r = 1; r <= searchRadius; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const c = this.cellIndex(x + dx * this.cellSize, z + dz * this.cellSize);
          if (c < 0) continue;
          for (let l = 0; l < LAYERS; l++) {
            const n = this.nodeIndex(c, l);
            const hy = this.heights[n];
            if (hy <= -999) continue;
            const dy = Math.abs(hy - y);
            if (dy > 2.4) continue;
            if (dy < bestScore) {
              bestScore = dy;
              best = n;
            }
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Cell-index query: is any layer of this cell walkable? Everything else in
   * this class takes world coordinates, so the name is explicit about it.
   */
  isWalkableCellIndex(cx: number, cz: number): boolean {
    if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) return false;
    const base = (cz * this.w + cx) * LAYERS;
    for (let layer = 0; layer < LAYERS; layer++) {
      const y = this.heights[base + layer];
      if (y > CELL_EMPTY_Y) return true;
    }
    return false;
  }

  isWalkable(x: number, y: number, z: number): boolean {
    const cell = this.cellIndex(x, z);
    if (cell < 0) return false;
    for (let l = 0; l < LAYERS; l++) {
      const hy = this.heights[this.nodeIndex(cell, l)];
      if (hy > -999 && Math.abs(hy - y) < 2.4) return true;
    }
    return false;
  }

  cellHasFlag(x: number, z: number, flag: number): boolean {
    const cell = this.cellIndex(x, z);
    if (cell < 0) return false;
    return (this.cellFlags[cell] & flag) !== 0;
  }

  setCellFlag(x: number, z: number, flag: number): void {
    const cell = this.cellIndex(x, z);
    if (cell >= 0) this.cellFlags[cell] |= flag;
  }

  getCellFlags(x: number, z: number): number {
    const cell = this.cellIndex(x, z);
    return cell < 0 ? 0 : this.cellFlags[cell];
  }

  /** Cell-index equivalent of `getCellFlags` (minimap / debug overlays). */
  getCellFlagsByIndex(cx: number, cz: number): number {
    if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) return 0;
    return this.cellFlags[cz * this.w + cx];
  }

  /** True when a cell is indoors (a ceiling exists within 5 m of the floor). */
  isInterior(x: number, z: number): boolean {
    return this.cellHasFlag(x, z, 8);
  }

  outdoor(x: number, z: number): boolean {
    return this.cellHasFlag(x, z, 1);
  }

  // -------------------------------------------------------------------------
  // Baking
  // -------------------------------------------------------------------------

  /**
   * Bake walkable surfaces from static geometry.
   *
   * For every cell we ask the collision world for *all* standable tops (box
   * tops with ≥ CLEARANCE head-room, plus ramp surfaces), then keep the highest
   * LAYERS distinct heights. Cost: O(cells × local boxes) ≈ 15-40 ms for a
   * 200×200 m level, done once at chapter load with a progress callback.
   */
  bake(
    world: CollisionWorld,
    onProgress?: (t: number) => void,
    doorMask?: (b: { doorId: number }) => boolean,
  ): void {
    this.heights.fill(-1000);
    this.cellFlags.fill(0);

    const cs = this.cellSize;
    const half = cs * 0.5;
    const samples: CellLayerSample[] = [];

    for (let iz = 0; iz < this.h; iz++) {
      for (let ix = 0; ix < this.w; ix++) {
        const cx = this.minX + (ix + 0.5) * cs;
        const cz = this.minZ + (iz + 0.5) * cs;
        const cell = iz * this.w + ix;
        samples.length = 0;

        // --- candidate surfaces from static boxes --------------------------
        const list = world.cellBoxes(cx, cz);
        let ceilingAbove = Infinity;
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (!b.solid || !b.enabled) continue;
          if (doorMask && b.doorId !== 0 && !doorMask(b)) continue;
          const bottom = b.cy - b.hy;
          const top = b.cy + b.hy;
          if (bottom < ceilingAbove) ceilingAbove = bottom;
          // Is (cx,cz) inside this box's footprint?
          let lx = cx - b.cx;
          let lz = cz - b.cz;
          if (b.yaw !== 0) {
            const c = Math.cos(-b.yaw);
            const s = Math.sin(-b.yaw);
            const rx = lx * c - lz * s;
            const rz = lx * s + lz * c;
            lx = rx;
            lz = rz;
          }
          if (Math.abs(lx) > b.hx + half || Math.abs(lz) > b.hz + half) continue;
          samples.push({ y: top, ramp: false });
        }

        // --- ramp surfaces -------------------------------------------------
        const rlist = world.cellRamps(cx, cz);
        for (let i = 0; i < rlist.length; i++) {
          const r = rlist[i];
          if (!r.enabled) continue;
          const y = rampHeightAt(r, cx, cz);
          if (y !== null) samples.push({ y, ramp: true });
        }

        if (samples.length === 0) continue;

        // Sort descending, then keep distinct heights that have clearance.
        samples.sort((a, b) => b.y - a.y);
        let layer = 0;
        let lastY = Infinity;
        let hasCeiling = false;
        for (let s = 0; s < samples.length && layer < LAYERS; s++) {
          const { y, ramp } = samples[s];
          if (lastY - y < 0.35) continue; // duplicate surface (e.g. box stack)
          lastY = y;
          // Clearance: find the lowest underside above this surface.
          let clear = Infinity;
          for (let i = 0; i < list.length; i++) {
            const b = list[i];
            const bottom = b.cy - b.hy;
            if (bottom > y + 0.05 && bottom < clear) clear = bottom;
          }
          for (let i = 0; i < rlist.length; i++) {
            const r = rlist[i];
            const ry = rampHeightAt(r, cx, cz);
            if (ry !== null && ry > y + 0.05 && ry < clear) clear = ry;
          }
          const clearance = (clear === Infinity ? Infinity : clear) - y;
          if (!ramp && clearance < CLEARANCE) {
            // Too low to stand under — treat as a solid obstacle cell by leaving
            // it empty (agents will steer around it via the flow field).
            continue;
          }
          if (ramp && clearance < CLEARANCE * 0.75) continue;
          this.heights[this.nodeIndex(cell, layer)] = y;
          layer++;
          if (clear !== Infinity && clear - y < 5) hasCeiling = true;
        }

        if (layer > 0) {
          if (!hasCeiling) this.cellFlags[cell] |= 1; // outdoor
          else this.cellFlags[cell] |= 8; // interior
        }
        void ceilingAbove;
      }
      if (onProgress && (iz & 7) === 0) onProgress(iz / this.h);
    }
    if (onProgress) onProgress(1);
  }

  // -------------------------------------------------------------------------
  // Flow fields
  // -------------------------------------------------------------------------

  /**
   * Build (or refresh) the flow field rooted at `source`. Multi-source BFS over
   * the `(cell, layer)` graph with height-limited links, so routes automatically
   * use staircases and ramps. A full rebuild over a 200×200 m level is ~1-3 ms.
   */
  buildFlow(source: number, slot = 0): void {
    if (source < 0 || slot < 0 || slot > FLOW_SLOT_OBJECTIVE) return;
    // Cheap validity check: same source already has a valid field.
    if (this.flowSource[slot] === source && this.dist[slot][source] === 0) return;
    const dist = this.dist[slot];
    const next = this.next[slot];
    dist.fill(UNREACHABLE);
    next.fill(-1);
    const q = this.queue;
    let head = 0;
    let tail = 0;
    q[tail++] = source;
    dist[source] = 0;
    let maxDist = 0;

    while (head < tail) {
      const node = q[head++];
      const cell = (node / LAYERS) | 0;
      const y = this.heights[node];
      const d = dist[node] + 1;
      const ix = cell % this.w;
      const iz = (cell / this.w) | 0;

      // 8-connected neighbourhood in the XZ plane.
      for (let k = 0; k < 8; k++) {
        const nx = ix + NEIGHBOR_DX[k];
        const nz = iz + NEIGHBOR_DZ[k];
        if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
        const ncell = nz * this.w + nx;
        // Diagonal moves must not cut corners through a solid cell.
        if (k >= 4) {
          const sideA = nz * this.w + ix;
          const sideB = iz * this.w + nx;
          if (!this.cellWalkableAtHeight(sideA, y) || !this.cellWalkableAtHeight(sideB, y)) continue;
        }
        for (let l = 0; l < LAYERS; l++) {
          const nn = ncell * LAYERS + l;
          const ny = this.heights[nn];
          if (ny <= -999) continue;
          if (Math.abs(ny - y) > STEP_UP) continue;
          if (dist[nn] !== UNREACHABLE) continue;
          dist[nn] = d;
          next[nn] = node;
          q[tail++] = nn;
        }
      }
      if (d > maxDist) maxDist = d;
    }
    this.flowSource[slot] = source;
    this.flowRadius[slot] = maxDist;
  }

  private cellWalkableAtHeight(cell: number, y: number): boolean {
    for (let l = 0; l < LAYERS; l++) {
      const hy = this.heights[cell * LAYERS + l];
      if (hy > -999 && Math.abs(hy - y) <= STEP_UP) return true;
    }
    return false;
  }

  /** Distance in cells from a flow source to a node (-1 = unreachable). */
  distanceAt(node: number, slot = 0): number {
    if (node < 0 || node >= this.nodeCount || slot < 0 || slot > FLOW_SLOT_OBJECTIVE) return -1;
    return this.dist[slot][node];
  }

  /** World-space variant of `distanceAt` (metres ≈ cells × cellSize). */
  distanceToPoint(x: number, y: number, z: number, slot = 0): number {
    const n = this.nodeAt(x, y, z);
    return n < 0 ? -1 : this.dist[slot][n];
  }

  /** True when a slot currently holds a usable field. */
  hasFlow(slot: number): boolean {
    return slot >= 0 && slot <= FLOW_SLOT_OBJECTIVE && this.flowSource[slot] >= 0;
  }

  /**
   * Direction an agent at `node` should walk, as a world-space XZ vector.
   * Follows up to `lookahead` nodes so the resulting heading is smooth rather
   * than grid-staircase shaped.
   */
  flowDirection(node: number, out: THREE.Vector3, lookahead = 2, slot = 0): boolean {
    if (node < 0 || node >= this.nodeCount || slot < 0 || slot > FLOW_SLOT_OBJECTIVE) return false;
    if (this.flowSource[slot] < 0) return false;
    const distArray = this.dist[slot];
    const nextArray = this.next[slot];
    let n = node;
    for (let i = 0; i < lookahead; i++) {
      const nx = nextArray[n];
      if (nx < 0) break;
      n = nx;
    }
    if (n === node) {
      // We are at the goal (or stuck): fall back to the direct field gradient.
      let best = -1;
      let bestDist = distArray[node];
      const cell = (node / LAYERS) | 0;
      const ix = cell % this.w;
      const iz = (cell / this.w) | 0;
      for (let k = 0; k < 8; k++) {
        const ncell = (iz + NEIGHBOR_DZ[k]) * this.w + (ix + NEIGHBOR_DX[k]);
        for (let l = 0; l < LAYERS; l++) {
          const nn = ncell * LAYERS + l;
          const dd = distArray[nn];
          if (dd >= 0 && dd < bestDist) {
            bestDist = dd;
            best = nn;
          }
        }
      }
      if (best < 0) return false;
      n = best;
    }
    const target = this.nodeWorldCenter(n, NavGrid._v);
    const cell = (node / LAYERS) | 0;
    const cx = this.minX + ((cell % this.w) + 0.5) * this.cellSize;
    const cz = this.minZ + (((cell / this.w) | 0) + 0.5) * this.cellSize;
    out.set(target.x - cx, 0, target.z - cz);
    const len = out.length();
    if (len < 1e-4) return false;
    out.multiplyScalar(1 / len);
    return true;
  }

  /** World centre of a node (cell centre at the layer's surface height). */
  nodeWorldCenter(node: number, out: THREE.Vector3): THREE.Vector3 {
    const cell = (node / LAYERS) | 0;
    const ix = cell % this.w;
    const iz = (cell / this.w) | 0;
    return out.set(
      this.minX + (ix + 0.5) * this.cellSize,
      this.heights[node],
      this.minZ + (iz + 0.5) * this.cellSize,
    );
  }

  /** Cell grid coordinates of a node. */
  nodeCell(node: number): { ix: number; iz: number; layer: number } {
    const cell = (node / LAYERS) | 0;
    return { ix: cell % this.w, iz: (cell / this.w) | 0, layer: node - cell * LAYERS };
  }

  // -------------------------------------------------------------------------
  // Queries used by spawning / the Director
  // -------------------------------------------------------------------------

  /**
   * Find a walkable point within `radius` of (x,z) that satisfies a predicate —
   * the workhorse for "put a zombie just out of sight" and "drop an item here".
   */
  randomPointNear(
    x: number,
    z: number,
    radius: number,
    rand: () => number,
    accept?: (x: number, y: number, z: number, flags: number) => boolean,
    attempts = 24,
  ): THREE.Vector3 | null {
    const out = new THREE.Vector3();
    for (let i = 0; i < attempts; i++) {
      const a = rand() * Math.PI * 2;
      // sqrt keeps the distribution uniform over the disc rather than centre-biased.
      const r = Math.sqrt(rand()) * radius;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      const cell = this.cellIndex(px, pz);
      if (cell < 0) continue;
      for (let l = 0; l < LAYERS; l++) {
        const n = this.nodeIndex(cell, l);
        const y = this.heights[n];
        if (y <= -999) continue;
        if (accept && !accept(px, y, pz, this.cellFlags[cell])) continue;
        out.set(px, y, pz);
        return out;
      }
    }
    return null;
  }

  /** Iterate every walkable cell (nearest layer only) — used by spawn tables. */
  forEachWalkable(cb: (x: number, y: number, z: number, flags: number) => void): void {
    for (let cell = 0; cell < this.w * this.h; cell++) {
      const n = cell * LAYERS;
      const y = this.heights[n];
      if (y <= -999) continue;
      const ix = cell % this.w;
      const iz = (cell / this.w) | 0;
      cb(this.minX + (ix + 0.5) * this.cellSize, y, this.minZ + (iz + 0.5) * this.cellSize, this.cellFlags[cell]);
    }
  }

  /** Debug: heights of the layers in a cell (used by the nav overlay). */
  layerHeights(cell: number): number[] {
    const out: number[] = [];
    for (let l = 0; l < LAYERS; l++) out.push(this.heights[cell * LAYERS + l]);
    return out;
  }
}

const NEIGHBOR_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBOR_DZ = [0, 0, 1, -1, 1, -1, 1, -1];

/** Cell flags understood by `NavGrid.cellFlags`. */
export const NAV_FLAG = {
  OUTDOOR: 1,
  ON_ROUTE: 2,
  DOORWAY: 4,
  INTERIOR: 8,
  SPAWN_HINT: 16,
  ITEM_HINT: 32,
} as const;
