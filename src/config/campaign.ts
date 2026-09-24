/**
 * CAMPAIGN DEFINITION
 * ===================
 * Five chapters of the "Deadlight" campaign. Each chapter is a set of
 * *parameters*, not a hand-placed level: `world/Generator.ts` turns the seed
 * plus the theme into a complete city deterministically. That is what lets the
 * campaign ship five distinct, replayable maps without five maps' worth of
 * authored assets — and it is also what will let co-op clients reconstruct the
 * identical level from a shared seed (see `docs/MULTIPLAYER.md`).
 *
 * Reading guide
 * -------------
 *  - `theme`: everything the generator and renderer need — sun and fog, grade,
 *    weather, palette, building heights, prop density. Change a number here and
 *    the whole chapter changes mood and layout.
 *  - `director`: the pacing knobs for this chapter (horde size, specials, how
 *    many Tanks/Witches are budgeted, how long the breathers are).
 *  - `events`: scripted set pieces pinned to route progress. These are the
 *    memorable moments ("the horde at the overpass"), and they are expressed in
 *    the same spawn system the Director uses, just pre-scheduled.
 */

import type { MaterialKey } from '@/render/Materials';

/** Prop vocabulary understood by the generator's prop table. */
export type PropKind =
  | 'car'
  | 'van'
  | 'truck'
  | 'bus'
  | 'dumpster'
  | 'barrel'
  | 'crate'
  | 'pallet'
  | 'cone'
  | 'bench'
  | 'fence'
  | 'streetlight'
  | 'utility_pole'
  | 'tree'
  | 'bush'
  | 'hydrant'
  | 'sign'
  | 'ac_unit'
  | 'pipe'
  | 'sandbag'
  | 'generator'
  | 'shelf'
  | 'desk'
  | 'bed'
  | 'locker'
  | 'table'
  | 'couch'
  | 'counter'
  | 'tent'
  | 'gurney'
  | 'planter'
  | 'bus_stop'
  | 'billboard'
  | 'barricade'
  | 'debris';

export type Weather = 'clear' | 'overcast' | 'fog' | 'rain' | 'storm' | 'snow';

/** Colour grading parameters consumed by the compositor shader. */
export interface GradeDef {
  /** Black point lift (foggy/hazy look). */
  lift: number;
  /** White point gain (bright, blown-out look). */
  gain: number;
  gamma: number;
  saturation: number;
  contrast: number;
  /** RGB tint applied after grading. */
  tint: number;
}

/**
 * Everything that makes a chapter look and feel different. The generator reads
 * the structural fields (storeys, materials, density); the renderer reads the
 * lighting fields.
 */
export interface LevelTheme {
  // --- lighting / atmosphere (renderer) ------------------------------------
  fogColor: number;
  fogDensity: number;
  skyColor: number;
  sunColor: number;
  sunIntensity: number;
  sunAzimuth: number;
  sunElevation: number;
  /** Amount of atmospheric haze near the horizon. */
  haze: number;
  grade: GradeDef;
  vignette: number;
  /** Ambient light colour used by the engine's hemisphere light. */
  ambientColor: number;
  ambientIntensity: number;
  /** 0 = daylight interiors, 1 = pitch black without a flashlight. */
  interiorDarkness: number;
  weather: Weather;

  // --- structure / palette (generator) -------------------------------------
  /** Wall material rotation — the generator picks one per building. */
  wallMats: MaterialKey[];
  /** Interior floor material. */
  floorMat: MaterialKey;
  /** Building roof / slab material. */
  roofMat: MaterialKey;
  /** Terrain under everything (dirt, grass, asphalt). */
  groundMat: MaterialKey;
  /** Street surfaces. */
  roadMat: MaterialKey;
  /** Kerbs, pavements and steps. */
  sidewalkMat: MaterialKey;
  /** Colour multipliers applied to building batches. */
  buildingTints: number[];
  buildingMinStoreys: number;
  buildingMaxStoreys: number;
  /** Fraction of the map that is interior space (buildings vs. streets). */
  interiorRatio: number;
  /** Interior lamp colour. */
  interiorLight: number;
  /** Chance a room gets furniture (0 = empty shells). */
  furnishChance: number;
  /** Chance a street light is placed at an intersection. */
  streetLightChance: number;
  streetLightColor: number;
  /** Trees per 100 m² (0 = none, 4 = forest). */
  trees: number;
  /** Loose debris/vehicle density multiplier. */
  clutter: number;
  /** Chance a block is fenced/barricaded rather than open. */
  barricadeChance: number;
  /** Add a collapsed highway/overpass across the map. */
  overpass?: boolean;
  /** Add drainage tunnels under the streets. */
  sewers?: boolean;
}

