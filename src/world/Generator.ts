/**
 * PROCEDURAL LEVEL GENERATOR
 * ===========================
 * Turns a declarative `ChapterDef` into a complete playable level: streets,
 * enterable multi-storey buildings with furnished interiors, props, lighting,
 * doors, breakables, a route from spawn to safe room, spawn anchors, loot spots
 * and Director event triggers.
 *
 * Everything is driven by a seeded RNG, so a chapter seed reproduces the same
 * city every time — important for bug reports, for tuning, and for the
 * multiplayer roadmap (the server only ever ships a seed).
 *
 * Pipeline
 * --------
 *   1. `groundAndRoads` — terrain slab, road ribbons, sidewalks, crosswalks.
 *   2. `blocks`         — subdivide the map into city blocks along a street grid.
 *   3. `buildings`      — for each lot: shell walls with door/window openings,
 *                         BSP-split interior rooms, slabs, stairwells, roofs.
 *   4. `route`          — Manhattan walk across the street grid; the safe room
 *                         is built at the far end and the player spawns at the near.
 *   5. `props`          — street furniture, vehicles, barricades, vegetation.
 *   6. `collect`        — spawn anchors, loot spots, decals, entity placements.
 *
 * Geometry goes into per-material `GeometryBatcher`s (a handful of draw calls);
 * collision goes into the `CollisionWorld`. The generator never touches Three.js
 * scene objects, which keeps it unit-testable and headless-friendly.
 */
import * as THREE from 'three';
import { Rng } from '@/core/MathUtil';
import type { CollisionWorld } from '@/physics/Collision';
import { GeometryBatcher, jitterColor } from '@/render/Batcher';
import type { MaterialKey } from '@/render/Materials';
import type { ChapterDef, LevelEventDef, PropKind, LevelTheme } from '@/config/campaign';
import { NAV_FLAG } from '@/world/Nav';
import type {
  BreakableDef,
  DecalDef,
  DoorDef,
  LevelLayout,
  LightDef,
  PlayerSpawn,
  PropInstanceDef,
  SafeRoomDef,
  SpawnAnchor,
  ItemSpot,
  TriggerDef,
} from '@/world/LevelTypes';

/** A prop part: offset, half-extents, colour, optional material/shape override. */
type Part = [number, number, number, number, number, number, number, MaterialKey?, ('box' | 'cyl' | 'sph')?];

interface PropDef {
  parts: Part[];
  /** Adds collision volumes for every part. */
  solid: boolean;
  blocksBullets: boolean;
  /** Footprint radius used for occupancy checks and nav clearing. */
  radius: number;
  /** Tags guide placement: road props go on roads, alley props in alleys, etc. */
  place: ('road' | 'sidewalk' | 'alley' | 'interior' | 'lot' | 'yard' | 'roof')[];
  /** Colour jitter amount so a row of identical props still looks varied. */
  tint?: number;
}

const TIRE = 0x141414;
const GLASS_M: MaterialKey = 'glass';

