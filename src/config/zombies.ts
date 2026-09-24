/**
 * INFECTED / SURVIVOR BALANCE DATA
 * ================================
 * Every zombie archetype, teammate personality and global combat constant lives
 * here. The Director reads `cost`/`weight` values from this file when budgeting
 * a horde, so adding a new special infected only requires a new entry plus a
 * spawn hook in `entities/Zombie.ts`.
 */
import type { HitZone } from '@/core/Types';

export type ZombieVariant =
  | 'common'
  | 'common_fast'
  | 'common_armoured'
  | 'boomer'
  | 'hunter'
  | 'smoker'
  | 'spitter'
  | 'jockey'
  | 'charger'
  | 'tank'
  | 'witch';

export type SpecialVariant = Exclude<ZombieVariant, 'common' | 'common_fast' | 'common_armoured'>;

export interface ZombieDef {
  variant: ZombieVariant;
  name: string;
  /** True for the "boss" specials that get their own spawn rules and HUD cue. */
  special: boolean;
  /** Director budget cost (commons cost 1). */
  cost: number;
  health: number;
  /** Damage per melee swipe (or per second for continuous damage). */
  attackDamage: number;
  /** Seconds between attacks / swipes. */
  attackInterval: number;
  /** Melee reach in metres. */
  attackRange: number;
  /** How fast the attack telegraph lasts (wind-up before the hit lands). */
  attackWindup: number;
  /** Movement speed (walk / run). Commons shamble then charge when close. */
  walkSpeed: number;
  runSpeed: number;
  /** How quickly the agent rotates toward its facing direction (rad/s). */
  turnRate: number;
  /** Metres of eye height — used for hit tests and head-shot zone size. */
  height: number;
  radius: number;
  mass: number;
  /** Damage required to stagger (0 = never staggers). */
  staggerThreshold: number;
  /** Seconds the stagger lasts. */
  staggerTime: number;
  /** Health lost per second while on fire. */
  fireVulnerability: number;
  /** Damage multiplier applied per hit zone. */
  zoneMultipliers: Partial<Record<HitZone, number>>;
  /** How far the agent can "see" a survivor. */
  sightRange: number;
  /** How far gunfire noise reaches this variant. */
  hearingRange: number;
  /** Attack behaviour hooked into the AI state machine. */
  attack: 'claw' | 'pounce' | 'explode' | 'tongue' | 'acid' | 'ride' | 'charge' | 'fist' | 'dormant';
  /** Ability tuning per archetype. */
  ability?: {
    /** Hunter pounce. */
    pounceRange?: number;
    pounceSpeed?: number;
    pounceMaxTime?: number;
    pounceDamage?: number;
    /** Smoker tongue. */
    tongueRange?: number;
    tongueSpeed?: number;
    tongueDamagePerSec?: number;
    /** Spitter acid. */
    acidPoolRadius?: number;
    acidDamagePerSec?: number;
    acidDuration?: number;
    acidRange?: number;
    /** Boomer bile. */
    bileRadius?: number;
    bileDuration?: number;
    /** Charger charge. */
    chargeSpeed?: number;
    chargeRange?: number;
    chargeDamage?: number;
    chargeDuration?: number;
    /** Jockey ride. */
    rideDamagePerSec?: number;
    rideDuration?: number;
    jumpSpeed?: number;
    /** Tank rock throw. */
    rockRange?: number;
    rockDamage?: number;
    rockCooldown?: number;
    /** Witch. */
    aggroRadius?: number;
    frenzyDamage?: number;
  };
  /** Sound cues: proximity hints the player learns to fear. */
  sfx: {
    idle: string;
    attack: string;
    hurt: string;
    die: string;
    /** Distance at which the "special infected nearby" stinger starts playing. */
    cueDistance: number;
    voicePitch: number;
  };
  /** Visual recipe consumed by the instanced renderer. */
  look: {
    skin: number;
    clothes: number;
    /** Body scale (commons vary, specials are big/lean). */
    heightScale: number;
    widthScale: number;
    /** Extra emissive bits (spitter glow, tank eyes). */
    emissive?: number;
    emissiveIntensity?: number;
    /** Distinct silhouette markers. */
    hump?: boolean;
    tongue?: boolean;
    longArms?: boolean;
    /** 0 = naked, 1 = fully clothed detail level. */
    gore: number;
    /** Armour plates render as metal. */
    armour?: boolean;
  };
  /** Randomised pitch/state flavour so masses of identical zombies still feel varied. */
  flavour: {
    /** Adds a per-instance speed jitter (±fraction). */
    speedJitter: number;
    /** Chance this common spawns as a "crawler" (missing legs, slower, low profile). */
    crawlerChance: number;
    /** Chance to spawn idle/standing rather than already shambling. */
    idleChance: number;
  };
}