/** Director pacing overrides per chapter (see `director/DirectorConfig.ts`). */
export interface DirectorOverrides {
  /** Total Tanks budgeted for the chapter. */
  tanks: number;
  /** Total Witches budgeted for the chapter. */
  witches: number;
  /** Maximum specials alive at once. */
  maxSpecials: number;
  /** Multiplier on per-special cooldowns (>1 = rarer). */
  specialCooldown: number;
  /** Multiplier on horde size. */
  hordeSize: number;
  /** Multiplier on spawn credit earned per second. */
  budgetScale: number;
  /** Multiplier on how fast intensity rises. */
  pacing: number;
  /** Multiplier on the relax phase (higher = longer breathers). */
  relaxRate: number;
}

/** A scripted set piece triggered by squad progress along the route. */
export interface LevelEventDef {
  /** Route progress (0..1) that fires this event. */
  atRouteT: number;
  kind: 'horde' | 'tank' | 'witch' | 'alarm' | 'ambush' | 'gauntlet' | 'final_defence';
  /** Display name used in the objective banner. */
  name: string;
  /** Objective text shown to the player while the event runs. */
  objective: string;
  /** Lateral offset in metres from the route point. */
  offset: number;
  /** Spawn budget scale for this event. */
  waveScale: number;
}

export interface ChapterDef {
  index: number;
  name: string;
  campaign: string;
  /** Narrative framing shown on the loading screen. */
  brief: string;
  /** Text shown when the safe room is reached. */
  outro: string;
  /** Label rendered above the safe-room door. */
  safeRoomLabel: string;
  /** Deterministic generator seed. */
  seed: number;
  /** Playable area edge length in metres. */
  size: number;
  theme: LevelTheme;
  director: DirectorOverrides;
  events: LevelEventDef[];
  /** Extra difficulty ramp for the campaign curve. */
  difficultyScale: number;
  /** Target completion time, used for pacing and the stats screen. */
  targetMinutes: number;
  /**
   * Tier-1 weapon the squad starts the chapter with (`weaponDef` id). Chapters
   * open with something weak and let the loot tables hand out the good stuff —
   * the tier-1 → tier-2 progression of the genre. `null` starts pistol-only.
   */
  startPrimary: string | null;
  /** Finale chapters never fully relax. */
  finale?: boolean;
}

const grade = (o: Partial<GradeDef>): GradeDef => ({
  lift: 0.01,
  gain: 1.05,
  gamma: 1,
  saturation: 0.86,
  contrast: 1.06,
  tint: 0xffffff,
  ...o,
});