const PROP_DEFS: Record<string, PropDef> = {
  car: {
    parts: [
      [0, 0.66, 0, 0.92, 0.36, 2.18, 0xffffff],
      [0, 1.16, -0.18, 0.86, 0.3, 1.0, 0x1b1e22, GLASS_M],
      [-0.93, 0.34, 1.42, 0.14, 0.32, 0.32, TIRE, 'rust'],
      [0.93, 0.34, 1.42, 0.14, 0.32, 0.32, TIRE, 'rust'],
      [-0.93, 0.34, -1.42, 0.14, 0.32, 0.32, TIRE, 'rust'],
      [0.93, 0.34, -1.42, 0.14, 0.32, 0.32, TIRE, 'rust'],
    ],
    solid: true,
    blocksBullets: true,
    radius: 2.4,
    place: ['road', 'sidewalk', 'lot'],
    tint: 0.5,
  },
  van: {
    parts: [
      [0, 1.05, 0.2, 0.98, 0.75, 2.3, 0xffffff],
      [0, 1.5, 1.85, 0.95, 0.85, 0.75, 0xdfe4e6, GLASS_M],
      [-1.0, 0.38, 1.5, 0.16, 0.36, 0.36, TIRE, 'rust'],
      [1.0, 0.38, 1.5, 0.16, 0.36, 0.36, TIRE, 'rust'],
      [-1.0, 0.38, -1.5, 0.16, 0.36, 0.36, TIRE, 'rust'],
      [1.0, 0.38, -1.5, 0.16, 0.36, 0.36, TIRE, 'rust'],
    ],
    solid: true,
    blocksBullets: true,
    radius: 2.6,
    place: ['road', 'lot'],
    tint: 0.45,
  },
  truck: {
    parts: [
      [0, 1.15, 1.6, 1.15, 1.1, 1.5, 0xffffff],
      [0, 1.05, -1.9, 1.2, 0.9, 2.4, 0x6b6f70],
      [0, 2.15, -1.9, 1.15, 0.28, 2.35, 0x3b3f41, 'rust'],
      [0, 1.55, 1.9, 1.1, 0.6, 0.9, 0xdfe4e6, GLASS_M],
      [-1.2, 0.45, 1.6, 0.2, 0.45, 0.45, TIRE, 'rust'],
      [1.2, 0.45, 1.6, 0.2, 0.45, 0.45, TIRE, 'rust'],
      [-1.2, 0.45, -2.2, 0.2, 0.45, 0.45, TIRE, 'rust'],
      [1.2, 0.45, -2.2, 0.2, 0.45, 0.45, TIRE, 'rust'],
    ],
    solid: true,
    blocksBullets: true,
    radius: 3.4,
    place: ['road', 'lot'],
    tint: 0.4,
  },
  bus: {
    parts: [
      [0, 1.55, 0, 1.28, 1.5, 5.6, 0xd8d2c4],
      [0, 1.75, 0, 1.3, 0.55, 5.2, 0x2a3238, GLASS_M],
      [0, 0.5, 0, 1.2, 0.35, 5.4, 0x3c4145],
      [-1.35, 0.5, 3.6, 0.22, 0.5, 0.5, TIRE, 'rust'],
      [1.35, 0.5, 3.6, 0.22, 0.5, 0.5, TIRE, 'rust'],
      [-1.35, 0.5, -3.6, 0.22, 0.5, 0.5, TIRE, 'rust'],
      [1.35, 0.5, -3.6, 0.22, 0.5, 0.5, TIRE, 'rust'],
    ],
    solid: true,
    blocksBullets: true,
    radius: 6,
    place: ['road'],
    tint: 0.12,
  },
  dumpster: {
    parts: [
      [0, 0.66, 0, 0.85, 0.66, 1.3, 0x2f4a35],
      [0, 1.36, -0.15, 0.88, 0.08, 1.35, 0x24382a],
    ],
    solid: true,
    blocksBullets: true,
    radius: 1.5,
    place: ['alley', 'sidewalk', 'lot'],
    tint: 0.25,
  },
  barrel: {
    parts: [[0, 0.46, 0, 0.3, 0.46, 0.3, 0x4a3c2a, 'rust', 'cyl']],
    solid: true,
    blocksBullets: true,
    radius: 0.5,
    place: ['alley', 'sidewalk', 'yard', 'interior', 'lot'],
    tint: 0.4,
  },
  crate: {
    parts: [[0, 0.36, 0, 0.36, 0.36, 0.36, 0x6a4c2c]],
    solid: true,
    blocksBullets: true,
    radius: 0.55,
    place: ['alley', 'interior', 'lot', 'yard', 'sidewalk'],
    tint: 0.3,
  },
  pallet: {
    parts: [
      [0, 0.06, 0, 0.6, 0.06, 0.5, 0x7a5a34],
      [0, 0.18, 0, 0.55, 0.06, 0.45, 0x8a6a3c],
    ],
    solid: false,
    blocksBullets: false,
    radius: 0.7,
    place: ['alley', 'interior', 'lot'],
    tint: 0.3,
  },
  cone: {
    parts: [
      [0, 0.02, 0, 0.22, 0.02, 0.22, 0xd9d2c0],
      [0, 0.32, 0, 0.12, 0.3, 0.12, 0xd4561e],
    ],
    solid: false,
    blocksBullets: false,
    radius: 0.3,
    place: ['road', 'sidewalk'],
    tint: 0.2,
  },
  bench: {
    parts: [
      [0, 0.42, 0, 0.55, 0.06, 0.85, 0x5a4227],
      [0, 0.72, -0.45, 0.55, 0.28, 0.06, 0x5a4227],
      [0, 0.2, 0.3, 0.5, 0.2, 0.06, 0x3a3a3a],
    ],
    solid: true,
    blocksBullets: true,
    radius: 1,
    place: ['sidewalk', 'lot'],
    tint: 0.2,
  },
  fence: {
    parts: [
      [-1.1, 0.9, 0, 0.07, 0.9, 0.07, 0x6b5a3a],
      [1.1, 0.9, 0, 0.07, 0.9, 0.07, 0x6b5a3a],
      [0, 1.65, 0, 1.2, 0.07, 0.05, 0x7a6a4a],
      [0, 1.15, 0, 1.2, 0.07, 0.05, 0x7a6a4a],
      [0, 0.6, 0, 1.2, 0.07, 0.05, 0x7a6a4a],
    ],
    solid: true,
    blocksBullets: true,
    radius: 1.3,
    place: ['alley', 'lot', 'sidewalk', 'yard'],
    tint: 0.22,
  },
  streetlight: {
    parts: [
      [0, 3.6, 0, 0.09, 3.6, 0.09, 0x4a4e50, 'metal', 'cyl'],
      [0.55, 7.1, 0, 0.65, 0.07, 0.07, 0x4a4e50, 'metal'],
      [1.1, 6.95, 0, 0.32, 0.1, 0.2, 0xfff0c8],
    ],
    solid: true,
    blocksBullets: true,
    radius: 0.5,
    place: ['sidewalk', 'road'],
  },
  utility_pole: {
    parts: [
      [0, 4.5, 0, 0.16, 4.5, 0.16, 0x4a3a2a, 'wood', 'cyl'],
      [0, 8.4, 0, 1.1, 0.08, 0.08, 0x4a3a2a, 'wood'],
      [-0.2, 0.5, 0.3, 0.5, 0.35, 0.4, 0x3a3a3a],
    ],
    solid: true,
    blocksBullets: true,
    radius: 0.6,
    place: ['sidewalk', 'yard', 'lot'],
  },
  tree: {
    parts: [
      [0, 2.2, 0, 0.22, 2.2, 0.22, 0x4a3a24, undefined, 'cyl'],
      [0, 5.0, 0, 1.5, 1.1, 1.5, 0x2c4020, 'foliage', 'sph'],
      [0.6, 6.1, 0.3, 1.0, 0.85, 1.0, 0x35492a, 'foliage', 'sph'],
      [-0.5, 6.3, -0.4, 0.85, 0.75, 0.85, 0x2a3d1e, 'foliage', 'sph'],
    ],
    solid: true,
    blocksBullets: true,
    radius: 0.7,
    place: ['lot', 'yard', 'sidewalk'],
  },
  bush: {
    parts: [[0, 0.55, 0, 0.62, 0.55, 0.62, 0x33461f, 'foliage', 'sph']],
    solid: false,
    blocksBullets: false,
    radius: 0.7,
    place: ['lot', 'yard', 'sidewalk'],
    tint: 0.35,
  },
  hydrant: {
    parts: [
      [0, 0.3, 0, 0.14, 0.3, 0.14, 0x8a2018, 'rust', 'cyl'],
      [0, 0.66, 0, 0.17, 0.06, 0.17, 0x8a2018, 'rust', 'cyl'],
    ],
    solid: true,
    blocksBullets: true,
    radius: 0.3,
    place: ['sidewalk'],
  },
  sign: {
    parts: [
      [0, 1.0, 0, 0.05, 1.0, 0.05, 0x6a6e70, 'metal', 'cyl'],
      [0, 1.85, 0, 0.35, 0.45, 0.03, 0xd8d4cc],
    ],
    solid: false,
    blocksBullets: false,
    radius: 0.4,
    place: ['sidewalk', 'road'],
  },
  ac_unit: {
    parts: [
      [0, 0.45, 0, 0.55, 0.45, 0.4, 0x8a8e90, 'metal'],
      [0, 0.45, 0.42, 0.3, 0.3, 0.05, 0x4a4e50, 'metal', 'cyl'],
    ],
    solid: true,
    blocksBullets: true,
    radius: 0.8,
    place: ['roof', 'lot', 'alley'],
  },
  pipe: {
    parts: [[0, 0.3, 0, 0.18, 0.18, 2.0, 0x6a5a4a, 'rust', 'cyl']],
    solid: false,
    blocksBullets: false,
    radius: 2,
    place: ['alley', 'yard', 'roof', 'interior'],
  },
  sandbag: {
    parts: [
      [0, 0.15, 0, 0.5, 0.15, 0.3, 0x8a7a5a],
      [0, 0.45, 0, 0.5, 0.15, 0.3, 0x7a6a4a],
      [0.3, 0.75, 0, 0.25, 0.15, 0.3, 0x8a7a5a],
    ],
    solid: true,
    blocksBullets: true,
    radius: 0.7,
    place: ['road', 'sidewalk', 'lot'],
    tint: 0.2,
  },
  generator: {
    parts: [
      [0, 0.6, 0, 0.9, 0.6, 0.65, 0x6a6e3a, 'metal'],
      [0.5, 1.35, -0.3, 0.28, 0.18, 0.28, 0x3a3e2a, 'metal', 'cyl'],
    ],
    solid: true,
    blocksBullets: true,
    radius: 1.2,
    place: ['alley', 'yard', 'lot', 'roof'],
  },
  shelf: {
    parts: [
      [0, 0.9, 0, 0.5, 0.9, 0.22, 0x5a5048],
      [0, 0.5, 0.24, 0.45, 0.03, 0.22, 0x6a6058],
      [0, 1.1, 0.24, 0.45, 0.03, 0.22, 0x6a6058],
    ],
    solid: true,
    blocksBullets: true,
    radius: 0.7,
    place: ['interior'],
    tint: 0.25,
  },
  desk: {
    parts: [
      [0, 0.74, 0, 0.75, 0.04, 0.42, 0x7a5a38],
      [-0.68, 0.36, 0, 0.06, 0.36, 0.4, 0x5a4028],
      [0.68, 0.36, 0, 0.06, 0.36, 0.4, 0x5a4028],
    ],
    solid: true,
    blocksBullets: true,
    radius: 0.9,
    place: ['interior'],
    tint: 0.2,
  },
  bed: {
    parts: [
      [0, 0.28, 0, 0.95, 0.28, 1.05, 0x6a5a48],
      [0, 0.6, 0, 0.9, 0.12, 1.0, 0xbdb6a6],
      [0, 0.68, -0.85, 0.75, 0.1, 0.28, 0xd8d2c4],
    ],
    solid: true,
    blocksBullets: true,
    radius: 1.2,
    place: ['interior'],
    tint: 0.15,
  },
  locker: {
    parts: [
      [0, 0.95, 0, 0.36, 0.95, 0.3, 0x3f5058, 'metal'],
      [0, 0.95, 0.32, 0.3, 0.85, 0.03, 0x4a5c64, 'metal'],
    ],
    solid: true,
    blocksBullets: true,
    radius: 0.55,
    place: ['interior'],
    tint: 0.2,
  },
  table: {
    parts: [
      [0, 0.78, 0, 0.8, 0.05, 0.8, 0x8a6a42],
      [0, 0.4, 0, 0.12, 0.4, 0.12, 0x5a4228],
    ],
    solid: true,
    blocksBullets: true,
    radius: 1,
    place: ['interior'],
    tint: 0.2,
  },
  couch: {
    parts: [
      [0, 0.35, 0, 1.0, 0.35, 0.4, 0x5a3a3a],
      [0, 0.72, -0.32, 1.0, 0.37, 0.12, 0x4a2e2e],
      [-1.0, 0.5, 0, 0.12, 0.5, 0.4, 0x4a2e2e],
      [1.0, 0.5, 0, 0.12, 0.5, 0.4, 0x4a2e2e],
    ],
    solid: true,
    blocksBullets: true,
    radius: 1.2,
    place: ['interior'],
    tint: 0.25,
  },
  counter: {
    parts: [
      [0, 0.5, 0, 1.4, 0.5, 0.35, 0x6a5a4a],
      [0, 1.03, 0, 1.45, 0.05, 0.4, 0x9a9a92],
    ],
    solid: true,
    blocksBullets: true,
    radius: 1.6,
    place: ['interior'],
    tint: 0.15,
  },
  tent: {
    parts: [
      [0, 0.5, 0, 1.2, 0.5, 1.6, 0x4a5a3a],
      [0, 1.3, 0, 1.0, 0.4, 1.3, 0x54643e],
    ],
    solid: true,
    blocksBullets: true,
    radius: 1.8,
    place: ['lot', 'yard'],
    tint: 0.2,
  },
  gurney: {
    parts: [
      [0, 0.72, 0, 0.35, 0.06, 0.95, 0x9aa2a4, 'metal'],
      [0, 0.55, 0, 0.32, 0.12, 0.9, 0xbdb6a6],
      [0, 0.2, 0.7, 0.28, 0.2, 0.06, 0x5a5e60, 'metal'],
      [0, 0.2, -0.7, 0.28, 0.2, 0.06, 0x5a5e60, 'metal'],
    ],
    solid: true,
    blocksBullets: true,
    radius: 1.1,
    place: ['interior'],
  },
  planter: {
    parts: [
      [0, 0.3, 0, 0.6, 0.3, 0.6, 0x6a6258],
      [0, 0.62, 0, 0.52, 0.12, 0.52, 0x3a2e20],
      [0, 0.95, 0, 0.42, 0.3, 0.42, 0x3a5226, 'foliage', 'sph'],
    ],
    solid: true,
    blocksBullets: true,
    radius: 0.8,
    place: ['sidewalk', 'lot'],
    tint: 0.2,
  },
  bus_stop: {
    parts: [
      [0, 1.4, 0, 1.7, 0.07, 0.8, 0x4a545c, 'metal'],
      [-1.6, 1.0, 0, 0.06, 1.0, 0.8, 0x7f8f96, GLASS_M],
      [0, 1.0, 0.85, 1.7, 1.0, 0.05, 0x7f8f96, GLASS_M],
      [1.2, 0.45, 0, 0.4, 0.08, 0.4, 0x5a5e60],
    ],
    solid: true,
    blocksBullets: false,
    radius: 2,
    place: ['sidewalk'],
  },
  billboard: {
    parts: [
      [-1.6, 2.4, 0, 0.16, 2.4, 0.16, 0x5a5e60, 'metal', 'cyl'],
      [1.6, 2.4, 0, 0.16, 2.4, 0.16, 0x5a5e60, 'metal', 'cyl'],
      [0, 5.2, 0, 3.2, 1.1, 0.12, 0x9a8a7a],
    ],
    solid: true,
    blocksBullets: true,
    radius: 3.4,
    place: ['lot', 'road'],
    tint: 0.15,
  },
  barricade: {
    parts: [
      [0, 0.55, 0, 1.2, 0.5, 0.35, 0x8a8580],
      [0, 1.15, 0, 0.5, 0.1, 0.35, 0xd4561e],
    ],
    solid: true,
    blocksBullets: true,
    radius: 1.4,
    place: ['road', 'sidewalk'],
    tint: 0.15,
  },
  debris: {
    parts: [
      [0, 0.12, 0, 0.5, 0.12, 0.4, 0x7a736a],
      [0.4, 0.09, 0.3, 0.3, 0.09, 0.3, 0x6a645c],
    ],
    solid: false,
    blocksBullets: false,
    radius: 0.8,
    place: ['road', 'sidewalk', 'lot', 'alley', 'interior'],
    tint: 0.35,
  },
};