const commonZoneMult: Partial<Record<HitZone, number>> = { head: 4, torso: 1, limb: 0.55 };

const commonFlavour = { speedJitter: 0.22, crawlerChance: 0.07, idleChance: 0.15 };

export const ZOMBIES: Record<ZombieVariant, ZombieDef> = {
  common: {
    variant: 'common',
    name: 'Infected',
    special: false,
    cost: 1,
    health: 60,
    attackDamage: 8,
    attackInterval: 1.15,
    attackRange: 1.5,
    attackWindup: 0.42,
    walkSpeed: 0.9,
    runSpeed: 3.35,
    turnRate: 3.2,
    height: 1.78,
    radius: 0.34,
    mass: 78,
    staggerThreshold: 20,
    staggerTime: 0.34,
    fireVulnerability: 22,
    zoneMultipliers: commonZoneMult,
    sightRange: 45,
    hearingRange: 55,
    attack: 'claw',
    sfx: { idle: 'zombie_moan', attack: 'zombie_attack', hurt: 'zombie_hurt', die: 'zombie_die', cueDistance: 0, voicePitch: 1 },
    look: { skin: 0x8d9a7e, clothes: 0x4e5348, heightScale: 1, widthScale: 1, gore: 0.7 },
    flavour: commonFlavour,
  },

  common_fast: {
    variant: 'common_fast',
    name: 'Runner',
    special: false,
    cost: 1,
    health: 45,
    attackDamage: 7,
    attackInterval: 0.95,
    attackRange: 1.5,
    attackWindup: 0.3,
    walkSpeed: 1.4,
    runSpeed: 4.15,
    turnRate: 4.2,
    height: 1.72,
    radius: 0.32,
    mass: 68,
    staggerThreshold: 14,
    staggerTime: 0.4,
    fireVulnerability: 26,
    zoneMultipliers: commonZoneMult,
    sightRange: 55,
    hearingRange: 70,
    attack: 'claw',
    sfx: { idle: 'zombie_moan_fast', attack: 'zombie_attack', hurt: 'zombie_hurt', die: 'zombie_die', cueDistance: 0, voicePitch: 1.22 },
    look: { skin: 0x8fa07a, clothes: 0x5a4c3a, heightScale: 0.98, widthScale: 0.93, gore: 1 },
    flavour: { speedJitter: 0.16, crawlerChance: 0.02, idleChance: 0.05 },
  },

  common_armoured: {
    variant: 'common_armoured',
    name: 'Riot Infected',
    special: false,
    cost: 3,
    health: 210,
    attackDamage: 12,
    attackInterval: 1.35,
    attackRange: 1.6,
    attackWindup: 0.48,
    walkSpeed: 1,
    runSpeed: 3.1,
    turnRate: 2.6,
    height: 1.86,
    radius: 0.4,
    mass: 105,
    staggerThreshold: 60,
    staggerTime: 0.25,
    fireVulnerability: 14,
    // Body armour: only head and exposed limbs take full damage.
    zoneMultipliers: { head: 3.2, torso: 0.32, limb: 0.7 },
    sightRange: 45,
    hearingRange: 50,
    attack: 'claw',
    sfx: { idle: 'zombie_moan_deep', attack: 'zombie_attack', hurt: 'impact_metal', die: 'zombie_die', cueDistance: 0, voicePitch: 0.82 },
    look: { skin: 0x7c8574, clothes: 0x2f3438, heightScale: 1.05, widthScale: 1.16, gore: 0.4, armour: true },
    flavour: { speedJitter: 0.1, crawlerChance: 0, idleChance: 0.1 },
  },

  // -------------------------------------------------------------------------
  // SPECIAL INFECTED
  // -------------------------------------------------------------------------
  hunter: {
    variant: 'hunter',
    name: 'Hunter',
    special: true,
    cost: 12,
    health: 250,
    attackDamage: 12,
    attackInterval: 1.05,
    attackRange: 1.6,
    attackWindup: 0.25,
    walkSpeed: 2.6,
    runSpeed: 6.4,
    turnRate: 5.5,
    height: 1.72,
    radius: 0.34,
    mass: 70,
    staggerThreshold: 45,
    staggerTime: 0.45,
    fireVulnerability: 24,
    zoneMultipliers: { head: 3.4, torso: 1, limb: 0.6 },
    sightRange: 70,
    hearingRange: 80,
    attack: 'pounce',
    ability: { pounceRange: 26, pounceSpeed: 17, pounceMaxTime: 2.4, pounceDamage: 18 },
    sfx: { idle: 'hunter_idle', attack: 'hunter_pounce', hurt: 'zombie_hurt', die: 'hunter_die', cueDistance: 34, voicePitch: 1.35 },
    look: { skin: 0x9aa87f, clothes: 0x30362c, heightScale: 1, widthScale: 0.92, hump: true, gore: 1, emissive: 0x2a1a08, emissiveIntensity: 0.5 },
    flavour: { speedJitter: 0.05, crawlerChance: 0, idleChance: 0.4 },
  },

  boomer: {
    variant: 'boomer',
    name: 'Boomer',
    special: true,
    cost: 10,
    health: 170,
    attackDamage: 4,
    attackInterval: 1.6,
    attackRange: 2,
    attackWindup: 0.5,
    walkSpeed: 0.85,
    runSpeed: 2.35,
    turnRate: 2.2,
    height: 1.92,
    radius: 0.52,
    mass: 165,
    staggerThreshold: 30,
    staggerTime: 0.5,
    fireVulnerability: 30,
    zoneMultipliers: { head: 2.6, torso: 1, limb: 0.7 },
    sightRange: 42,
    hearingRange: 55,
    attack: 'explode',
    ability: { bileRadius: 9, bileDuration: 12 },
    sfx: { idle: 'boomer_idle', attack: 'boomer_attack', hurt: 'boomer_hurt', die: 'boomer_explode', cueDistance: 30, voicePitch: 0.72 },
    look: { skin: 0x9dae6e, clothes: 0x5b6132, heightScale: 1.12, widthScale: 1.42, hump: true, gore: 1, emissive: 0x3a3a0a, emissiveIntensity: 0.35 },
    flavour: { speedJitter: 0.06, crawlerChance: 0, idleChance: 0.35 },
  },

  smoker: {
    variant: 'smoker',
    name: 'Smoker',
    special: true,
    cost: 11,
    health: 230,
    attackDamage: 6,
    attackInterval: 1.2,
    attackRange: 1.7,
    attackWindup: 0.35,
    walkSpeed: 1.5,
    runSpeed: 3.4,
    turnRate: 3.2,
    height: 1.88,
    radius: 0.36,
    mass: 88,
    staggerThreshold: 35,
    staggerTime: 0.5,
    fireVulnerability: 26,
    zoneMultipliers: { head: 3, torso: 1, limb: 0.6 },
    sightRange: 65,
    hearingRange: 65,
    attack: 'tongue',
    ability: { tongueRange: 27, tongueSpeed: 42, tongueDamagePerSec: 7 },
    sfx: { idle: 'smoker_idle', attack: 'smoker_tongue', hurt: 'smoker_hurt', die: 'smoker_die', cueDistance: 34, voicePitch: 0.66 },
    look: { skin: 0x8b8f84, clothes: 0x2b2f28, heightScale: 1.06, widthScale: 0.95, hump: true, tongue: true, gore: 1, emissive: 0x1c2410, emissiveIntensity: 0.5 },
    flavour: { speedJitter: 0.05, crawlerChance: 0, idleChance: 0.45 },
  },

  spitter: {
    variant: 'spitter',
    name: 'Spitter',
    special: true,
    cost: 9,
    health: 190,
    attackDamage: 5,
    attackInterval: 1.4,
    attackRange: 1.8,
    attackWindup: 0.4,
    walkSpeed: 1.2,
    runSpeed: 3.0,
    turnRate: 3,
    height: 1.95,
    radius: 0.36,
    mass: 80,
    staggerThreshold: 30,
    staggerTime: 0.45,
    fireVulnerability: 28,
    zoneMultipliers: { head: 3.2, torso: 1, limb: 0.6 },
    sightRange: 58,
    hearingRange: 60,
    attack: 'acid',
    ability: { acidPoolRadius: 4.6, acidDamagePerSec: 13, acidDuration: 9, acidRange: 22 },
    sfx: { idle: 'spitter_idle', attack: 'spitter_spit', hurt: 'spitter_hurt', die: 'spitter_die', cueDistance: 32, voicePitch: 1.5 },
    look: { skin: 0x9aa858, clothes: 0x3c4426, heightScale: 1.1, widthScale: 0.94, hump: true, gore: 1, emissive: 0x6d8f12, emissiveIntensity: 1.1 },
    flavour: { speedJitter: 0.06, crawlerChance: 0, idleChance: 0.35 },
  },

  jockey: {
    variant: 'jockey',
    name: 'Jockey',
    special: true,
    cost: 9,
    health: 200,
    attackDamage: 9,
    attackInterval: 1,
    attackRange: 1.5,
    attackWindup: 0.25,
    walkSpeed: 2.2,
    runSpeed: 5.0,
    turnRate: 6,
    height: 1.42,
    radius: 0.3,
    mass: 62,
    staggerThreshold: 25,
    staggerTime: 0.5,
    fireVulnerability: 30,
    zoneMultipliers: { head: 3.6, torso: 1, limb: 0.65 },
    sightRange: 60,
    hearingRange: 65,
    attack: 'ride',
    ability: { rideDamagePerSec: 11, rideDuration: 9, jumpSpeed: 9.5 },
    sfx: { idle: 'jockey_idle', attack: 'jockey_leap', hurt: 'jockey_hurt', die: 'jockey_die', cueDistance: 30, voicePitch: 1.7 },
    look: { skin: 0x9d9a72, clothes: 0x46483a, heightScale: 0.78, widthScale: 0.9, hump: true, longArms: true, gore: 1 },
    flavour: { speedJitter: 0.08, crawlerChance: 0, idleChance: 0.3 },
  },

  charger: {
    variant: 'charger',
    name: 'Charger',
    special: true,
    cost: 14,
    health: 520,
    attackDamage: 20,
    attackInterval: 1.5,
    attackRange: 1.9,
    attackWindup: 0.5,
    walkSpeed: 1.6,
    runSpeed: 4.4,
    turnRate: 2.6,
    height: 2.15,
    radius: 0.5,
    mass: 220,
    staggerThreshold: 95,
    staggerTime: 0.3,
    fireVulnerability: 20,
    zoneMultipliers: { head: 2.2, torso: 0.85, limb: 0.5 },
    sightRange: 60,
    hearingRange: 70,
    attack: 'charge',
    ability: { chargeSpeed: 13, chargeRange: 22, chargeDamage: 26, chargeDuration: 2.2 },
    sfx: { idle: 'charger_idle', attack: 'charger_charge', hurt: 'charger_hurt', die: 'charger_die', cueDistance: 36, voicePitch: 0.62 },
    look: { skin: 0x8f7f6a, clothes: 0x36302a, heightScale: 1.2, widthScale: 1.5, hump: true, gore: 1, longArms: true },
    flavour: { speedJitter: 0.04, crawlerChance: 0, idleChance: 0.3 },
  },

  tank: {
    variant: 'tank',
    name: 'Tank',
    special: true,
    cost: 60,
    health: 4600,
    attackDamage: 60,
    attackInterval: 2.4,
    attackRange: 3.0,
    attackWindup: 0.6,
    walkSpeed: 2.6,
    runSpeed: 4.9,
    turnRate: 1.9,
    height: 3.1,
    radius: 0.95,
    mass: 900,
    staggerThreshold: 0, // never staggers
    staggerTime: 0,
    fireVulnerability: 9,
    zoneMultipliers: { head: 1.5, torso: 1, limb: 0.7 },
    sightRange: 90,
    hearingRange: 110,
    attack: 'fist',
    ability: { rockRange: 34, rockDamage: 42, rockCooldown: 5.5 },
    sfx: { idle: 'tank_roar', attack: 'tank_swing', hurt: 'tank_hurt', die: 'tank_die', cueDistance: 70, voicePitch: 0.42 },
    look: { skin: 0x8b8570, clothes: 0x54473c, heightScale: 1.72, widthScale: 1.85, hump: true, gore: 1, emissive: 0x3a1508, emissiveIntensity: 0.6 },
    flavour: { speedJitter: 0.03, crawlerChance: 0, idleChance: 0.2 },
  },

  witch: {
    variant: 'witch',
    name: 'Witch',
    special: true,
    cost: 0, // placed by the level designer / Director, not budget-spawned
    health: 1400,
    attackDamage: 90,
    attackInterval: 0.65,
    attackRange: 2.4,
    attackWindup: 0.15,
    walkSpeed: 1.1,
    runSpeed: 5.6,
    turnRate: 5,
    height: 1.68,
    radius: 0.32,
    mass: 62,
    staggerThreshold: 80,
    staggerTime: 0.2,
    fireVulnerability: 26,
    zoneMultipliers: { head: 1.8, torso: 1, limb: 0.8 },
    sightRange: 22,
    hearingRange: 26,
    attack: 'dormant',
    ability: { aggroRadius: 7.5, frenzyDamage: 90 },
    sfx: { idle: 'witch_cry', attack: 'witch_scream', hurt: 'witch_hurt', die: 'witch_die', cueDistance: 28, voicePitch: 1.8 },
    look: { skin: 0xb9b3a8, clothes: 0x6a6560, heightScale: 0.96, widthScale: 0.9, gore: 1, emissive: 0x501010, emissiveIntensity: 0.8 },
    flavour: { speedJitter: 0, crawlerChance: 0, idleChance: 1 },
  },
};