/** The campaign, in order. Index 0 introduces the game, index 4 ends it. */
export const CAMPAIGN: ChapterDef[] = [
  {
    index: 0,
    name: 'Dead Awakening',
    campaign: 'Deadlight',
    brief:
      'Four days since the outbreak. We move at first light toward the river crossing. Stay close, stay quiet, and shoot only what is in front of you.',
    outro:
      'Bridge checkpoint secured. It is not an evac bird, but it is above the waterline and it has walls.',
    safeRoomLabel: 'RIVER STATION',
    seed: 0x5eed01,
    size: 118,
    startPrimary: 'smg_compact',
    theme: {
      fogColor: 0xaea79a,
      fogDensity: 0.013,
      skyColor: 0x8fa4bb,
      sunColor: 0xfff2d6,
      sunIntensity: 1.9,
      sunAzimuth: 118,
      sunElevation: 34,
      haze: 0.45,
      grade: grade({ saturation: 0.9, lift: 0.015, gain: 1.02, tint: 0xffffff }),
      vignette: 0.42,
      ambientColor: 0x8fa6c4,
      ambientIntensity: 0.72,
      interiorDarkness: 0.35,
      weather: 'overcast',
      wallMats: ['plaster', 'brick', 'concrete'],
      floorMat: 'wood',
      groundMat: 'dirt',
      roadMat: 'asphalt',
      sidewalkMat: 'concrete',
      roofMat: 'roof',
      buildingTints: [0xffffff, 0xf6efe4, 0xe8e2d6],
      buildingMinStoreys: 1,
      buildingMaxStoreys: 2,
      interiorRatio: 0.24,
      interiorLight: 0xfff0d0,
      furnishChance: 0.42,
      streetLightChance: 0.35,
      streetLightColor: 0xffdcae,
      trees: 1.3,
      clutter: 0.8,
      barricadeChance: 0.12,
    },
    director: { tanks: 0, witches: 0, maxSpecials: 1, specialCooldown: 1.5, hordeSize: 0.7, budgetScale: 0.55, pacing: 0.8, relaxRate: 1.2 },
    events: [
      {
        atRouteT: 0.34,
        kind: 'ambush',
        name: 'Pharmacy Alley',
        objective: 'Clear the alley and keep moving',
        offset: 0,
        waveScale: 0.5,
      },
      {
        atRouteT: 0.72,
        kind: 'gauntlet',
        name: 'Last Stretch',
        objective: 'Reach the river station',
        offset: 0,
        waveScale: 0.7,
      },
    ],
    difficultyScale: 0.55,
    targetMinutes: 12,
  },
  {
    index: 1,
    name: 'The Undercity',
    campaign: 'Deadlight',
    brief:
      'The streets are choked. Our window is the maintenance tunnels under Sixth — dark, wet, and full of things that hear better than they see.',
    outro:
      'Out of the tunnels and into the churchyard. Whatever was down there did not follow us into the light.',
    safeRoomLabel: 'CHAPEL',
    seed: 0x5eed02,
    size: 132,
    theme: {
      fogColor: 0x2b2f36,
      fogDensity: 0.026,
      skyColor: 0x1a1f28,
      sunColor: 0x6a7d9a,
      sunIntensity: 0.18,
      sunAzimuth: 250,
      sunElevation: 8,
      haze: 0.6,
      grade: grade({ saturation: 0.7, lift: 0.02, gain: 1.12, contrast: 1.12, tint: 0xd8e4ff }),
      vignette: 0.62,
      ambientColor: 0x2c3a4e,
      ambientIntensity: 0.2,
      interiorDarkness: 0.82,
      weather: 'rain',
      wallMats: ['brick', 'concrete', 'tile'],
      floorMat: 'tile',
      groundMat: 'gravel',
      roadMat: 'asphalt',
      sidewalkMat: 'concrete',
      roofMat: 'concrete',
      buildingTints: [0xdfe3e8, 0xc8ccd2, 0xb0b4bb],
      buildingMinStoreys: 1,
      buildingMaxStoreys: 3,
      interiorRatio: 0.52,
      interiorLight: 0xffd9a0,
      furnishChance: 0.7,
      streetLightChance: 0.6,
      streetLightColor: 0xffc98a,
      trees: 0.3,
      clutter: 1.25,
      barricadeChance: 0.32,
      sewers: true,
    },
    director: { tanks: 0, witches: 1, maxSpecials: 2, specialCooldown: 1.15, hordeSize: 0.9, budgetScale: 0.85, pacing: 0.95, relaxRate: 1 },
    events: [
      {
        atRouteT: 0.22,
        kind: 'horde',
        name: 'Tunnel Breach',
        objective: 'Hold them off and move deeper',
        offset: 0,
        waveScale: 0.8,
      },
      {
        atRouteT: 0.5,
        kind: 'alarm',
        name: 'Generator Room',
        objective: 'Kill the noise — smash the generator',
        offset: 6,
        waveScale: 0.9,
      },
      {
        atRouteT: 0.8,
        kind: 'gauntlet',
        name: 'Chapel Stairs',
        objective: 'Get to the chapel',
        offset: 0,
        waveScale: 1.05,
      },
    ],
    difficultyScale: 0.85,
    startPrimary: 'shotgun_pump',
    targetMinutes: 15,
  },
  {
    index: 2,
    name: 'Riverside Dusk',
    campaign: 'Deadlight',
    brief:
      'The river road is clear for two miles, then it is a graveyard of cars. We take the maintenance track along the water and we do not cross the fields after dark.',
    outro: 'Substation secured. There is power here and the gate holds. First real rest since the tunnels.',
    safeRoomLabel: 'SUBSTATION',
    seed: 0x5eed03,
    size: 150,
    theme: {
      fogColor: 0x6d5c56,
      fogDensity: 0.021,
      skyColor: 0x8a6a5c,
      sunColor: 0xffb37a,
      sunIntensity: 0.8,
      sunAzimuth: 268,
      sunElevation: 7,
      haze: 0.75,
      grade: grade({ saturation: 0.82, lift: 0.02, gain: 1.06, contrast: 1.08, tint: 0xffe6cc }),
      vignette: 0.6,
      ambientColor: 0x6a6a78,
      ambientIntensity: 0.36,
      interiorDarkness: 0.6,
      weather: 'fog',
      wallMats: ['wood', 'plaster', 'brick'],
      floorMat: 'wood',
      groundMat: 'grass',
      roadMat: 'dirt',
      sidewalkMat: 'gravel',
      roofMat: 'roof',
      buildingTints: [0xf0e2cc, 0xdccdb4, 0xc8b79c],
      buildingMinStoreys: 1,
      buildingMaxStoreys: 2,
      interiorRatio: 0.3,
      interiorLight: 0xffd9a8,
      furnishChance: 0.55,
      streetLightChance: 0.3,
      streetLightColor: 0xffd0a0,
      trees: 3.4,
      clutter: 1.1,
      barricadeChance: 0.24,
    },
    director: { tanks: 1, witches: 3, maxSpecials: 2, specialCooldown: 1, hordeSize: 1, budgetScale: 1, pacing: 1.05, relaxRate: 0.95 },
    events: [
      {
        atRouteT: 0.26,
        kind: 'witch',
        name: 'The Ditch',
        objective: 'Do not disturb it — move past quietly',
        offset: 5,
        waveScale: 0.6,
      },
      {
        atRouteT: 0.55,
        kind: 'horde',
        name: 'Tree Line',
        objective: 'Survive the field crossing',
        offset: 0,
        waveScale: 1.05,
      },
      {
        atRouteT: 0.84,
        kind: 'tank',
        name: 'Tank on the Track',
        objective: 'Survive and reach the substation',
        offset: 0,
        waveScale: 1.1,
      },
    ],
    difficultyScale: 1.05,
    startPrimary: 'ar_carbine',
    targetMinutes: 17,
  },
  {
    index: 3,
    name: 'Downtown Storm',
    campaign: 'Deadlight',
    brief:
      'Downtown is a trap and we are walking into it. The radio tower is still transmitting; the transmitter is on the thirty-first floor and the stairs are the only way up.',
    outro: 'Message sent, and someone answered. They asked us to hold until dawn.',
    safeRoomLabel: 'RADIO TOWER',
    seed: 0x5eed04,
    size: 165,
    theme: {
      fogColor: 0x1d2029,
      fogDensity: 0.03,
      skyColor: 0x121620,
      sunColor: 0x53617a,
      sunIntensity: 0.12,
      sunAzimuth: 200,
      sunElevation: 5,
      haze: 0.7,
      grade: grade({ saturation: 0.66, lift: 0.025, gain: 1.16, contrast: 1.16, tint: 0xc8d8ff }),
      vignette: 0.7,
      ambientColor: 0x24303f,
      ambientIntensity: 0.16,
      interiorDarkness: 0.88,
      weather: 'storm',
      wallMats: ['concrete', 'glass', 'tile', 'metal'],
      floorMat: 'tile',
      groundMat: 'concrete',
      roadMat: 'asphalt',
      sidewalkMat: 'concrete',
      roofMat: 'concrete',
      buildingTints: [0xbcc0c6, 0xa0a4ac, 0x8a8f98],
      buildingMinStoreys: 2,
      buildingMaxStoreys: 4,
      interiorRatio: 0.6,
      interiorLight: 0xdbeaff,
      furnishChance: 0.78,
      streetLightChance: 0.65,
      streetLightColor: 0xffcf9a,
      trees: 0.2,
      clutter: 1.35,
      barricadeChance: 0.4,
    },
    director: { tanks: 1, witches: 2, maxSpecials: 3, specialCooldown: 0.85, hordeSize: 1.15, budgetScale: 1.2, pacing: 1.15, relaxRate: 0.9 },
    events: [
      {
        atRouteT: 0.18,
        kind: 'horde',
        name: 'Both Sides of the Street',
        objective: 'Push through the horde',
        offset: 0,
        waveScale: 1.1,
      },
      {
        atRouteT: 0.46,
        kind: 'ambush',
        name: 'Ceiling Collapse',
        objective: 'Survive the ambush',
        offset: 4,
        waveScale: 1.15,
      },
      {
        atRouteT: 0.62,
        kind: 'tank',
        name: 'Lobby Tank',
        objective: 'Fall back to the stairwell',
        offset: 0,
        waveScale: 1.2,
      },
      {
        atRouteT: 0.88,
        kind: 'gauntlet',
        name: 'Thirty Floors',
        objective: 'Reach the radio room',
        offset: 0,
        waveScale: 1.3,
      },
    ],
    difficultyScale: 1.25,
    startPrimary: 'ar_ak',
    targetMinutes: 20,
  },
  {
    index: 4,
    name: 'Deadlight Dawn',
    campaign: 'Deadlight',
    brief:
      'Evacuation is by boat, under the suspension bridge, at first light. The highway is packed with abandoned traffic and everything that used to drive it. This is the last run.',
    outro: 'Aboard, everyone accounted for, Deadlight behind us — nothing but open water ahead.',
    safeRoomLabel: 'EXTRACTION',
    seed: 0x5eed05,
    size: 180,
    theme: {
      fogColor: 0x4a4f5c,
      fogDensity: 0.025,
      skyColor: 0x6a7183,
      sunColor: 0xffd7ae,
      sunIntensity: 0.45,
      sunAzimuth: 92,
      sunElevation: 6,
      haze: 0.8,
      grade: grade({ saturation: 0.78, lift: 0.02, gain: 1.1, contrast: 1.12, tint: 0xffe8d0 }),
      vignette: 0.68,
      ambientColor: 0x5b6376,
      ambientIntensity: 0.32,
      interiorDarkness: 0.7,
      weather: 'fog',
      wallMats: ['concrete', 'metal', 'brick'],
      floorMat: 'asphalt',
      groundMat: 'gravel',
      roadMat: 'asphalt',
      sidewalkMat: 'concrete',
      roofMat: 'concrete',
      buildingTints: [0xd6d2ca, 0xc0bbb2, 0xaaa49a],
      buildingMinStoreys: 1,
      buildingMaxStoreys: 3,
      interiorRatio: 0.28,
      interiorLight: 0xffdcb0,
      furnishChance: 0.6,
      streetLightChance: 0.5,
      streetLightColor: 0xffc890,
      trees: 0.8,
      clutter: 1.6,
      barricadeChance: 0.5,
      overpass: true,
    },
    director: { tanks: 2, witches: 2, maxSpecials: 4, specialCooldown: 0.7, hordeSize: 1.35, budgetScale: 1.45, pacing: 1.3, relaxRate: 0.75 },
    events: [
      {
        atRouteT: 0.14,
        kind: 'horde',
        name: 'They Are Behind Us',
        objective: 'Outrun the horde along the highway',
        offset: 0,
        waveScale: 1.2,
      },
      {
        atRouteT: 0.4,
        kind: 'tank',
        name: 'Tank on the Overpass',
        objective: 'Get under cover and survive',
        offset: 0,
        waveScale: 1.3,
      },
      {
        atRouteT: 0.58,
        kind: 'gauntlet',
        name: 'Wreckage',
        objective: 'Do not stop for anything',
        offset: 0,
        waveScale: 1.4,
      },
      {
        atRouteT: 0.76,
        kind: 'tank',
        name: 'Second Tank',
        objective: 'Keep moving toward the extraction point',
        offset: 0,
        waveScale: 1.4,
      },
      {
        atRouteT: 0.92,
        kind: 'final_defence',
        name: 'Last Stand',
        objective: 'Hold the dock until the boat arrives',
        offset: 0,
        waveScale: 1.6,
      },
    ],
    difficultyScale: 1.4,
    startPrimary: 'rifle_scoped',
    targetMinutes: 22,
    finale: true,
  },
];

