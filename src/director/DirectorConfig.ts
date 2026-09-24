/**
 * DIRECTOR & CAMPAIGN TUNING (data only)
 * ======================================
 * Every number a designer would want to touch lives here or in
 * `config/zombies.ts` / `config/weapons.ts`. Nothing in this file is
 * imported by the renderer, so it can be hot-swapped or (for co-op) sent
 * over the wire as the session's ruleset.
 *
 * Reading guide
 * -------------
 *  - `DIRECTOR_BUDGETS`: how much "spawn credit" the Director earns per second
 *    at each mood, and how much it may hold in reserve. This single table is
 *    the pacing curve of the whole game.
 *  - `STAT_SPAWN_CHANCES`: probability weights for each infected archetype at a
 *    given intensity band. Tanks/Witches are not random — the Director spends
 *    them as scripted budget.
 *  - `ITEM_PLACEMENT`: loot density and quality ramps with chapter and mood.
 *  - `DIFFICULTY`: player-facing multipliers.
 */
import type { ZombieVariant } from '@/config/zombies';

export type Mood = 'relax' | 'build' | 'sustain' | 'peak' | 'fade';
export type IntensityBand = 'calm' | 'low' | 'medium' | 'high' | 'extreme';

export interface DirectorBudget {
  /** Spawn credit earned per second while in this mood. */
  creditPerSecond: number;
  /** Maximum credit that can accumulate (burst size). */
  maxCredit: number;
  /** How long the mood lasts at minimum, in seconds. */
  minDuration: number;
  /** Weight for picking this mood next (steering the pacing curve). */
  weight: number;
}

export const DIRECTOR_BUDGETS: Record<Mood, DirectorBudget> = {
  // Breathers are just as important as fights: the player needs silence to
  // notice the ambience, talk to teammates and feel the tension rebuild.
  relax: { creditPerSecond: 0.35, maxCredit: 6, minDuration: 28, weight: 0.5 },
  build: { creditPerSecond: 2.2, maxCredit: 16, minDuration: 24, weight: 2.2 },
  sustain: { creditPerSecond: 4.4, maxCredit: 34, minDuration: 34, weight: 2.0 },
  peak: { creditPerSecond: 7.5, maxCredit: 70, minDuration: 26, weight: 0.9 },
  // Fade is the deliberate wind-down: arrivals slow, stragglers get culled.
  fade: { creditPerSecond: 0.9, maxCredit: 10, minDuration: 18, weight: 1.4 },
};

/** Cost (in credit) to spawn one infected of each archetype. */
export const SPAWN_COST: Record<ZombieVariant, number> = {
  common: 1,
  common_fast: 1.2,
  common_armoured: 2.4,
  hunter: 10,
  boomer: 8,
  smoker: 9,
  spitter: 9,
  jockey: 10,
  charger: 14,
  witch: 22,
  tank: 90,
};

/** Archetype selection weights per intensity band (common infected baseline). */
export const STAT_SPAWN_CHANCES: Record<IntensityBand, Partial<Record<ZombieVariant, number>>> = {
  calm: { common: 1, common_fast: 0.12, boomer: 0.05 },
  low: { common: 1, common_fast: 0.28, common_armoured: 0.06, hunter: 0.1, smoker: 0.08, boomer: 0.06 },
  medium: {
    common: 1,
    common_fast: 0.45,
    common_armoured: 0.14,
    hunter: 0.2,
    smoker: 0.14,
    boomer: 0.11,
    spitter: 0.13,
    jockey: 0.11,
  },
  high: {
    common: 1,
    common_fast: 0.6,
    common_armoured: 0.22,
    hunter: 0.26,
    smoker: 0.18,
    boomer: 0.15,
    spitter: 0.18,
    jockey: 0.16,
    charger: 0.12,
  },
  extreme: {
    common: 1,
    common_fast: 0.72,
    common_armoured: 0.3,
    hunter: 0.3,
    smoker: 0.2,
    boomer: 0.17,
    spitter: 0.22,
    jockey: 0.2,
    charger: 0.18,
  },
};

/** Per-archetype cooldowns so the Director cannot spam two Hunters at once. */
export const SPECIAL_COOLDOWN: Record<ZombieVariant, number> = {
  common: 0,
  common_fast: 0,
  common_armoured: 0,
  hunter: 16,
  boomer: 14,
  smoker: 15,
  spitter: 17,
  jockey: 16,
  charger: 22,
  witch: 45,
  tank: 90,
};

/** Maximum simultaneously alive specials, by intensity band. */
export const MAX_SPECIALS: Record<IntensityBand, number> = {
  calm: 0,
  low: 1,
  medium: 2,
  high: 3,
  extreme: 4,
};