export const COMMON_VARIANTS: ZombieVariant[] = ['common', 'common_fast', 'common_armoured'];
export const SPECIAL_VARIANTS: SpecialVariant[] = ['hunter', 'boomer', 'smoker', 'spitter', 'jockey', 'charger'];

export function zombieDef(v: ZombieVariant): ZombieDef {
  return ZOMBIES[v];
}

// ---------------------------------------------------------------------------
// AI TEAMMATES
// ---------------------------------------------------------------------------

export type PersonalityKind = 'aggressive' | 'supportive' | 'cautious' | 'balanced';

export interface PersonalityDef {
  kind: PersonalityKind;
  name: string;
  /** Metres the teammate tries to keep from the player while following. */
  followDistance: number;
  /** 0..1 — how far forward they push when the squad advances. */
  aggression: number;
  /** 0..1 — how eagerly they heal/revive teammates. */
  altruism: number;
  /** 0..1 — how early they retreat / how carefully they advance. */
  caution: number;
  /** 0..1 — weapon preference weighting toward long range. */
  prefersRange: number;
  /** Base reaction delay before engaging a newly spotted target (s). */
  reactionTime: number;
  /** Aim error radius in degrees (skill). */
  aimError: number;
  /** Chance per second to fire a burst vs. conserve ammo. */
  fireDiscipline: number;
  /** Multiplier on how much they like using throwables/specials calls. */
  utilityUse: number;
  /** Voice line set id. */
  voice: string;
  /** Teammate body colours. */
  look: { skin: number; shirt: number; pants: number; hair: number; accent: number };
}

