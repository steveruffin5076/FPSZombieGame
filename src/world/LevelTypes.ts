/**
 * Data contracts between the level generator, the level runtime and the
 * Director. Keeping these in one file lets the generator stay pure and makes
 * the whole level pipeline (and later, a networked level seed) serialisable.
 */
import type * as THREE from 'three';
import type { MaterialKey } from '@/render/Materials';
import type { ChapterDef } from '@/config/campaign';
import type { ZombieVariant } from '@/config/zombies';

export interface DoorDef {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Yaw of the door panel when closed. */
  yaw: number;
  width: number;
  height: number;
  locked: boolean;
  /** Safe-room doors seal behind the squad and unlock the next chapter. */
  safeRoom: boolean;
  /** Material flavour. */
  kind: 'wood' | 'metal' | 'safe';
  /** Auto-closes after this long (0 = stays open). */
  autoClose: number;
  /** Health for breakable doors (0 = indestructible). */
  health: number;
  /** Display name for the "locked" prompt. */
  label: string;
}

export interface LightDef {
  x: number;
  y: number;
  z: number;
  color: number;
  intensity: number;
  distance: number;
  flicker: boolean;
  kind: 'street' | 'interior' | 'emergency' | 'safe' | 'fire';
  /** Emissive lamp geometry is batched regardless of the light budget. */
  emissive: boolean;
}

export interface TriggerDef {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  kind:
    | 'alarm_car'
    | 'door_breach'
    | 'crescendo'
    | 'elevator'
    | 'generator_start'
    | 'bridge_collapse'
    | 'final_defence'
    | 'safe_room'
    // chapter-script events (see config/campaign.ts)
    | 'horde'
    | 'tank'
    | 'witch'
    | 'ambush'
    | 'gauntlet'
    | 'alarm';
  name: string;
  objective: string;
  waveScale: number;
  /** Marker object so the player can see the objective (e.g. a car with the alarm). */
  marker: boolean;
}

export type ItemSpotKind = 'ammo' | 'health' | 'weapon' | 'throwable' | 'any';

export interface ItemSpot {
  x: number;
  y: number;
  z: number;
  kind: ItemSpotKind;
  /** Higher tier = rarer/better loot (weapons). */
  tier: number;
  /** Interior spots are safer but harder to find. */
  interior: boolean;
  used: boolean;
}

export interface SpawnAnchor {
  x: number;
  y: number;
  z: number;
  /** Mirrors NAV_FLAG values: OUTDOOR/INTERIOR/ON_ROUTE/DOORWAY. */
  flags: number;
  /** Distance to the nearest route point, in cells. */
  routeDistance: number;
  /** Weight used by the Director when picking "just out of sight" spots. */
  weight: number;
}

export interface DecalDef {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  kind: 'blood' | 'scorch' | 'bile';
  size: number;
}

/** A prop that can be shot apart (crate, barrel, glass pane, wooden fence). */
export interface BreakableDef {
  kind: 'crate' | 'barrel_explosive' | 'fence_panel' | 'glass_pane' | 'vending';
  x: number;
  y: number;
  z: number;
  yaw: number;
  hx: number;
  hy: number;
  hz: number;
  health: number;
  material: MaterialKey;
  color: number;
  /** Explodes when destroyed (explosive barrels). */
  explosive: boolean;
}

/** A prop that must exist as its own object (animated/instanced). */
export interface PropInstanceDef {
  kind: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

export interface SafeRoomDef {
  x: number;
  y: number;
  z: number;
  yaw: number;
  width: number;
  depth: number;
  doorId: number;
  /** Where survivors gather to trigger the chapter end. */
  gatherX: number;
  gatherY: number;
  gatherZ: number;
  radius: number;
  label: string;
}

export interface PlayerSpawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface LevelLayout {
  chapter: ChapterDef;
  /** One merged geometry per material — the entire level is a handful of draws. */
  batches: Map<MaterialKey, THREE.BufferGeometry>;
  doors: DoorDef[];
  lights: LightDef[];
  triggers: TriggerDef[];
  itemSpots: ItemSpot[];
  spawnAnchors: SpawnAnchor[];
  decals: DecalDef[];
  breakables: BreakableDef[];
  entitySpawns: { variant: ZombieVariant; x: number; y: number; z: number; yaw: number }[];
  route: THREE.Vector3[];
  routeLength: number;
  playerSpawn: PlayerSpawn;
  safeRoom: SafeRoomDef;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number; maxY: number };
  stats: {
    buildings: number;
    rooms: number;
    boxes: number;
    triangles: number;
    buildMs: number;
  };
}