/** Spawn geometry rules: how far from the squad infected appear. */
export const SPAWN_PLACEMENT = {
  /** Minimum distance from the closest survivor (keeps spawns out of sight). */
  minDistance: 16,
  /** Maximum distance — beyond this they are irrelevant. */
  maxDistance: 52,
  /** Distance used when the squad is fighting indoors. */
  minDistanceIndoor: 10,
  /** Minimum distance from the *lead* survivor's view direction... */
  minForwardDot: -0.2,
  /** ...with this many metres of slack, so spawns can happen just behind. */
  forwardGrace: 8,
  /** Attempts to find a valid anchor before giving up on a spawn tick. */
  attempts: 14,
  /** Chance a common spawns directly on reachable ground vs. a "climb-in" spot. */
  climbInChance: 0.25,
};

/** Fine pacing: how the Director reacts to player state. */
export const DIRECTOR_TUNING = {
  /** Player health below this makes the Director relax (mercy). */
  mercyHealth: 35,
  /** Player health above this lets the Director push harder. */
  pressureHealth: 70,
  /** Tempo: score above 1 = the squad is moving fast (Director pushes). */
  fastTempoScore: 38,
  slowTempoScore: 14,
  /** Seconds of no damage before the Director starts building again. */
  calmAfterKillWindow: 6,
  /** How strongly being split up (squad spread) raises intensity. */
  spreadPressure: 0.55,
  /** A survivor pinned/downed instantly raises intensity (drama!). */
  downedSpike: 0.45,
  /** Seconds the Director stops spending budget after the squad nearly wipes. */
  mercyDuration: 22,
  /**
   * Downs inside this window count towards mercy. Two knocks in half a minute
   * is a squad that is losing — the Director should hand them a breath even if
   * three of them are technically still on their feet.
   */
  mercyDownWindow: 30,
  /** Downs within `mercyDownWindow` that open the mercy window. */
  mercyDowns: 2,
  /** Squad-average health below this opens the mercy window. */
  mercySquadHealth: 0.45,
  /** Seconds of quiet contact after which intensity bleeds down again. */
  contactRelaxAfter: 12,
  /** Hard ceiling on how long a single peak may last before a forced fade. */
  maxPeakDuration: 46,
  /** Intensity floor and ceiling. */
  minIntensity: 0.04,
  maxIntensity: 1,
  /** Mood transition smoothing. */
  moodLerp: 0.6,
  /** Seconds the intensity is smoothed over. */
  intensityLerp: 2.4,
  /** Item placement frequency per minute at medium intensity. */
  itemDropInterval: 95,
  /** Maximum common infected that may be "retired" per second out of sight. */
  cullPerSecond: 3,
  /**
   * Live-infected ceiling per mood. The Director spawns against these, and
   * `cull()` actively dissolves the surplus, so the field always matches the
   * mood the player is hearing — this is the difference between "a horde that
   * happened" and "endless spam".
   */
  liveCap: {
    relax: 10,
    build: 16,
    sustain: 26,
    peak: 40,
    fade: 12,
  } as Record<'relax' | 'build' | 'sustain' | 'peak' | 'fade', number>,
  /** Live ceiling while the mercy window is open (the squad nearly wiped). */
  mercyLiveCap: 6,
  /** Culling is allowed to retire this many infected per second when over cap. */
  overCapCullPerSecond: 6,
  /** Infected closer than this to the squad are never culled. */
  cullNearDistance: 32,
  /** When player leaves the level route this far, the Director culls strays. */
  strayDistance: 46,
};

/**
 * Difficulty lives in `core/Settings.ts` (it is a player-facing setting, not a
 * Director internal) and is re-exported here so Director code can import its
 * whole balancing surface from one place.
 */
export { DIFFICULTIES, difficultyDef } from '@/core/Settings';
export type { Difficulty, DifficultyDef } from '@/core/Settings';

/** Ordered from most forgiving to least, for menu cycling. */
export const DIFFICULTY_ORDER: Array<'easy' | 'normal' | 'hard' | 'expert'> = ['easy', 'normal', 'hard', 'expert'];

/** Item placement: how loot density scales through a chapter. */
export const ITEM_PLACEMENT = {
  /** Fraction of route travelled where weapon caches become common. */
  weaponCacheStart: 0.15,
  /** Ammo is more common than health — the campaign's scarcest resource. */
  weights: { ammo: 3, health: 1.6, throwable: 1.1, weapon: 0.8 },
  /** Extra loot at safe rooms and chapter starts. */
  safeRoomStock: { ammo: 2, health: 1, throwable: 1, weapon: 1 },
  /** Chance an ammo pile also contains a throwable. */
  bonusThrowableChance: 0.18,
};

/** Sound/visual intensity thresholds used by the HUD "director meter". */
export const INTENSITY_DISPLAY = {
  bands: [
    { at: 0, label: 'Quiet', color: '#5f7f6a' },
    { at: 0.25, label: 'Stirring', color: '#9aa15a' },
    { at: 0.45, label: 'Rising', color: '#c9a03c' },
    { at: 0.65, label: 'Horde', color: '#d1652b' },
    { at: 0.85, label: 'Overrun', color: '#c0342b' },
  ],
};

export type { ZombieVariant };