/**
 * Voice-line cues. A teammate picks a random line from the matching list, so
 * writers can add flavour without touching AI code. The cue names are the
 * vocabulary the AI already reasons in (contact, reloading, grabbed, ...).
 */
export type VoiceCue =
  | 'contact'
  | 'reloading'
  | 'outOfAmmo'
  | 'hurt'
  | 'downed'
  | 'revived'
  | 'healing'
  | 'healed'
  | 'throwing'
  | 'pickupWeapon'
  | 'horde'
  | 'special'
  | 'tank'
  | 'witch'
  | 'grab'
  | 'clear'
  | 'moveUp'
  | 'wait'
  | 'safeRoom'
  | 'thanks'
  | 'sorry';

export const VOICE: Record<VoiceCue, string[]> = {
  contact: ['Contact!', 'Infected, front!', 'I see them!', 'Movement!'],
  reloading: ['Reloading!', 'Cover me, changing mag!', 'Reload — one second!', 'Gonna be dry for a bit!'],
  outOfAmmo: ['I am dry!', 'No ammo left!', 'Need rounds over here!'],
  hurt: ['I am hit!', 'Taking damage!', 'They got me!'],
  downed: ['I am down! Help me up!', 'I am bleeding out!', 'Do not leave me here!'],
  revived: ['Thanks — I am up.', 'Good as new. Let us move.', 'Appreciate it.'],
  healing: ['Patching up.', 'Give me a second, healing.', 'Using a medkit.'],
  healed: ['I am good.', 'Feeling better.', 'That did it.'],
  throwing: ['Fire in the hole!', 'Bomb out!', 'Throwing!'],
  pickupWeapon: ['Taking this gun.', 'Upgrading.', 'I will use this.'],
  horde: ['Here they come!', 'Big group incoming!', 'They are swarming!'],
  special: ['Special incoming!', 'Careful — one of the big ones!', 'Watch the flanks, special up!'],
  tank: ['TANK! Run!', 'Big one — move, move!', 'Tank! Do not let it corner you!'],
  witch: ['Witch ahead — lights off, quiet.', 'Do not wake it.', 'Witch. Go around.'],
  grab: ['It has me! Shoot it!', 'Get it off me!', 'I am grabbed!'],
  clear: ['Clear.', 'That is the last of them.', 'Area is quiet.'],
  moveUp: ['Moving up.', 'Advancing.', 'Pushing forward.'],
  wait: ['Hold here.', 'Wait for the others.', 'Slow down, group up.'],
  safeRoom: ['Safe room ahead!', 'Get inside and lock it!', 'We made it — inside, now!'],
  thanks: ['Thank you.', 'Owe you one.', 'Nice save.'],
  sorry: ['Sorry!', 'My bad.', 'Watch the friendly fire!'],
};