export const CAMPAIGN_LENGTH = CAMPAIGN.length;

export function chapterDef(index: number): ChapterDef {
  return CAMPAIGN[Math.max(0, Math.min(CAMPAIGN.length - 1, Math.floor(index)))];
}

/** Narrative lines used by the safe-room screen, loading tips and AI voice. */
export const NARRATIVE = {
  loadingTips: [
    'Reload behind cover — it is faster than reloading in the open.',
    'A pipe bomb is a rescue, not a weapon. Save it for when a teammate is pinned.',
    'Shove an infected away if it grabs you; it buys the seconds your team needs.',
    'Melee kills are silent. Sometimes silence is worth more than a magazine.',
    'Boomers do not want to hurt you. They want to mark you. Do not let them.',
    'Hunters crouch before they pounce. If you see the crouch, shoot first.',
    'Witches leave you alone if you leave them alone. Do not shine a light at one.',
    'Being split up is the most dangerous thing a squad can do.',
    'A rescue is always worth more than a kill.',
    'The Director listens: push on when hurt and it will back off.',
  ],
  endScreenTitles: {
    survived: 'CHAPTER CLEARED',
    died: 'CHAPTER FAILED',
  },
  radio: {
    start: (name: string) => `Entering ${name}. Keep it tight.`,
    quarter: 'Quarter of the way. Still breathing.',
    half: 'Halfway. We can do this.',
    threeQuarter: 'Almost there. Not long now.',
    arrived: 'Safe room ahead — get inside and lock it.',
  },
} as const;

export type { ChapterDef as ChapterDefinition };