/** Interior furniture bias per room type — decided by a quick heuristic. */
const ROOM_FURNITURE: Record<string, PropKind[]> = {
  office: ['desk', 'shelf', 'locker', 'counter', 'crate'],
  home: ['bed', 'couch', 'table', 'shelf', 'desk'],
  store: ['shelf', 'counter', 'crate', 'pallet'],
  industrial: ['crate', 'shelf', 'barrel', 'pallet', 'generator', 'pipe'],
  medical: ['gurney', 'bed', 'locker', 'counter'],
};

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export class LevelGenerator {
  /**
   * Map a chapter script event onto a runtime trigger kind. The campaign uses
   * authoring language ("ambush", "gauntlet"); the trigger kind is what
   * `Level` reacts to at runtime.
   */
  private triggerKindFor(kind: LevelEventDef['kind']): TriggerDef['kind'] {
    switch (kind) {
      case 'alarm':
        return 'alarm_car';
      case 'gauntlet':
        return 'crescendo';
      case 'horde':
        return 'horde';
      case 'tank':
        return 'tank';
      case 'witch':
        return 'witch';
      case 'ambush':
        return 'ambush';
      case 'final_defence':
        return 'final_defence';
    }
  }

  private world: CollisionWorld;
  private rand: Rng;
  private theme: LevelTheme;
  private chapter: ChapterDef;

  private batches = new Map<MaterialKey, GeometryBatcher>();
  private doors: DoorDef[] = [];
  private lights: LightDef[] = [];
  private triggers: TriggerDef[] = [];
  private itemSpots: ItemSpot[] = [];
  private decals: DecalDef[] = [];
  private breakables: BreakableDef[] = [];
  private entitySpawns: LevelLayout['entitySpawns'] = [];
  private propInstances: PropInstanceDef[] = [];

  public triangles = 0;
  private buildingCount = 0;
  private roomCount = 0;
  private nextDoorId = 1;
  private nextTriggerId = 1;

  private static readonly WALL_T = 0.3;
  private static readonly STOREY_H = 4.0;
  private static readonly SLAB_T = 0.35;
  private static readonly STREET = 13;
  private static readonly BLOCK_PITCH = 48;
  /**
   * How far the terrain slab and street ribbons extend beyond the playable
   * half-extent. The route hugs the city edge in several chapters, so this
   * margin is what stops a player from stepping off the world.
   */
  private static readonly WORLD_MARGIN = 34;
  /** Cells occupied by props/buildings so new placements do not overlap. */
  private occupancy: { x: number; z: number; r: number }[] = [];

  constructor(chapter: ChapterDef, world: CollisionWorld) {
    this.chapter = chapter;
    this.world = world;
    this.theme = chapter.theme;
    this.rand = new Rng(chapter.seed);
  }

  // -------------------------------------------------------------------------
  // Batching helpers
  // -------------------------------------------------------------------------

  private batch(mat: MaterialKey): GeometryBatcher {
    let b = this.batches.get(mat);
    if (!b) {
      b = new GeometryBatcher();
      this.batches.set(mat, b);
    }
    return b;
  }

  /**
   * Add a geometry box, optionally with collision.
   * `collide` also drives the nav baker, since it reads the collision world.
   */
  private box(
    mat: MaterialKey,
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    opts: {
      color?: number;
      uv?: number;
      collide?: boolean;
      solid?: boolean;
      bullets?: boolean;
      yaw?: number;
      doorId?: number;
      skipFaces?: boolean[];
      bakedAo?: boolean;
      surface?: 'concrete' | 'metal' | 'wood' | 'glass' | 'dirt' | 'water' | 'foliage' | 'flesh';
    } = {},
  ): void {
    const collide = opts.collide ?? true;
    const yaw = opts.yaw ?? 0;
    this.batch(mat).addBox(cx, cy, cz, hx, hy, hz, this.world, {
      color: opts.color ?? 0xffffff,
      uvScale: opts.uv ?? 0.22,
      yaw,
      skipFaces: opts.skipFaces,
      bakeAo: opts.bakedAo ?? true,
    });
    if (collide) {
      this.world.addBox(cx, cy, cz, hx, hy, hz, opts.surface ?? 'concrete', {
        solid: opts.solid ?? true,
        blocksBullets: opts.bullets ?? true,
        yaw,
        doorId: opts.doorId ?? 0,
      });
    }
  }

  private isFree(x: number, z: number, r: number): boolean {
    for (const o of this.occupancy) {
      const d = Math.hypot(o.x - x, o.z - z);
      if (d < o.r + r) return false;
    }
    return true;
  }

  private occupy(x: number, z: number, r: number): void {
    this.occupancy.push({ x, z, r });
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  generate(onProgress?: (t: number, label: string) => void): LevelLayout {
    const t0 = performance.now();
    const half = this.chapter.size * 0.5;
    const rng = this.rand;

    onProgress?.(0.02, 'Paving streets');
    const { route, playerSpawn, safeRoom } = this.planRoute(half);
    this.groundAndRoads(half);

    onProgress?.(0.12, 'Raising buildings');
    this.buildCity(half, route, safeRoom);

    onProgress?.(0.6, 'Furnishing interiors');
    this.dressBlocks(half, route, safeRoom);

    onProgress?.(0.72, 'Placing props');
    this.placeStreetProps(half, route);

    onProgress?.(0.82, 'Hanging lights');
    this.placeLights(half, route);

    onProgress?.(0.88, 'Scattering evidence');
    this.placeDecals(half, route);

    onProgress?.(0.93, 'Placing infected');
    this.placeEntities(route);

    onProgress?.(0.96, 'Indexing spawn points');
    const spawnAnchors = this.collectSpawnAnchors(route);

    // Triggers from the chapter script.
    for (const ev of this.chapter.events) this.addTrigger(ev, route);

    const batches = new Map<MaterialKey, THREE.BufferGeometry>();
    let triangles = 0;
    for (const [mat, batcher] of this.batches) {
      const geo = batcher.build(`level_${mat}`);
      if (!geo) continue;
      batches.set(mat, geo);
      triangles += batcher.triangles;
    }

    onProgress?.(1, 'Done');
    const layout: LevelLayout = {
      chapter: this.chapter,
      batches,
      doors: this.doors,
      lights: this.lights,
      triggers: this.triggers,
      itemSpots: this.itemSpots,
      spawnAnchors,
      decals: this.decals,
      breakables: this.breakables,
      entitySpawns: this.entitySpawns,
      route,
      routeLength: polylineLength(route),
      playerSpawn,
      safeRoom,
      bounds: {
        minX: -half - 6,
        minZ: -half - 6,
        maxX: half + 6,
        maxZ: half + 6,
        maxY: this.world.maxY,
      },
      stats: {
        buildings: this.buildingCount,
        rooms: this.roomCount,
        boxes: this.world.boxes.length,
        triangles,
        buildMs: performance.now() - t0,
      },
    };
    void rng;
    return layout;
  }

  // -------------------------------------------------------------------------
  // 1. Ground + roads
  // -------------------------------------------------------------------------

  private groundAndRoads(half: number): void {
    const t = this.theme;
    // The slab is wider than the playable area on purpose: the route and the
    // player spawn sit close to the city edge, and anything that walks past the
    // edge must still land on ground (falling out of the world is unrecoverable).
    const size = (half + LevelGenerator.WORLD_MARGIN) * 2;
    // Terrain slab (its top is y = 0).
    this.box(t.groundMat, 0, -1.5, 0, size * 0.5, 1.5, size * 0.5, {
      uv: 0.08,
      color: 0xf2f2f2,
      surface: 'dirt',
      bakedAo: false,
    });

    // Road ribbons along the street grid.
    const pitch = LevelGenerator.BLOCK_PITCH;
    const cols = Math.floor((size - 20) / pitch) + 1;
    const start = -((cols - 1) * pitch) / 2;
    const roadHalf = LevelGenerator.STREET * 0.5;
    const ext = half + LevelGenerator.WORLD_MARGIN;

    for (let i = 0; i < cols; i++) {
      const x = start + i * pitch;
      // North-South street.
      this.batch(t.roadMat).addQuad(
        x - roadHalf, 0.02, -ext,
        x + roadHalf, 0.02, -ext,
        x + roadHalf, 0.02, ext,
        x - roadHalf, 0.02, ext,
        0xd8d8d8,
        0.1,
        0,
      );
      // East-West street.
      this.batch(t.roadMat).addQuad(
        -ext, 0.02, x - roadHalf,
        -ext, 0.02, x + roadHalf,
        ext, 0.02, x + roadHalf,
        ext, 0.02, x - roadHalf,
        0xd8d8d8,
        0.1,
        0,
      );
      // Lane markings.
      for (let k = 0; k < 40; k++) {
        const z = -ext + k * 9;
        this.batch(t.roadMat).addQuad(
          x - 0.12, 0.035, z,
          x + 0.12, 0.035, z,
          x + 0.12, 0.035, z + 3.4,
          x - 0.12, 0.035, z + 3.4,
          0xd8c070,
          0.2,
          0,
        );
        this.batch(t.roadMat).addQuad(
          z, 0.035, x - 0.12,
          z, 0.035, x + 0.12,
          z + 3.4, 0.035, x + 0.12,
          z + 3.4, 0.035, x - 0.12,
          0xd8c070,
          0.2,
          0,
        );
      }
    }

    // Sidewalks surround each block, one low kerb step.
    const blockHalf = (pitch - LevelGenerator.STREET) * 0.5;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < cols; j++) {
        const cx = start + i * pitch + pitch * 0.5;
        const cz = start + j * pitch + pitch * 0.5;
        if (Math.abs(cx) > half || Math.abs(cz) > half) continue;
        const sw = 1.4;
        const y = 0.16;
        const bh = blockHalf - 1.6;
        // Four sidewalk strips with a nav-friendly 0.16 kerb.
        for (const [dx, dz, hx, hz] of [
          [0, -bh - sw * 0.5, blockHalf + sw, sw * 0.5],
          [0, bh + sw * 0.5, blockHalf + sw, sw * 0.5],
          [-blockHalf - sw * 0.5, 0, sw * 0.5, bh],
          [blockHalf + sw * 0.5, 0, sw * 0.5, bh],
        ] as [number, number, number, number][]) {
          this.box(t.sidewalkMat, cx + dx, y * 0.5, cz + dz, hx, y * 0.5, hz, {
            uv: 0.3,
            color: 0xe8e6e2,
            surface: 'concrete',
            bakedAo: false,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Route planning (streets first, buildings second)
  // -------------------------------------------------------------------------

  private planRoute(half: number): { route: THREE.Vector3[]; playerSpawn: PlayerSpawn; safeRoom: SafeRoomDef } {
    const pitch = LevelGenerator.BLOCK_PITCH;
    const cols = Math.floor((half * 2 - 20) / pitch) + 1;
    const startCoord = -((cols - 1) * pitch) / 2;
    const lane = this.rand.chance(0.5) ? -pitch * 0.25 : pitch * 0.25;

    // Start at the south-west street corner, walk north/east in a zig-zag.
    const route: THREE.Vector3[] = [];
    const sx = startCoord;
    const sz = startCoord;
    route.push(new THREE.Vector3(sx + lane, 0, sz - 6));
    let cx = sx;
    let cz = sz;
    const stepsX = cols - 1;
    const stepsZ = cols - 1;
    let ix = 0;
    let iz = 0;
    let goingZ = true;
    while (ix < stepsX || iz < stepsZ) {
      if (goingZ && iz < stepsZ) {
        const run = this.rand.int(1, Math.max(1, Math.min(3, stepsZ - iz)));
        for (let k = 0; k < run; k++) {
          iz++;
          cz += pitch;
          route.push(new THREE.Vector3(cx + lane, 0, cz + (this.rand.next() - 0.5) * 4));
        }
      } else if (ix < stepsX) {
        const run = this.rand.int(1, Math.max(1, Math.min(3, stepsX - ix)));
        for (let k = 0; k < run; k++) {
          ix++;
          cx += pitch;
          route.push(new THREE.Vector3(cx + (this.rand.next() - 0.5) * 4, 0, cz + lane));
        }
      }
      goingZ = !goingZ;
    }
    // Ensure the final leg pushes toward the far corner.
    route.push(new THREE.Vector3(cx + lane, 0, cz + lane));

    const end = route[route.length - 1];
    // Safe room sits just off the last route point, inside the final block.
    const srDir = this.rand.chance(0.5) ? 1 : -1;
    const safeX = end.x + srDir * (LevelGenerator.STREET * 0.5 + 5);
    const safeZ = end.z + (this.rand.chance(0.5) ? 1 : -1) * (LevelGenerator.BLOCK_PITCH * 0.35);
    const safeRoom: SafeRoomDef = {
      x: safeX,
      y: 0,
      z: safeZ,
      yaw: srDir > 0 ? Math.PI : 0,
      width: 8.4,
      depth: 7,
      doorId: this.nextDoorId++,
      gatherX: safeX,
      gatherY: 0,
      gatherZ: safeZ,
      radius: 3.4,
      label: this.chapter.safeRoomLabel,
    };

    const spawn = route[0];
    const playerSpawn: PlayerSpawn = {
      x: spawn.x - lane * 0.2,
      y: 0,
      z: spawn.z - 5,
      yaw: Math.atan2(route[1].x - spawn.x, route[1].z - spawn.z),
    };
    return { route, playerSpawn, safeRoom };
  }

  // -------------------------------------------------------------------------
  // 3. City blocks
  // -------------------------------------------------------------------------

  private buildCity(half: number, route: THREE.Vector3[], safeRoom: SafeRoomDef): void {
    const pitch = LevelGenerator.BLOCK_PITCH;
    const cols = Math.floor((half * 2 - 20) / pitch) + 1;
    const startCoord = -((cols - 1) * pitch) / 2;
    const blockHalf = (pitch - LevelGenerator.STREET) * 0.5 - 2.0;
    const safePad = safeRoom.radius + 4;

    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < cols; j++) {
        const cx = startCoord + i * pitch + pitch * 0.5;
        const cz = startCoord + j * pitch + pitch * 0.5;
        if (Math.abs(cx) > half - 8 || Math.abs(cz) > half - 8) continue;
        // Keep the safe room's lot clear.
        if (Math.hypot(cx - safeRoom.x, cz - safeRoom.z) < safePad + blockHalf * 0.4) continue;

        const roll = this.rand.next();
        const theme = this.theme;
        if (roll < 0.16) {
          // Open lot: parking, containers, camp.
          this.buildLot(cx, cz, blockHalf);
        } else if (roll < 0.24 && theme.trees > 4) {
          this.buildPark(cx, cz, blockHalf);
        } else {
          this.buildBlockBuildings(cx, cz, blockHalf);
        }
      }
    }

    // The safe room itself, plus a short approach wall so it reads as a goal.
    this.buildSafeRoom(safeRoom);

    // Guarantee the route is walkable: clear props/geometry that intruded.
    this.clearRoute(route);
  }

  private buildBlockBuildings(cx: number, cz: number, extent: number): void {
    const rng = this.rand;
    const splitDir = rng.chance(0.5);
    const rects: Rect[] = splitDir
      ? [
          { x0: cx - extent, z0: cz - extent, x1: cx + extent, z1: cz + rng.range(-4, 6) },
          { x0: cx - extent, z0: cz + rng.range(-6, 4), x1: cx + extent, z1: cz + extent },
        ]
      : [
          { x0: cx - extent, z0: cz - extent, x1: cx + rng.range(-4, 6), z1: cz + extent },
          { x0: cx + rng.range(-6, 4), z0: cz - extent, x1: cx + extent, z1: cz + extent },
        ];

    for (const r of rects) {
      // Inset a little to leave alleys, then optionally split again.
      const inset = 0.6;
      const x0 = r.x0 + inset;
      const z0 = r.z0 + inset;
      const x1 = r.x1 - inset;
      const z1 = r.z1 - inset;
      if (x1 - x0 < 8 || z1 - z0 < 8) continue;

      if (this.rand.chance(0.45) && Math.min(x1 - x0, z1 - z0) > 18) {
        // Split into two narrower buildings sharing a wall.
        const vertical = x1 - x0 > z1 - z0;
        if (vertical) {
          const mid = (x0 + x1) * 0.5 - 0.9;
          this.buildBuilding(x0, z0, mid, z1);
          this.buildBuilding(mid + 1.8, z0, x1, z1);
        } else {
          const mid = (z0 + z1) * 0.5 - 0.9;
          this.buildBuilding(x0, z0, x1, mid);
          this.buildBuilding(x0, mid + 1.8, x1, z1);
        }
      } else {
        this.buildBuilding(x0, z0, x1, z1);
      }
    }

    // Alley clutter.
    if (this.rand.chance(0.7)) {
      const n = this.rand.int(1, 3);
      for (let k = 0; k < n; k++) {
        const kind = this.rand.pick(['dumpster', 'crate', 'barrel', 'pallet', 'debris'] as PropKind[]);
        this.placeProp(kind, cx + this.rand.range(-extent, extent), cz + this.rand.range(-extent, extent), this.rand.range(0, Math.PI * 2), 1);
      }
    }
  }

  /**
   * Build one enterable building: shell, floors, stairwell, roof, rooms.
   * The generational core of the level, used for every structure in the game.
   */
  private buildBuilding(x0: number, z0: number, x1: number, z1: number): void {
    const rng = this.rand;
    const theme = this.theme;
    const t = LevelGenerator.WALL_T;
    const storeyH = LevelGenerator.STOREY_H;
    const slabT = LevelGenerator.SLAB_T;
    const w = x1 - x0;
    const d = z1 - z0;
    if (w < 7 || d < 7) return;

    const storeys = rng.int(theme.buildingMinStoreys, theme.buildingMaxStoreys);
    const wallMat = rng.pick(theme.wallMats);
    const floorMat = rng.chance(0.5) ? theme.floorMat : 'concrete';
    const tint = jitterColor(rng.pick(theme.buildingTints), () => rng.next(), 0.07);
    const enterable = rng.chance(theme.interiorRatio);
    const furnish = rng.chance(theme.furnishChance);
    const roofAccess = storeys > 1 && rng.chance(0.4);

    this.buildingCount++;
    this.occupy((x0 + x1) * 0.5, (z0 + z1) * 0.5, Math.max(w, d) * 0.5 + 1);

    // Stairwell: a 4 x 6 m shaft in one corner-ish quadrant.
    const stairW = 4.2;
    const stairRun = 6.4;
    const stairX = rng.chance(0.5) ? x0 + t + 0.2 : x1 - t - 0.2 - stairW;
    const stairZ = rng.chance(0.5) ? z0 + t + 0.2 : z1 - t - 0.2 - stairRun;
    const stairsRect: Rect = { x0: stairX, z0: stairZ, x1: stairX + stairW, z1: stairZ + stairRun };

    for (let s = 0; s < storeys; s++) {
      const baseY = s * storeyH;
      const topY = baseY + storeyH - slabT;

      // --- perimeter walls with openings ---------------------------------
      const openings = this.planOpenings(x0, z0, x1, z1, s, enterable, storeys, stairsRect);
      this.wallLine(wallMat, tint, 'x', z0, x0, x1, baseY, topY, openings.filter((o) => o.side === 'south'), t);
      this.wallLine(wallMat, tint, 'x', z1, x0, x1, baseY, topY, openings.filter((o) => o.side === 'north'), t);
      this.wallLine(wallMat, tint, 'z', x0, z0, z1, baseY, topY, openings.filter((o) => o.side === 'west'), t);
      this.wallLine(wallMat, tint, 'z', x1, z0, z1, baseY, topY, openings.filter((o) => o.side === 'east'), t);

      // --- interior partitions (BSP) -------------------------------------
      if (enterable && s === 0) {
        this.interiorRooms(x0 + t, z0 + t, x1 - t, z1 - t, baseY, topY, floorMat, wallMat, tint, furnish, false);
      } else if (enterable && (roofAccess || s < storeys - 1) && rng.chance(0.75)) {
        this.interiorRooms(x0 + t, z0 + t, x1 - t, z1 - t, baseY, topY, floorMat, wallMat, tint, furnish, s === storeys - 1);
      }

      // --- upper slab (with a stairwell hole) ----------------------------
      if (s < storeys - 1) {
        const slabY = baseY + storeyH - slabT * 0.5;
        this.slabWithHole(floorMat, x0 + t * 0.5, z0 + t * 0.5, x1 - t * 0.5, z1 - t * 0.5, slabY, slabT, stairsRect, tint);
        // Stairs connecting this storey to the next.
        this.buildStairs(stairsRect, baseY, storeys, s, floorMat);
      }
    }

    // --- roof -------------------------------------------------------------
    const roofY = (storeys - 1) * storeyH + storeyH - slabT * 0.5;
    this.slabWithHole(theme.roofMat, x0, z0, x1, z1, roofY, slabT, stairsRect, tint, roofAccess);
    // Parapet.
    const ph = 0.85;
    const py = roofY + slabT * 0.5 + ph * 0.5;
    for (const [px, pz, hx, hz] of [
      [(x0 + x1) * 0.5, z0, (x1 - x0) * 0.5, 0.18],
      [(x0 + x1) * 0.5, z1, (x1 - x0) * 0.5, 0.18],
      [x0, (z0 + z1) * 0.5, 0.18, (z1 - z0) * 0.5],
      [x1, (z0 + z1) * 0.5, 0.18, (z1 - z0) * 0.5],
    ] as [number, number, number, number][]) {
      this.box(wallMat, px, py, pz, hx, ph * 0.5, hz, { color: tint, collide: true, uv: 0.3, surface: 'concrete' });
    }
    // Roof clutter (AC units, vents, and a chance of loot).
    const clutter = rng.int(0, 3);
    for (let k = 0; k < clutter; k++) {
      const px = rng.range(x0 + 2, x1 - 2);
      const pz = rng.range(z0 + 2, z1 - 2);
      this.placeProp(rng.pick(['ac_unit', 'pipe', 'debris'] as PropKind[]), px, pz, rng.range(0, Math.PI * 2), 1, roofY + slabT * 0.5);
    }

    // Door into the building's ground floor when enterable.
    if (enterable) {
      const doorSide = rng.int(0, 3);
      const dw = 2.0;
      const dx = doorSide === 2 ? x0 : doorSide === 3 ? x1 : rng.range(x0 + 2, x1 - 2);
      const dz = doorSide === 0 ? z0 : doorSide === 1 ? z1 : rng.range(z0 + 2, z1 - 2);
      const yaw = doorSide === 0 || doorSide === 1 ? 0 : Math.PI * 0.5;
      // Only add a real swinging door some of the time; most are broken open.
      if (rng.chance(0.35)) {
        this.doors.push({
          id: this.nextDoorId++,
          x: dx,
          y: 0,
          z: dz,
          yaw,
          width: dw,
          height: 2.3,
          locked: false,
          safeRoom: false,
          kind: rng.chance(0.5) ? 'wood' : 'metal',
          autoClose: rng.chance(0.5) ? 6 : 0,
          health: 250,
          label: 'Door',
        });
      }
      // Always leave a lit entrance.
      this.lights.push({
        x: dx,
        y: 2.6,
        z: dz,
        color: this.theme.interiorLight,
        intensity: this.theme.weather === 'clear' ? 0.5 : 1.1,
        distance: 9,
        flicker: rng.chance(0.3),
        kind: 'interior',
        emissive: true,
      });
    }

    // Occasional loot inside.
    if (enterable && rng.chance(0.65)) {
      this.itemSpots.push({
        x: rng.range(x0 + 2, x1 - 2),
        y: 0.1,
        z: rng.range(z0 + 2, z1 - 2),
        kind: rng.weighted<ItemSpot['kind']>([
          ['ammo', 4],
          ['health', 2.5],
          ['weapon', 1.2],
          ['throwable', 1.8],
        ]),
        tier: rng.chance(0.22) ? 2 : 1,
        interior: true,
        used: false,
      });
    }
  }

  /** Choose door/window openings for one side list of a building storey. */
  private planOpenings(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    storey: number,
    enterable: boolean,
    storeys: number,
    stairs: Rect,
  ): { side: 'north' | 'south' | 'east' | 'west'; start: number; end: number; bottom: number; top: number; glass: boolean }[] {
    const rng = this.rand;
    const out: { side: 'north' | 'south' | 'east' | 'west'; start: number; end: number; bottom: number; top: number; glass: boolean }[] = [];
    const sides: ('north' | 'south' | 'east' | 'west')[] = ['south', 'north', 'west', 'east'];

    for (const side of sides) {
      const horizontal = side === 'south' || side === 'north';
      const a0 = horizontal ? x0 : z0;
      const a1 = horizontal ? x1 : z1;
      const spanStart = a0 + 1.2;
      const spanEnd = a1 - 1.2;
      if (spanEnd - spanStart < 3) continue;

      // Ground floor of a two-storey building can get a window next to the stairwell
      // for flavour, but entrances are handled by `buildBuilding`.
      const isGround = storey === 0;
      const doorChance = isGround && enterable ? 0.55 : 0;
      if (rng.chance(doorChance)) {
        const width = rng.range(1.9, 2.6);
        const c = rng.range(spanStart + width * 0.5, spanEnd - width * 0.5);
        out.push({ side, start: c - width * 0.5, end: c + width * 0.5, bottom: 0, top: 2.4, glass: false });
      }

      const windows = rng.int(1, Math.max(1, Math.floor((spanEnd - spanStart) / 4.5)));
      for (let k = 0; k < windows; k++) {
        const width = rng.range(1.3, 2.1);
        const c = rng.range(spanStart + width * 0.5, spanEnd - width * 0.5);
        // Keep window sills low enough for infected to climb through (nav-friendly).
        const climbable = rng.chance(isGround ? 0.65 : 0.25);
        const bottom = climbable ? 0.5 : 1.05;
        out.push({ side, start: c - width * 0.5, end: c + width * 0.5, bottom, top: bottom + 1.5, glass: true });
      }
    }
    void storeys;
    void stairs;
    return out;
  }

  /** Emit a wall along one axis with openings cut out (and sills/lintels). */
  private wallLine(
    mat: MaterialKey,
    tint: number,
    axis: 'x' | 'z',
    fixed: number,
    a0: number,
    a1: number,
    baseY: number,
    topY: number,
    openings: { start: number; end: number; bottom: number; top: number; glass: boolean }[],
    thickness: number,
  ): void {
    const height = topY - baseY;
    const sorted = [...openings].sort((p, q) => p.start - q.start);

    const emit = (s: number, e: number, y0: number, y1: number, collide = true): void => {
      const len = e - s;
      if (len <= 0.05 || y1 - y0 <= 0.05) return;
      const c = (s + e) * 0.5;
      const cy = (y0 + y1) * 0.5;
      const h = (y1 - y0) * 0.5;
      if (axis === 'x') {
        this.box(mat, c, cy, fixed, len * 0.5, h, thickness * 0.5, { color: tint, uv: 0.22, collide, surface: 'concrete' });
      } else {
        this.box(mat, fixed, cy, c, thickness * 0.5, h, len * 0.5, { color: tint, uv: 0.22, collide, surface: 'concrete' });
      }
    };

    let cursor = a0;
    for (const o of sorted) {
      const s = Math.max(a0, o.start);
      const e = Math.min(a1, o.end);
      if (e <= s) continue;
      emit(cursor, s, baseY, topY);
      // Below the opening (sill), above it (lintel).
      if (o.bottom > baseY + 0.05) emit(s, e, baseY, o.bottom);
      if (o.top < topY - 0.05) emit(s, e, o.top, topY);
      // Window glass pane, breakable.
      if (o.glass) {
        const c = (s + e) * 0.5;
        const cy = (o.bottom + o.top) * 0.5;
        const hh = (o.top - o.bottom) * 0.5;
        const width = e - s;
        // Deep ledge: makes the opening navigable for climbing infected.
        const ledgeDepth = 0.45;
        if (axis === 'x') {
          this.box(mat, c, o.bottom - 0.04, fixed, width * 0.5 + 0.2, 0.06, thickness * 0.5 + ledgeDepth, {
            color: tint,
            uv: 0.3,
            collide: true,
            surface: 'concrete',
          });
          this.breakables.push({
            kind: 'glass_pane',
            x: c,
            y: cy,
            z: fixed,
            yaw: 0,
            hx: width * 0.5,
            hy: hh,
            hz: 0.03,
            health: 12,
            material: 'glass',
            color: 0xbfe6f2,
            explosive: false,
          });
        } else {
          this.box(mat, fixed, o.bottom - 0.04, c, thickness * 0.5 + ledgeDepth, 0.06, width * 0.5 + 0.2, {
            color: tint,
            uv: 0.3,
            collide: true,
            surface: 'concrete',
          });
          this.breakables.push({
            kind: 'glass_pane',
            x: fixed,
            y: cy,
            z: c,
            yaw: Math.PI * 0.5,
            hx: width * 0.5,
            hy: hh,
            hz: 0.03,
            health: 12,
            material: 'glass',
            color: 0xbfe6f2,
            explosive: false,
          });
        }
      }
      cursor = e;
    }
    emit(cursor, a1, baseY, topY);
    void height;
  }

  /** Floor slab covering a rect, minus a hole (stairwell). */
  private slabWithHole(
    mat: MaterialKey,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y: number,
    thickness: number,
    hole: Rect | null,
    tint: number,
    collide = true,
  ): void {
    const tile = 4;
    const nx = Math.max(1, Math.ceil((x1 - x0) / tile));
    const nz = Math.max(1, Math.ceil((z1 - z0) / tile));
    const tw = (x1 - x0) / nx;
    const th = (z1 - z0) / nz;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const sx = x0 + i * tw;
        const sz = z0 + j * th;
        const ex = sx + tw;
        const ez = sz + th;
        if (hole && ex > hole.x0 - 0.2 && sx < hole.x1 + 0.2 && ez > hole.z0 - 0.2 && sz < hole.z1 + 0.2) {
          // Overlaps the stairwell: shrink the tile to leave a climbable opening
          // but still cover the rest of the slab.
          if (hole.z1 - hole.z0 > th && hole.x1 - hole.x0 > tw) continue;
        }
        this.box(mat, (sx + ex) * 0.5, y, (sz + ez) * 0.5, tw * 0.5, thickness * 0.5, th * 0.5, {
          color: tint,
          uv: 0.28,
          collide,
          surface: 'concrete',
        });
      }
    }
  }

  /** A straight flight of stairs rendered as steps over a smooth ramp collider. */
  private buildStairs(rect: Rect, baseY: number, storeys: number, storey: number, mat: MaterialKey): void {
    const x = (rect.x0 + rect.x1) * 0.5;
    const z0 = rect.z0 + 0.4;
    const z1 = rect.z1 - 0.4;
    const rise = LevelGenerator.STOREY_H;
    const steps = 14;
    const stepRise = rise / steps;
    const stepRun = (z1 - z0) / steps;
    const width = (rect.x1 - rect.x0) * 0.5;
    for (let i = 0; i < steps; i++) {
      const y = baseY + stepRise * (i + 0.5);
      const z = z0 + stepRun * (i + 0.5);
      // Steps are decorative: the ramp collider below handles movement.
      this.box(mat, x, y - stepRise * 0.5, z, width, stepRise * 0.5, stepRun * 0.5, {
        color: 0xdcd8d0,
        uv: 0.4,
        collide: false,
        bakedAo: false,
      });
    }
    // Smooth ramp collider so agents glide up instead of stair-stepping.
    this.world.addRamp(x, z0, baseY, x, z1, baseY + rise, width, 'concrete');
    // Landing at the top for the next storey.
    if (storey < storeys - 2) {
      this.box(mat, x, baseY + rise, rect.z1 - 0.5, width, 0.08, 0.9, { color: 0xdcd8d0, uv: 0.3, collide: false });
    }
  }

  /**
   * BSP interior partition: recursively split a rect, walling each split with a
   * doorway. Leaves become rooms that get furniture. Guarantees connectivity.
   */
  private interiorRooms(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    baseY: number,
    topY: number,
    floorMat: MaterialKey,
    wallMat: MaterialKey,
    tint: number,
    furnish: boolean,
    _upper: boolean,
  ): void {
    const rng = this.rand;
    const t = 0.18;
    const minRoom = 4.4;
    const maxRooms = 6;
    const rooms: Rect[] = [];
    const queue: Rect[] = [{ x0, z0, x1, z1 }];
    let splits = 0;

    while (queue.length > 0 && splits < maxRooms - 1) {
      const r = queue.shift()!;
      const w = r.x1 - r.x0;
      const d = r.z1 - r.z0;
      const canSplitX = w > minRoom * 2 + 1.5;
      const canSplitZ = d > minRoom * 2 + 1.5;
      if (!canSplitX && !canSplitZ) {
        rooms.push(r);
        continue;
      }
      splits++;
      if ((canSplitX && canSplitZ && w > d) || (canSplitX && !canSplitZ)) {
        const mid = rng.range(r.x0 + minRoom, r.x1 - minRoom);
        // Dividing wall with a doorway gap.
        const doorC = rng.range(r.z0 + 1.4, r.z1 - 1.4);
        for (const [z0s, z1s] of [
          [r.z0, doorC - 0.75],
          [doorC + 0.75, r.z1],
        ]) {
          const len = z1s - z0s;
          if (len <= 0.2) continue;
          this.box(wallMat, mid, (baseY + topY) * 0.5, (z0s + z1s) * 0.5, t, (topY - baseY) * 0.5, len * 0.5, {
            color: tint,
            uv: 0.3,
            collide: true,
            surface: 'concrete',
          });
        }
        // Lintel above the doorway.
        this.box(wallMat, mid, topY - 0.22, doorC, t, 0.22, 0.78, { color: tint, uv: 0.3, collide: true, surface: 'concrete' });
        queue.push({ x0: r.x0, z0: r.z0, x1: mid - t, z1: r.z1 });
        queue.push({ x0: mid + t, z0: r.z0, x1: r.x1, z1: r.z1 });
      } else {
        const mid = rng.range(r.z0 + minRoom, r.z1 - minRoom);
        const doorC = rng.range(r.x0 + 1.4, r.x1 - 1.4);
        for (const [x0s, x1s] of [
          [r.x0, doorC - 0.75],
          [doorC + 0.75, r.x1],
        ]) {
          const len = x1s - x0s;
          if (len <= 0.2) continue;
          this.box(wallMat, (x0s + x1s) * 0.5, (baseY + topY) * 0.5, mid, len * 0.5, (topY - baseY) * 0.5, t, {
            color: tint,
            uv: 0.3,
            collide: true,
            surface: 'concrete',
          });
        }
        this.box(wallMat, doorC, topY - 0.22, mid, 0.78, 0.22, t, { color: tint, uv: 0.3, collide: true, surface: 'concrete' });
        queue.push({ x0: r.x0, z0: r.z0, x1: r.x1, z1: mid - t });
        queue.push({ x0: r.x0, z0: mid + t, x1: r.x1, z1: r.z1 });
      }
    }
    while (queue.length > 0) rooms.push(queue.shift()!);

    // Room dressing.
    for (const r of rooms) {
      this.roomCount++;
      const area = (r.x1 - r.x0) * (r.z1 - r.z0);
      if (area < 5) continue;
      const kindRoll = this.rand.next();
      const kind = kindRoll < 0.3 ? 'office' : kindRoll < 0.55 ? 'home' : kindRoll < 0.75 ? 'store' : kindRoll < 0.9 ? 'industrial' : 'medical';
      const set = ROOM_FURNITURE[kind];
      const count = Math.max(0, Math.min(4, Math.floor(area / 14)));
      if (furnish && this.rand.chance(this.theme.furnishChance)) {
        for (let k = 0; k < count; k++) {
          const px = this.rand.range(r.x0 + 1.0, r.x1 - 1.0);
          const pz = this.rand.range(r.z0 + 1.0, r.z1 - 1.0);
          if (!this.isFree(px, pz, 1.0)) continue;
          this.placeProp(this.rand.pick(set), px, pz, this.rand.range(0, Math.PI * 2), 1, baseY);
        }
      }
      // Occasional interior light fixture + loot.
      if (this.rand.chance(0.5)) {
        this.lights.push({
          x: (r.x0 + r.x1) * 0.5,
          y: baseY + 2.7,
          z: (r.z0 + r.z1) * 0.5,
          color: this.theme.interiorLight,
          intensity: this.theme.weather === 'clear' ? 0.35 : 0.9,
          distance: 8,
          flicker: this.rand.chance(0.4),
          kind: 'interior',
          emissive: this.theme.weather !== 'clear',
        });
      }
      if (this.rand.chance(0.25)) {
        this.itemSpots.push({
          x: this.rand.range(r.x0 + 1, r.x1 - 1),
          y: baseY + 0.1,
          z: this.rand.range(r.z0 + 1, r.z1 - 1),
          kind: this.rand.weighted<ItemSpot['kind']>([
            ['ammo', 3],
            ['health', 3],
            ['weapon', 1],
            ['throwable', 1.5],
          ]),
          tier: 1,
          interior: true,
          used: false,
        });
      }
      // Blood evidence.
      if (this.rand.chance(0.35)) {
        this.decals.push({
          x: this.rand.range(r.x0 + 0.6, r.x1 - 0.6),
          y: baseY + 0.02,
          z: this.rand.range(r.z0 + 0.6, r.z1 - 0.6),
          nx: 0,
          ny: 1,
          nz: 0,
          kind: 'blood',
          size: this.rand.range(0.8, 2.2),
        });
      }
    }
    void floorMat;
  }

  // -------------------------------------------------------------------------
  // 4. Lots, parks, safe room
  // -------------------------------------------------------------------------

  private buildLot(cx: number, cz: number, extent: number): void {
    // Parked cars and shipping containers.
    const n = this.rand.int(2, 5);
    for (let k = 0; k < n; k++) {
      const kind = this.rand.pick(['car', 'van', 'crate', 'barrel', 'debris', 'pallet', 'truck'] as PropKind[]);
      this.placeProp(
        kind,
        cx + this.rand.range(-extent, extent),
        cz + this.rand.range(-extent, extent),
        this.rand.range(0, Math.PI * 2),
        1,
      );
    }
    // Fence around the lot.
    const posts = 5;
    for (let k = 0; k < posts; k++) {
      const t = k / posts;
      this.placeProp('fence', cx - extent + t * extent * 2, cz - extent, 0, 1);
    }
  }

  private buildPark(cx: number, cz: number, extent: number): void {
    for (let k = 0; k < 8; k++) {
      const kind = this.rand.pick(['tree', 'bush', 'bench', 'planter', 'debris'] as PropKind[]);
      this.placeProp(
        kind,
        cx + this.rand.range(-extent + 1, extent - 1),
        cz + this.rand.range(-extent + 1, extent - 1),
        this.rand.range(0, Math.PI * 2),
        1,
      );
    }
  }

  /** The safe room: sealed concrete room with a single door and a resupply. */
  private buildSafeRoom(sr: SafeRoomDef): void {
    const hw = sr.width * 0.5;
    const hd = sr.depth * 0.5;
    const h = 3.4;
    const t = LevelGenerator.WALL_T;
    const mat: MaterialKey = 'concrete';
    const cx = sr.x;
    const cz = sr.z;

    // Floor pad + walls (3 solid, 1 with the doorway).
    this.box(mat, cx, 0.1, cz, hw, 0.1, hd, { uv: 0.3, color: 0xd8d4cc, surface: 'concrete', bakedAo: false });
    for (const [px, pz, hx, hz] of [
      [cx, cz - hd, hw, t * 0.5],
      [cx, cz + hd, hw, t * 0.5],
      [cx - hw, cz, t * 0.5, hd],
    ] as [number, number, number, number][]) {
      this.box(mat, px, h * 0.5, pz, hx, h * 0.5, hz, { uv: 0.25, color: 0xcfcac2, surface: 'concrete' });
    }
    // Front wall with the doorway facing the route direction (sr.yaw).
    const frontX = sr.yaw === 0 ? cx - hw : cx + hw;
    const doorW = 2.2;
    for (const [z0, z1] of [
      [cz - hd, cz - doorW * 0.5],
      [cz + doorW * 0.5, cz + hd],
    ]) {
      const len = z1 - z0;
      const midZ = (z0 + z1) * 0.5;
      this.box(mat, frontX, h * 0.5, midZ, t * 0.5, h * 0.5, len * 0.5, { uv: 0.25, color: 0xcfcac2, surface: 'concrete' });
    }
    // Lintel over the doorway.
    this.box(mat, frontX, h - 0.3, cz, t * 0.5, 0.3, doorW * 0.5, { uv: 0.25, color: 0xcfcac2, surface: 'concrete' });
    // Ceiling.
    this.box(mat, cx, h + 0.15, cz, hw + t, 0.15, hd + t, { uv: 0.3, color: 0xc8c4bc, surface: 'concrete' });
    // Interior resupply: ammo crate, medkit table, radio.
    this.box('metal', cx + hw * 0.55, 0.28, cz + hd * 0.4, 0.7, 0.28, 0.5, { uv: 0.5, color: 0x5a6a3a, surface: 'metal' });
    this.box('wood', cx - hw * 0.5, 0.4, cz + hd * 0.5, 1.0, 0.06, 0.5, { uv: 0.4, color: 0x7a5a38, surface: 'wood' });
    this.box('metal', cx - hw * 0.5, 0.2, cz + hd * 0.5, 0.1, 0.2, 0.1, { uv: 0.4, color: 0x4a4e50, surface: 'metal' });
    // Safe-room lighting: bright, warm, and reassuring.
    this.lights.push({ x: cx, y: 3.0, z: cz, color: 0xffe6bc, intensity: 2.4, distance: 15, flicker: false, kind: 'safe', emissive: true });
    this.lights.push({ x: cx, y: 2.2, z: cz - hd * 0.6, color: 0xffd0a0, intensity: 1.2, distance: 8, flicker: true, kind: 'emergency', emissive: true });
    // Emergency light box.
    this.box('metal', cx, 2.2, cz - hd * 0.6, 0.25, 0.12, 0.2, { uv: 0.5, color: 0xffc070, collide: false, surface: 'metal' });

    // The door itself (interactive, locks after entry).
    this.doors.push({
      id: sr.doorId,
      x: frontX,
      y: 0,
      z: cz,
      yaw: Math.PI * 0.5,
      width: doorW,
      height: 2.6,
      locked: false,
      safeRoom: true,
      kind: 'safe',
      autoClose: 3,
      health: 0,
      label: sr.label,
    });

    // Loot spots inside.
    this.itemSpots.push({ x: cx + hw * 0.55, y: 0.6, z: cz + hd * 0.4, kind: 'ammo', tier: 3, interior: true, used: false });
    this.itemSpots.push({ x: cx - hw * 0.5, y: 0.5, z: cz + hd * 0.5, kind: 'health', tier: 3, interior: true, used: false });
    this.itemSpots.push({ x: cx, y: 0.2, z: cz - hd * 0.55, kind: 'weapon', tier: 3, interior: true, used: false });
    this.itemSpots.push({ x: cx + hw * 0.2, y: 0.2, z: cz - hd * 0.5, kind: 'throwable', tier: 2, interior: true, used: false });

    // Safe-room trigger.
    this.triggers.push({
      id: this.nextTriggerId++,
      x: sr.gatherX,
      y: sr.gatherY,
      z: sr.gatherZ,
      radius: sr.radius,
      kind: 'safe_room',
      name: sr.label,
      objective: `Reach the ${sr.label}`,
      waveScale: 0,
      marker: true,
    });

    // Barricade the safe-room approach so it reads as a defensible box.
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const px = cx + Math.cos(a) * (hw + 3.2);
      const pz = cz + Math.sin(a) * (hd + 3.2);
      this.placeProp('sandbag', px, pz, a, 1);
    }
    this.occupy(cx, cz, Math.max(hw, hd) + 4);
  }

  // -------------------------------------------------------------------------
  // 5. Street props, dressing, lights, decals
  // -------------------------------------------------------------------------

  private placeStreetProps(half: number, route: THREE.Vector3[]): void {
    const rng = this.rand;
    // Street lamps + utility poles along the road grid.
    const pitch = LevelGenerator.BLOCK_PITCH;
    const cols = Math.floor((half * 2 - 20) / pitch) + 1;
    const start = -((cols - 1) * pitch) / 2;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < cols; j++) {
        const x = start + i * pitch;
        const z = start + j * pitch + pitch * 0.5;
        if (Math.abs(x) > half - 4 || Math.abs(z) > half - 4) continue;
        const off = LevelGenerator.STREET * 0.5 + 1.6;
        if (rng.chance(0.75)) {
          const side = rng.chance(0.5) ? 1 : -1;
          const px = x + off * side;
          this.placeProp('streetlight', px, z, side > 0 ? Math.PI : 0, 1);
          if (rng.chance(this.theme.streetLightChance)) {
            this.lights.push({
              x: px,
              y: 6.7,
              z,
              color: this.theme.streetLightColor,
              intensity: 1.5,
              distance: 18,
              flicker: rng.chance(0.45),
              kind: 'street',
              emissive: true,
            });
          }
        }
        if (rng.chance(0.4)) this.placeProp('utility_pole', x + off, start + j * pitch + rng.range(6, 30), rng.range(0, 6.28), 1);
      }
    }

    // Vehicles and clutter along the route: roadblocks, cover, gore.
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1];
      const b = route[i];
      const len = a.distanceTo(b);
      const dirX = (b.x - a.x) / len;
      const dirZ = (b.z - a.z) / len;
      const count = Math.floor(len / 9);
      for (let k = 0; k < count; k++) {
        const t = (k + rng.next()) / count;
        const px = a.x + (b.x - a.x) * t;
        const pz = a.z + (b.z - a.z) * t;
        const side = rng.chance(0.5) ? 1 : -1;
        const perpX = -dirZ * side;
        const perpZ = dirX * side;
        const dist = rng.range(2.2, LevelGenerator.STREET * 0.5 - 1.5);
        const yaw = Math.atan2(dirX, dirZ) + (rng.chance(0.5) ? Math.PI : 0) + rng.range(-0.25, 0.25);
        const kinds: PropKind[] = ['car', 'van', 'cone', 'barricade', 'dumpster', 'sandbag', 'debris', 'pallet', 'barrel', 'hydrant', 'sign', 'bus'];
        const kind = rng.weighted<PropKind>([
          [rng.pick(kinds), 1],
          ['car', 1.4],
          ['debris', 1.2],
          ['sandbag', 0.7],
        ]);
        this.placeProp(kind, px + perpX * dist, pz + perpZ * dist, yaw, 1);
      }
    }

    // Vegetation on the periphery and in open lots.
    const trees = this.theme.trees;
    for (let k = 0; k < trees; k++) {
      const x = rng.range(-half, half);
      const z = rng.range(-half, half);
      if (this.nearRoute(route, x, z, 6)) continue;
      if (!this.isFree(x, z, 2)) continue;
      this.placeProp(rng.chance(0.7) ? 'tree' : 'bush', x, z, rng.range(0, 6.28), rng.range(0.8, 1.3));
    }
  }

  private nearRoute(route: THREE.Vector3[], x: number, z: number, dist: number): boolean {
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1];
      const b = route[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      if (Math.hypot(x - px, z - pz) < dist) return true;
    }
    return false;
  }

  /** Instantiate a prop: geometry into the batches, collision into the world. */
  placeProp(kind: PropKind | string, x: number, z: number, yaw: number, scale = 1, baseY = 0): boolean {
    const def = PROP_DEFS[kind];
    if (!def) return false;
    if (!this.isFree(x, z, def.radius * scale)) return false;
    this.occupy(x, z, def.radius * scale);

    const rng = this.rand;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    let maxTop = 0;

    for (const [dx, dy, dz, hx, hy, hz, color, matOverride, shape] of def.parts) {
      const wx = x + (dx * scale * cos - dz * scale * sin);
      const wz = z + (dx * scale * sin + dz * scale * cos);
      const wy = baseY + dy * scale;
      const mat = matOverride ?? this.propMaterial(kind);
      const tint = def.tint ? jitterColor(color, () => rng.next(), def.tint) : color;
      if (shape === 'cyl') {
        this.batch(mat).addCylinderY(wx, wy, wz, hx * scale, hy * 2 * scale, 10, tint, 0.35);
      } else if (shape === 'sph') {
        this.batch(mat).addSphere(wx, wy, wz, hx * scale, 8, 6, tint);
      } else {
        this.batch(mat).addBox(wx, wy, wz, hx * scale, hy * scale, hz * scale, this.world, {
          color: tint,
          uvScale: 0.3,
          yaw,
          bakeAo: true,
        });
      }
      if (def.solid) {
        this.world.addBox(wx, wy, wz, hx * scale, hy * scale, hz * scale, 'metal', {
          solid: true,
          blocksBullets: def.blocksBullets,
          yaw,
        });
      }
      const top = dy * scale + hy * scale;
      if (top > maxTop) maxTop = top;
    }

    // Breakable / explosive variants of common props.
    if (kind === 'crate' && rng.chance(0.5)) {
      this.breakables.push({
        kind: 'crate',
        x,
        y: baseY + 0.36 * scale,
        z,
        yaw,
        hx: 0.4 * scale,
        hy: 0.4 * scale,
        hz: 0.4 * scale,
        health: 45,
        material: 'wood',
        color: 0x6a4c2c,
        explosive: false,
      });
    } else if (kind === 'barrel' && rng.chance(0.28)) {
      this.breakables.push({
        kind: 'barrel_explosive',
        x,
        y: baseY + 0.46 * scale,
        z,
        yaw: 0,
        hx: 0.32 * scale,
        hy: 0.46 * scale,
        hz: 0.32 * scale,
        health: 34,
        material: 'rust',
        color: 0xb03a1e,
        explosive: true,
      });
    } else if (kind === 'fence' && rng.chance(0.3)) {
      this.breakables.push({
        kind: 'fence_panel',
        x,
        y: baseY + 0.9,
        z,
        yaw,
        hx: 1.2 * scale,
        hy: 0.9,
        hz: 0.12,
        health: 120,
        material: 'wood',
        color: 0x7a6a4a,
        explosive: false,
      });
    }

    this.propInstances.push({ kind: String(kind), x, y: baseY, z, yaw, scale });
    void maxTop;
    return true;
  }

  private propMaterial(kind: string): MaterialKey {
    switch (kind) {
      case 'car':
      case 'van':
      case 'bus':
      case 'truck':
        return 'metal';
      case 'dumpster':
        return 'metal';
      case 'bench':
      case 'fence':
      case 'pallet':
      case 'desk':
      case 'table':
      case 'bed':
      case 'shelf':
      case 'crate':
        return 'wood';
      case 'barrel':
      case 'generator':
      case 'locker':
      case 'ac_unit':
      case 'pipe':
      case 'gurney':
      case 'streetlight':
      case 'sign':
      case 'utility_pole':
      case 'billboard':
        return 'metal';
      case 'tree':
      case 'bush':
      case 'planter':
        return 'foliage';
      case 'cone':
      case 'barricade':
      case 'sandbag':
      case 'debris':
        return 'concrete';
      case 'hydrant':
        return 'rust';
      case 'tent':
        return 'foliage';
      case 'couch':
      case 'counter':
        return 'plaster';
      default:
        return 'concrete';
    }
  }

  private dressBlocks(half: number, route: THREE.Vector3[], safeRoom: SafeRoomDef): void {
    // Loot along the route, weighted to force exploration but never starve the player.
    const rng = this.rand;
    const spots = Math.round(14 + this.chapter.size * 0.05);
    for (let k = 0; k < spots; k++) {
      const t = k / spots;
      const p = pointOnPolyline(route, t);
      const angle = rng.range(0, Math.PI * 2);
      const dist = rng.range(4, 22);
      const x = p.x + Math.cos(angle) * dist;
      const z = p.z + Math.sin(angle) * dist;
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
      if (Math.hypot(x - safeRoom.x, z - safeRoom.z) < 5) continue;
      const kind = rng.weighted<ItemSpot['kind']>([
        ['ammo', 4],
        ['health', 3],
        ['throwable', 2],
        ['weapon', 1.4],
      ]);
      this.itemSpots.push({ x, y: 0.1, z, kind, tier: rng.chance(0.2) ? 2 : 1, interior: false, used: false });
    }
  }

  private placeLights(_half: number, _route: THREE.Vector3[]): void {
    // Emergency lighting around the safe room approach.
    // (Street/interior lights are created in place by the builders.)
  }

  private placeDecals(half: number, route: THREE.Vector3[]): void {
    const rng = this.rand;
    const n = 26;
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const p = pointOnPolyline(route, t);
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(1, 9);
      this.decals.push({
        x: p.x + Math.cos(a) * d,
        y: 0.03,
        z: p.z + Math.sin(a) * d,
        nx: 0,
        ny: 1,
        nz: 0,
        kind: rng.chance(0.7) ? 'blood' : 'scorch',
        size: rng.range(1.2, 3.4),
      });
    }
    // Occasional scorch marks on asphalt away from the route (battlefield past).
    for (let k = 0; k < 10; k++) {
      this.decals.push({
        x: rng.range(-half, half),
        y: 0.03,
        z: rng.range(-half, half),
        nx: 0,
        ny: 1,
        nz: 0,
        kind: 'scorch',
        size: rng.range(1.5, 4),
      });
    }
  }

  private placeEntities(route: THREE.Vector3[]): void {
    const rng = this.rand;
    const witches = this.chapter.director.witches ?? 0;
    for (let k = 0; k < witches; k++) {
      const p = pointOnPolyline(route, rng.range(0.2, 0.9));
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(14, 26);
      this.entitySpawns.push({
        variant: 'witch',
        x: p.x + Math.cos(a) * d,
        y: 0,
        z: p.z + Math.sin(a) * d,
        yaw: rng.range(0, 6.28),
      });
    }
  }

  // -------------------------------------------------------------------------
  // 6. Routes, anchors, triggers
  // -------------------------------------------------------------------------

  /** Remove any prop blocking the route corridor so the level is always passable. */
  private clearRoute(route: THREE.Vector3[]): void {
    const keep: { x: number; z: number; r: number }[] = [];
    for (const o of this.occupancy) {
      if (this.nearRoute(route, o.x, o.z, 3.2) && o.r > 0.9) {
        // Props inside the corridor are re-placed to its edge.
        const side = this.rand.chance(0.5) ? 1 : -1;
        o.x += side * (o.r + 2.4);
      }
      keep.push(o);
    }
    this.occupancy = keep;
  }

  private collectSpawnAnchors(route: THREE.Vector3[]): SpawnAnchor[] {
    const anchors: SpawnAnchor[] = [];
    const step = 4;
    const half = this.chapter.size * 0.5;

    for (let x = -half; x <= half; x += step) {
      for (let z = -half; z <= half; z += step) {
        // Anchor height comes from the collision world so anchors work indoors too.
        const floor = this.world.groundAt(x, z, 40, 0.65);
        if (floor === -Infinity) continue;
        // Require 1.75 m of headroom — otherwise this is not a spawnable spot.
        const ceil = this.world.ceilingAt(x, z, floor + 0.05);
        if (ceil - floor < 1.75) continue;
        const interior = ceil < floor + 6 && ceil !== Infinity;
        const routeDist = this.routeDistance(route, x, z);
        const flags =
          (interior ? NAV_FLAG.INTERIOR : NAV_FLAG.OUTDOOR) |
          (routeDist < 9 ? NAV_FLAG.ON_ROUTE : 0) |
          NAV_FLAG.SPAWN_HINT;
        // Weight: prefer spots that are 18-45 m from the route (just out of sight).
        const ideal = routeDist > 14 && routeDist < 55 ? 1 : routeDist < 9 ? 0.25 : 0.6;
        anchors.push({ x, y: floor, z, flags, routeDistance: routeDist, weight: ideal });
      }
    }
    return anchors;
  }

  private routeDistance(route: THREE.Vector3[], x: number, z: number): number {
    let best = Infinity;
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1];
      const b = route[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (d < best) best = d;
    }
    return best;
  }

  private addTrigger(ev: LevelEventDef, route: THREE.Vector3[]): void {
    const p = pointOnPolyline(route, ev.atRouteT);
    // Perpendicular offset so triggers can sit beside the street.
    const dir = directionOnPolyline(route, ev.atRouteT);
    const perpX = -dir.z;
    const perpZ = dir.x;
    const x = p.x + perpX * ev.offset;
    const z = p.z + perpZ * ev.offset;
    const kind = this.triggerKindFor(ev.kind);
    this.triggers.push({
      id: this.nextTriggerId++,
      x,
      y: 0,
      z,
      radius: kind === 'crescendo' || kind === 'final_defence' ? 22 : 13,
      kind,
      name: ev.name,
      objective: ev.objective,
      waveScale: ev.waveScale,
      marker: true,
    });
    // Objective props: an abandoned car with the alarm, a generator, etc.
    if (kind === 'alarm_car') {
      this.placeProp('car', x, z, 0, 1);
      this.placeProp('generator', x + 4.2, z + 1.6, 0.9, 1);
    }
    if (kind === 'bridge_collapse') {
      // A pile of rubble that reads as a climbable breach (ramp + debris).
      this.world.addRamp(x - 4, z, 0, x + 4, z, 1.9, 4.5, 'concrete');
      for (let k = 0; k < 10; k++) {
        this.placeProp('debris', x + this.rand.range(-4, 4), z + this.rand.range(-4, 4), this.rand.range(0, 6.28), this.rand.range(0.7, 1.6));
      }
      this.lights.push({ x, y: 4, z, color: 0xff8a3a, intensity: 1.2, distance: 14, flicker: true, kind: 'emergency', emissive: true });
    }
    if (ev.kind === 'final_defence') {
      // Defensive sandbags + floodlights for the extraction set piece.
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        this.placeProp('sandbag', x + Math.cos(a) * 9, z + Math.sin(a) * 9, a, 1);
      }
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        this.lights.push({
          x: x + Math.cos(a) * 11,
          y: 5.5,
          z: z + Math.sin(a) * 11,
          color: 0xfff0d0,
          intensity: 2.2,
          distance: 26,
          flicker: false,
          kind: 'street',
          emissive: true,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Polyline helpers
// ---------------------------------------------------------------------------

export function polylineLength(points: THREE.Vector3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += points[i - 1].distanceTo(points[i]);
  return total;
}

/** Point at normalised arc length `t` along a polyline. */
export function pointOnPolyline(points: THREE.Vector3[], t: number): THREE.Vector3 {
  const total = polylineLength(points);
  const target = Math.max(0, Math.min(1, t)) * total;
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = points[i - 1].distanceTo(points[i]);
    if (acc + seg >= target) {
      const u = seg < 1e-6 ? 0 : (target - acc) / seg;
      return new THREE.Vector3().lerpVectors(points[i - 1], points[i], u);
    }
    acc += seg;
  }
  return points[points.length - 1].clone();
}

function directionOnPolyline(points: THREE.Vector3[], t: number): THREE.Vector3 {
  const total = polylineLength(points);
  const target = Math.max(0, Math.min(1, t)) * total;
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = points[i - 1].distanceTo(points[i]);
    if (acc + seg >= target) {
      const dir = new THREE.Vector3().subVectors(points[i], points[i - 1]);
      dir.y = 0;
      return dir.normalize();
    }
    acc += seg;
  }
  return new THREE.Vector3(0, 0, 1);
}

/** Used by the Director to reason about "how far along the chapter are we". */
export function routeProgress(route: THREE.Vector3[], x: number, z: number): number {
  const total = polylineLength(route);
  let best = 0;
  let bestDist = Infinity;
  let acc = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < bestDist) {
      bestDist = d;
      best = acc + t * Math.sqrt(len2);
    }
    acc += Math.sqrt(len2);
  }
  return total > 0 ? best / total : 0;
}