export const SURVIVORS: PersonalityDef[] = [
  {
    kind: 'aggressive',
    name: 'Rook',
    followDistance: 3.2,
    aggression: 0.93,
    altruism: 0.55,
    caution: 0.18,
    prefersRange: 0.3,
    reactionTime: 0.22,
    aimError: 3.4,
    fireDiscipline: 0.85,
    utilityUse: 0.35,
    voice: 'rook',
    look: { skin: 0x9c6b4a, shirt: 0x36393d, pants: 0x2b2f33, hair: 0x1c1a18, accent: 0x8e2a1e },
  },
  {
    kind: 'supportive',
    name: 'Vale',
    followDistance: 4.4,
    aggression: 0.55,
    altruism: 0.95,
    caution: 0.5,
    prefersRange: 0.5,
    reactionTime: 0.3,
    aimError: 4.2,
    fireDiscipline: 0.72,
    utilityUse: 0.8,
    voice: 'vale',
    look: { skin: 0xb98a68, shirt: 0x5a6b4e, pants: 0x3a3f38, hair: 0x4a2f1c, accent: 0xd9d2c0 },
  },
  {
    kind: 'cautious',
    name: 'Callahan',
    followDistance: 5.6,
    aggression: 0.35,
    altruism: 0.7,
    caution: 0.88,
    prefersRange: 0.85,
    reactionTime: 0.36,
    aimError: 2.6,
    fireDiscipline: 0.92,
    utilityUse: 0.6,
    voice: 'callahan',
    look: { skin: 0x7a5a44, shirt: 0x3f4a52, pants: 0x2e3236, hair: 0x2a2622, accent: 0x3f4a52 },
  },
];

/** Global combat constants shared by player + AI damage resolution. */
export const COMBAT = {
  /** Player max health (L4D-style 100). */
  playerMaxHealth: 100,
  /** Temporary health cap (pills can exceed max health). */
  tempHealthMax: 100,
  /** Incapacitated players bleed out over this many seconds. */
  bleedOutTime: 100,
  /** Health restored when a survivor is revived. */
  reviveHealth: 30,
  /** Seconds to revive someone. */
  reviveTime: 4.0,
  /** Health restored to a survivor rescued from a special-infected pin. */
  pinRescueHealth: 20,
  /** Player melee shove cooldown. */
  shoveCooldown: 0.7,
  /** How much noise a shove makes (attracts zombies). */
  shoveNoise: 4,
  /** Zombies within this radius of a "noise" event investigate it. */
  noiseDecaySeconds: 6,
  /** Friendly fire damage multiplier (0 when disabled in settings). */
  friendlyFireMultiplier: 0.4,
  /** Explosions also damage survivors (scaled). */
  explosionFriendlyFire: 0.35,
  /** Seconds of invulnerability after being revived. */
  spawnProtectionTime: 1.5,
  /** Damage a tank rock does to structures. */
  structureDamage: 120,
};

/** Perception: how the AI sees. Tuning these changes difficulty dramatically. */
export const PERCEPTION = {
  /** Degrees of cone the AI z-visibility test uses when idle. */
  fovDegrees: 130,
  /** AI vision can be blocked by walls; this many rays are cast to resolve occlusion. */
  occlusionSamples: 2,
  /** Zombies re-evaluate their target this often (seconds, jittered). */
  zombieRetargetInterval: 0.65,
  /** Teammates re-scan for threats this often. */
  survivorScanInterval: 0.28,
  /** Maximum distance at which a zombie will path toward a noise instead of a survivor. */
  noiseInvestigateMaxMinutes: 4,
};
