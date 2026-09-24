/**
 * WEAPON / ITEM DEFINITIONS
 * =========================
 * All balance numbers live here so designers can tune without touching systems
 * code. Values are tuned for a "Left 4 Dead"-like feel: quick TTK on commons,
 * heavy commitment on specials, meaningful ammo economy.
 *
 * Units:
 *   damage        — per pellet (shotguns fire `pellets` of this)
 *   cycleMs       — minimum time between shots (60000/RPM)
 *   spreadDeg     — cone half-angle in degrees at hip / while aiming
 *   recoilPitch   — degrees of muzzle rise per shot
 */
import type { SurfaceType } from '@/core/Types';

export type WeaponClass = 'rifle' | 'smg' | 'shotgun' | 'sniper' | 'pistol' | 'melee';
export type WeaponSlot = 'primary' | 'secondary' | 'melee' | 'throwable';
export type AmmoType = 'rifle' | 'smg' | 'shells' | 'sniper' | 'pistol' | 'none';

export interface WeaponDef {
  id: string;
  name: string;
  /** Short label used in the HUD weapon strip. */
  abbr: string;
  slot: WeaponSlot;
  class: WeaponClass;
  ammoType: AmmoType;
  /** Rounds in a full magazine (melee: ignored). */
  magazine: number;
  /** Maximum reserve carried. */
  reserveMax: number;
  /** Reserve given when picked up fresh. */
  reservePickup: number;
  /** Rounds the weapon spawns with when found on the ground. */
  spawnAmmo: number;
  automatic: boolean;
  /** ms between shots. */
  cycleMs: number;
  /** Shots per trigger pull for multi-shell reloads. */
  reloadTimeMs: number;
  /** Reload animation that leaves a chambered round (mag still has 1+). */
  reloadTimeTacticalMs: number;
  damage: number;
  pellets: number;
  /** Damage keeps 100% until `falloffStart`, then lerps to `falloffMin` at `falloffEnd` metres. */
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  /** Degrees of spread at hip, while moving, and while aiming. */
  spreadHip: number;
  spreadMove: number;
  spreadAds: number;
  /** Additional spread per consecutive shot (recoil bloom), decays at spreadDecay/s. */
  spreadPerShot: number;
  spreadDecay: number;
  spreadMax: number;
  recoilPitch: number;
  recoilYaw: number;
  /** How fast the view recovers from recoil. */
  recoilRecovery: number;
  /** Visual kick of the view model (metres). */
  kickback: number;
  /** Aim-down-sights: FOV multiplier and movement speed multiplier. */
  adsFovMultiplier: number;
  adsSensMultiplier: number;
  adsSpeedMultiplier: number;
  /** Muzzle flash size multiplier. */
  flashScale: number;
  /** Bullet energy retained through surfaces (see SurfaceProfile.penetration). */
  penetration: number;
  /** Movement speed multiplier while this weapon is equipped. */
  moveSpeedMul: number;
  /** Number of zombies a single shot can pass through. */
  maxPenetrations: number;
  /** Throwable stats (unused for guns). */
  throwable?: {
    fuseMs: number;
    radius: number;
    damage: number;
    kind: 'pipebomb' | 'molotov' | 'bile';
    /** How far the player can throw at full charge. */
    throwSpeed: number;
  };
  /** Melee stats (unused for guns). */
  melee?: {
    swingMs: number;
    /** Damage is applied at this fraction of the swing. */
    hitAt: number;
    damage: number;
    range: number;
    /** Half-angle of the melee cone, degrees. */
    arc: number;
    /** Zombies hit per swing. */
    targets: number;
    /** Chance to instantly kill a common infected ("cleave"). */
    instakillChance: number;
    shove: boolean;
  };
  /** View-model proportions used by the procedural weapon mesh builder. */
  model: WeaponModelSpec;
  /** Procedurally synthesised audio recipe (see audio/Synth.ts). */
  sfx: {
    shot: string;
    /** Loudness used for zombie noise attraction and audio ducking. */
    loudness: number;
    reload: string;
    dry: string;
  };
}

export interface WeaponModelSpec {
  style: 'rifle' | 'smg' | 'shotgun' | 'sniper' | 'pistol' | 'melee' | 'throwable';
  length: number;
  /** Metres cubed-ish scalar applied to the whole view model. */
  scale: number;
  metalTint: number;
  bodyTint: number;
  barrelRadius: number;
  magazineSize: number;
  stock: boolean;
  scope: boolean;
  /** Melee blade length (metres). */
  blade?: number;
}

const baseGun: Omit<WeaponDef, 'id' | 'name' | 'abbr' | 'slot' | 'class' | 'ammoType' | 'model' | 'sfx'> = {
  magazine: 30,
  reserveMax: 300,
  reservePickup: 120,
  spawnAmmo: 60,
  automatic: true,
  cycleMs: 90,
  reloadTimeMs: 2400,
  reloadTimeTacticalMs: 2000,
  damage: 26,
  pellets: 1,
  falloffStart: 25,
  falloffEnd: 60,
  falloffMin: 0.45,
  spreadHip: 1.7,
  spreadMove: 2.6,
  spreadAds: 0.35,
  spreadPerShot: 0.42,
  spreadDecay: 7,
  spreadMax: 7,
  recoilPitch: 0.75,
  recoilYaw: 0.24,
  recoilRecovery: 12,
  kickback: 0.035,
  adsFovMultiplier: 0.72,
  adsSensMultiplier: 0.62,
  adsSpeedMultiplier: 0.55,
  flashScale: 1,
  penetration: 0.55,
  moveSpeedMul: 0.94,
  maxPenetrations: 1,
};

// ---------------------------------------------------------------------------
// PRIMARY WEAPONS
// ---------------------------------------------------------------------------

export const WEAPONS: Record<string, WeaponDef> = {
  ar_carbine: {
    ...baseGun,
    id: 'ar_carbine',
    name: 'MK-4 Carbine',
    abbr: 'CARBINE',
    slot: 'primary',
    class: 'rifle',
    ammoType: 'rifle',
    magazine: 30,
    reserveMax: 360,
    reservePickup: 150,
    spawnAmmo: 90,
    cycleMs: 88,
    reloadTimeMs: 2450,
    reloadTimeTacticalMs: 2000,
    damage: 27,
    spreadHip: 1.5,
    spreadMove: 2.4,
    spreadAds: 0.28,
    recoilPitch: 0.62,
    recoilYaw: 0.2,
    penetration: 0.6,
    model: {
      style: 'rifle',
      length: 0.62,
      scale: 1,
      metalTint: 0x2b2f31,
      bodyTint: 0x21252a,
      barrelRadius: 0.013,
      magazineSize: 0.1,
      stock: true,
      scope: false,
    },
    sfx: { shot: 'shot_rifle', loudness: 1, reload: 'reload_rifle', dry: 'dry_fire' },
  },

  ar_ak: {
    ...baseGun,
    id: 'ar_ak',
    name: 'AK-74 Service Rifle',
    abbr: 'AK-74',
    slot: 'primary',
    class: 'rifle',
    ammoType: 'rifle',
    magazine: 30,
    reserveMax: 360,
    reservePickup: 150,
    spawnAmmo: 90,
    cycleMs: 82,
    reloadTimeMs: 2700,
    reloadTimeTacticalMs: 2250,
    damage: 34,
    spreadHip: 2.1,
    spreadMove: 3.1,
    spreadAds: 0.5,
    spreadPerShot: 0.55,
    recoilPitch: 0.95,
    recoilYaw: 0.32,
    penetration: 0.7,
    maxPenetrations: 2,
    model: {
      style: 'rifle',
      length: 0.66,
      scale: 1.04,
      metalTint: 0x35352f,
      bodyTint: 0x4a3626,
      barrelRadius: 0.015,
      magazineSize: 0.13,
      stock: true,
      scope: false,
    },
    sfx: { shot: 'shot_ak', loudness: 1.05, reload: 'reload_rifle', dry: 'dry_fire' },
  },

  smg_compact: {
    ...baseGun,
    id: 'smg_compact',
    name: 'K-9 Compact SMG',
    abbr: 'SMG',
    slot: 'primary',
    class: 'smg',
    ammoType: 'smg',
    magazine: 40,
    reserveMax: 480,
    reservePickup: 240,
    spawnAmmo: 160,
    cycleMs: 66,
    reloadTimeMs: 1850,
    reloadTimeTacticalMs: 1550,
    damage: 19,
    falloffStart: 16,
    falloffEnd: 42,
    falloffMin: 0.4,
    spreadHip: 2.4,
    spreadMove: 3.2,
    spreadAds: 0.85,
    spreadPerShot: 0.3,
    recoilPitch: 0.45,
    recoilYaw: 0.26,
    adsFovMultiplier: 0.8,
    penetration: 0.4,
    moveSpeedMul: 0.98,
    model: {
      style: 'smg',
      length: 0.42,
      scale: 0.92,
      metalTint: 0x26292c,
      bodyTint: 0x1d2124,
      barrelRadius: 0.011,
      magazineSize: 0.17,
      stock: false,
      scope: false,
    },
    sfx: { shot: 'shot_smg', loudness: 0.85, reload: 'reload_smg', dry: 'dry_fire' },
  },

  shotgun_pump: {
    ...baseGun,
    id: 'shotgun_pump',
    name: 'Model 870 Pump',
    abbr: 'PUMP',
    slot: 'primary',
    class: 'shotgun',
    ammoType: 'shells',
    magazine: 8,
    reserveMax: 96,
    reservePickup: 48,
    spawnAmmo: 28,
    cycleMs: 820,
    reloadTimeMs: 3200,
    reloadTimeTacticalMs: 2900,
    damage: 21,
    pellets: 9,
    falloffStart: 8,
    falloffEnd: 26,
    falloffMin: 0.22,
    spreadHip: 4.4,
    spreadMove: 5.2,
    spreadAds: 3.2,
    spreadPerShot: 0,
    recoilPitch: 4.2,
    recoilYaw: 0.7,
    recoilRecovery: 9,
    kickback: 0.11,
    adsFovMultiplier: 0.9,
    flashScale: 1.9,
    penetration: 0.25,
    maxPenetrations: 1,
    model: {
      style: 'shotgun',
      length: 0.72,
      scale: 1.06,
      metalTint: 0x2a2b2c,
      bodyTint: 0x4b3320,
      barrelRadius: 0.019,
      magazineSize: 0,
      stock: true,
      scope: false,
    },
    sfx: { shot: 'shot_shotgun', loudness: 1.25, reload: 'reload_shotgun_shell', dry: 'dry_fire' },
  },

  shotgun_auto: {
    ...baseGun,
    id: 'shotgun_auto',
    name: 'AA-12 Combat Shotgun',
    abbr: 'AUTO SG',
    slot: 'primary',
    class: 'shotgun',
    ammoType: 'shells',
    magazine: 10,
    reserveMax: 80,
    reservePickup: 40,
    spawnAmmo: 30,
    cycleMs: 260,
    reloadTimeMs: 3400,
    reloadTimeTacticalMs: 3100,
    damage: 17,
    pellets: 8,
    falloffStart: 7,
    falloffEnd: 22,
    falloffMin: 0.2,
    spreadHip: 5.2,
    spreadMove: 5.8,
    spreadAds: 3.8,
    spreadPerShot: 0,
    recoilPitch: 2.2,
    recoilYaw: 0.5,
    kickback: 0.07,
    adsFovMultiplier: 0.92,
    flashScale: 1.7,
    moveSpeedMul: 0.9,
    model: {
      style: 'shotgun',
      length: 0.6,
      scale: 1.12,
      metalTint: 0x232527,
      bodyTint: 0x2c3033,
      barrelRadius: 0.024,
      magazineSize: 0.16,
      stock: true,
      scope: false,
    },
    sfx: { shot: 'shot_auto_sg', loudness: 1.2, reload: 'reload_mag', dry: 'dry_fire' },
  },

  smg_silenced: {
    ...baseGun,
    id: 'smg_silenced',
    name: 'Mac-10 (Suppressed)',
    abbr: 'SUPP. SMG',
    slot: 'primary',
    class: 'smg',
    ammoType: 'smg',
    magazine: 30,
    reserveMax: 480,
    reservePickup: 210,
    spawnAmmo: 150,
    cycleMs: 72,
    reloadTimeMs: 1900,
    reloadTimeTacticalMs: 1650,
    damage: 22,
    falloffStart: 14,
    falloffEnd: 38,
    falloffMin: 0.42,
    spreadHip: 2.2,
    spreadMove: 3.0,
    spreadAds: 0.7,
    spreadPerShot: 0.34,
    recoilPitch: 0.5,
    recoilYaw: 0.3,
    penetration: 0.45,
    model: {
      style: 'smg',
      length: 0.4,
      scale: 0.9,
      metalTint: 0x212325,
      bodyTint: 0x1a1d1f,
      barrelRadius: 0.015,
      magazineSize: 0.18,
      stock: false,
      scope: false,
    },
    // Suppressed: much quieter noise signature → attracts far fewer zombies.
    sfx: { shot: 'shot_suppressed', loudness: 0.32, reload: 'reload_smg', dry: 'dry_fire' },
  },

  sniper_hunting: {
    ...baseGun,
    id: 'sniper_hunting',
    name: 'Hunting Rifle',
    abbr: 'RIFLE',
    slot: 'primary',
    class: 'sniper',
    ammoType: 'sniper',
    magazine: 10,
    reserveMax: 90,
    reservePickup: 40,
    spawnAmmo: 20,
    automatic: false,
    cycleMs: 900,
    reloadTimeMs: 3100,
    reloadTimeTacticalMs: 2800,
    damage: 115,
    falloffStart: 60,
    falloffEnd: 140,
    falloffMin: 0.8,
    spreadHip: 3.4,
    spreadMove: 4.2,
    spreadAds: 0.06,
    spreadPerShot: 0,
    recoilPitch: 3.4,
    recoilYaw: 0.5,
    recoilRecovery: 8,
    kickback: 0.09,
    adsFovMultiplier: 0.34,
    adsSensMultiplier: 0.34,
    adsSpeedMultiplier: 0.42,
    flashScale: 1.4,
    penetration: 1,
    maxPenetrations: 3,
    model: {
      style: 'sniper',
      length: 0.86,
      scale: 1.06,
      metalTint: 0x2d2a27,
      bodyTint: 0x50351f,
      barrelRadius: 0.013,
      magazineSize: 0,
      stock: true,
      scope: true,
    },
    sfx: { shot: 'shot_sniper', loudness: 1.35, reload: 'reload_bolt', dry: 'dry_fire' },
  },

  rifle_scoped: {
    ...baseGun,
    id: 'rifle_scoped',
    name: 'Desert Rifle (Scoped)',
    abbr: 'DMR',
    slot: 'primary',
    class: 'sniper',
    ammoType: 'sniper',
    magazine: 20,
    reserveMax: 140,
    reservePickup: 70,
    spawnAmmo: 40,
    automatic: false,
    cycleMs: 320,
    reloadTimeMs: 2600,
    reloadTimeTacticalMs: 2300,
    damage: 78,
    spreadHip: 3.0,
    spreadMove: 3.8,
    spreadAds: 0.12,
    spreadPerShot: 0.3,
    recoilPitch: 2.4,
    recoilYaw: 0.4,
    kickback: 0.07,
    adsFovMultiplier: 0.42,
    adsSensMultiplier: 0.42,
    adsSpeedMultiplier: 0.5,
    penetration: 0.95,
    maxPenetrations: 3,
    model: {
      style: 'sniper',
      length: 0.8,
      scale: 1.02,
      metalTint: 0x25272a,
      bodyTint: 0x1f2225,
      barrelRadius: 0.016,
      magazineSize: 0.17,
      stock: true,
      scope: true,
    },
    sfx: { shot: 'shot_dmr', loudness: 1.3, reload: 'reload_mag', dry: 'dry_fire' },
  },

  // -------------------------------------------------------------------------
  // SECONDARY
  // -------------------------------------------------------------------------
  pistol_m9: {
    ...baseGun,
    id: 'pistol_m9',
    name: 'M9 Pistol',
    abbr: 'M9',
    slot: 'secondary',
    class: 'pistol',
    ammoType: 'pistol',
    magazine: 15,
    reserveMax: 240,
    reservePickup: 90,
    spawnAmmo: 45,
    automatic: false,
    cycleMs: 165,
    reloadTimeMs: 1750,
    reloadTimeTacticalMs: 1450,
    damage: 34,
    falloffStart: 18,
    falloffEnd: 46,
    falloffMin: 0.5,
    spreadHip: 1.6,
    spreadMove: 2.4,
    spreadAds: 0.22,
    spreadPerShot: 0.6,
    recoilPitch: 1.5,
    recoilYaw: 0.4,
    kickback: 0.04,
    adsFovMultiplier: 0.86,
    penetration: 0.4,
    moveSpeedMul: 1,
    model: {
      style: 'pistol',
      length: 0.21,
      scale: 0.9,
      metalTint: 0x2a2d30,
      bodyTint: 0x191b1d,
      barrelRadius: 0.009,
      magazineSize: 0.09,
      stock: false,
      scope: false,
    },
    sfx: { shot: 'shot_pistol', loudness: 0.8, reload: 'reload_pistol', dry: 'dry_fire' },
  },

  pistol_magnum: {
    ...baseGun,
    id: 'pistol_magnum',
    name: '.44 Magnum',
    abbr: 'MAGNUM',
    slot: 'secondary',
    class: 'pistol',
    ammoType: 'pistol',
    magazine: 6,
    reserveMax: 60,
    reservePickup: 30,
    spawnAmmo: 18,
    automatic: false,
    cycleMs: 420,
    reloadTimeMs: 2200,
    reloadTimeTacticalMs: 2000,
    damage: 96,
    pellets: 1,
    falloffStart: 30,
    falloffEnd: 70,
    falloffMin: 0.7,
    spreadHip: 2.0,
    spreadMove: 2.8,
    spreadAds: 0.3,
    spreadPerShot: 0,
    recoilPitch: 4.6,
    recoilYaw: 0.8,
    recoilRecovery: 9,
    kickback: 0.1,
    penetration: 1,
    maxPenetrations: 3,
    model: {
      style: 'pistol',
      length: 0.29,
      scale: 1.02,
      metalTint: 0x7d7f82,
      bodyTint: 0x2b2016,
      barrelRadius: 0.012,
      magazineSize: 0,
      stock: false,
      scope: false,
    },
    sfx: { shot: 'shot_magnum', loudness: 1.15, reload: 'reload_revolver', dry: 'dry_fire' },
  },

  // -------------------------------------------------------------------------
  // MELEE
  // -------------------------------------------------------------------------
  melee_crowbar: makeMelee('melee_crowbar', 'Crowbar', 'CROWBAR', 320, 46, 2.35, 0.85, 0.55, {
    style: 'melee',
    length: 0.5,
    scale: 1,
    metalTint: 0x8a3226,
    bodyTint: 0x3a2a22,
    barrelRadius: 0.012,
    magazineSize: 0,
    stock: false,
    scope: false,
    blade: 0.44,
  }),
  melee_machete: makeMelee('melee_machete', 'Machete', 'MACHETE', 340, 130, 2.6, 1.05, 0.8, {
    style: 'melee',
    length: 0.46,
    scale: 1,
    metalTint: 0xb9c0c4,
    bodyTint: 0x241a14,
    barrelRadius: 0.01,
    magazineSize: 0,
    stock: false,
    scope: false,
    blade: 0.4,
  }),
  melee_axe: makeMelee('melee_axe', 'Fire Axe', 'AXE', 520, 210, 2.15, 0.95, 0.7, {
    style: 'melee',
    length: 0.55,
    scale: 1,
    metalTint: 0x6f2b1c,
    bodyTint: 0x6a4a2a,
    barrelRadius: 0.014,
    magazineSize: 0,
    stock: false,
    scope: false,
    blade: 0.28,
  }),
  melee_bat: makeMelee('melee_bat', 'Baseball Bat', 'BAT', 300, 90, 2.5, 1.1, 0.65, {
    style: 'melee',
    length: 0.58,
    scale: 1,
    metalTint: 0x8a5a2c,
    bodyTint: 0x8a5a2c,
    barrelRadius: 0.02,
    magazineSize: 0,
    stock: false,
    scope: false,
    blade: 0.5,
  }),
  melee_katana: makeMelee('melee_katana', 'Katana', 'KATANA', 260, 175, 2.9, 1.2, 0.92, {
    style: 'melee',
    length: 0.72,
    scale: 1,
    metalTint: 0xd2d8db,
    bodyTint: 0x1a1a1c,
    barrelRadius: 0.009,
    magazineSize: 0,
    stock: false,
    scope: false,
    blade: 0.66,
  }),
  melee_shove: {
    ...makeMelee('melee_shove', 'Shove', 'SHOVE', 0, 6, 400, 1.6, 1.0, {
      style: 'melee',
      length: 0.14,
      scale: 1,
      metalTint: 0xd8b49a,
      bodyTint: 0xd8b49a,
      barrelRadius: 0.05,
      magazineSize: 0,
      stock: false,
      scope: false,
    }),
    // The shove is always available (right-click without a melee weapon) and
    // only staggers; it never deals killing damage.
    melee: { swingMs: 400, hitAt: 0.3, damage: 6, range: 1.6, arc: 55, targets: 4, instakillChance: 0, shove: true },
    moveSpeedMul: 1.05,
  },

  // -------------------------------------------------------------------------
  // THROWABLES
  // -------------------------------------------------------------------------
  pipe_bomb: {
    ...baseGun,
    id: 'pipe_bomb',
    name: 'Pipe Bomb',
    abbr: 'PIPE',
    slot: 'throwable',
    class: 'melee',
    ammoType: 'none',
    magazine: 1,
    reserveMax: 3,
    reservePickup: 1,
    spawnAmmo: 1,
    automatic: false,
    cycleMs: 900,
    damage: 0,
    moveSpeedMul: 1,
    throwable: { fuseMs: 2600, radius: 7.5, damage: 320, kind: 'pipebomb', throwSpeed: 22 },
    model: {
      style: 'throwable',
      length: 0.16,
      scale: 1,
      metalTint: 0x4a4c4e,
      bodyTint: 0x8b2a1e,
      barrelRadius: 0.03,
      magazineSize: 0,
      stock: false,
      scope: false,
    },
    sfx: { shot: 'throw', loudness: 0.1, reload: 'reload', dry: 'dry_fire' },
  },
  molotov: {
    ...baseGun,
    id: 'molotov',
    name: 'Molotov',
    abbr: 'MOLOTOV',
    slot: 'throwable',
    class: 'melee',
    ammoType: 'none',
    magazine: 1,
    reserveMax: 3,
    reservePickup: 1,
    spawnAmmo: 1,
    automatic: false,
    cycleMs: 900,
    damage: 0,
    moveSpeedMul: 1,
    throwable: { fuseMs: 0, radius: 4.2, damage: 60, kind: 'molotov', throwSpeed: 18 },
    model: {
      style: 'throwable',
      length: 0.2,
      scale: 1,
      metalTint: 0x6d6a4a,
      bodyTint: 0x2f6a3a,
      barrelRadius: 0.032,
      magazineSize: 0,
      stock: false,
      scope: false,
    },
    sfx: { shot: 'throw', loudness: 0.1, reload: 'reload', dry: 'dry_fire' },
  },
  bile_jar: {
    ...baseGun,
    id: 'bile_jar',
    name: 'Bile Jar',
    abbr: 'BILE',
    slot: 'throwable',
    class: 'melee',
    ammoType: 'none',
    magazine: 1,
    reserveMax: 2,
    reservePickup: 1,
    spawnAmmo: 1,
    automatic: false,
    cycleMs: 900,
    damage: 0,
    moveSpeedMul: 1,
    throwable: { fuseMs: 0, radius: 6, damage: 0, kind: 'bile', throwSpeed: 17 },
    model: {
      style: 'throwable',
      length: 0.19,
      scale: 1,
      metalTint: 0x8ea03a,
      bodyTint: 0x5a7a24,
      barrelRadius: 0.034,
      magazineSize: 0,
      stock: false,
      scope: false,
    },
    sfx: { shot: 'throw', loudness: 0.1, reload: 'reload', dry: 'dry_fire' },
  },
};

function makeMelee(
  id: string,
  name: string,
  abbr: string,
  swingMs: number,
  damage: number,
  range: number,
  arc: number,
  instakill: number,
  model: WeaponModelSpec,
): WeaponDef {
  return {
    ...baseGun,
    id,
    name,
    abbr,
    slot: 'melee',
    class: 'melee',
    ammoType: 'none',
    magazine: 0,
    reserveMax: 0,
    reservePickup: 0,
    spawnAmmo: 0,
    automatic: false,
    cycleMs: 200,
    damage: 0,
    moveSpeedMul: 1.08,
    penetration: 0,
    maxPenetrations: 0,
    melee: {
      swingMs,
      hitAt: 0.34,
      damage,
      range,
      arc,
      targets: 3,
      instakillChance: instakill,
      shove: false,
    },
    model,
    sfx: { shot: 'melee_swing', loudness: 0.25, reload: 'reload', dry: 'dry_fire' },
  };
}

// ---------------------------------------------------------------------------
// HEALING ITEMS
// ---------------------------------------------------------------------------

export interface HealItemDef {
  id: 'medkit' | 'pills' | 'adrenaline';
  name: string;
  abbr: string;
  /** Seconds of use before the effect lands. */
  useTimeMs: number;
  /** Health restored (medkit: up to 80% of max; pills: temp health). */
  heal: number;
  /** Temporary (decaying) health granted. */
  tempHealth: number;
  /** Temporary health decays at this many HP/s after `tempDecayDelay`. */
  tempDecayPerSec: number;
  tempDecayDelay: number;
  /** Movement multiplier while using / while under effect. */
  useSpeedMul: number;
  effectSpeedMul: number;
  effectDurationMs: number;
  /** Can be used while incapacitated / to revive self. */
  selfRevive: boolean;
  /** Carried automatically in the dedicated slot. */
  color: number;
}

export const HEAL_ITEMS: Record<string, HealItemDef> = {
  medkit: {
    id: 'medkit',
    name: 'First Aid Kit',
    abbr: 'MEDKIT',
    useTimeMs: 4200,
    heal: 80,
    tempHealth: 0,
    tempDecayPerSec: 1,
    tempDecayDelay: 0,
    useSpeedMul: 0.45,
    effectSpeedMul: 1,
    effectDurationMs: 0,
    selfRevive: false,
    color: 0xd9d2c0,
  },
  pills: {
    id: 'pills',
    name: 'Pain Pills',
    abbr: 'PILLS',
    useTimeMs: 1400,
    heal: 0,
    tempHealth: 50,
    tempDecayPerSec: 1.9,
    tempDecayDelay: 4,
    useSpeedMul: 0.6,
    effectSpeedMul: 1,
    effectDurationMs: 0,
    selfRevive: false,
    color: 0xe8e2d2,
  },
  adrenaline: {
    id: 'adrenaline',
    name: 'Adrenaline Shot',
    abbr: 'ADREN',
    useTimeMs: 1000,
    heal: 0,
    tempHealth: 25,
    tempDecayPerSec: 0.8,
    tempDecayDelay: 20,
    useSpeedMul: 0.9,
    effectSpeedMul: 1.3,
    effectDurationMs: 15000,
    selfRevive: true,
    color: 0xd8543a,
  },
};

/** Which ammo type each weapon class consumes — also drives ammo pickup pooling. */
export const AMMO_TYPES: AmmoType[] = ['rifle', 'smg', 'shells', 'sniper', 'pistol'];

export function weaponDef(id: string): WeaponDef {
  const def = WEAPONS[id];
  if (!def) throw new Error(`[config] unknown weapon id "${id}"`);
  return def;
}

/** Convenience list used by the spawn tables. */
export const PRIMARY_IDS = ['ar_carbine', 'ar_ak', 'smg_compact', 'shotgun_pump', 'shotgun_auto', 'smg_silenced', 'sniper_hunting', 'rifle_scoped'];
export const SECONDARY_IDS = ['pistol_m9', 'pistol_magnum'];
export const MELEE_IDS = ['melee_crowbar', 'melee_machete', 'melee_axe', 'melee_bat', 'melee_katana'];
export const THROWABLE_IDS = ['pipe_bomb', 'molotov', 'bile_jar'];

/** Surface profiles: impact VFX/SFX + bullet penetration behaviour. */
export const SURFACES: Record<SurfaceType, { color: number; particleCount: number; decalChance: number; penetration: number; noise: number; sfx: string }> = {
  concrete: { color: 0x9a958c, particleCount: 9, decalChance: 0.85, penetration: 0.45, noise: 1, sfx: 'impact_concrete' },
  metal: { color: 0xffcf8a, particleCount: 10, decalChance: 0.5, penetration: 0.85, noise: 1.3, sfx: 'impact_metal' },
  wood: { color: 0x8a5f36, particleCount: 8, decalChance: 0.7, penetration: 0.7, noise: 1.1, sfx: 'impact_wood' },
  glass: { color: 0xbfe6f2, particleCount: 16, decalChance: 0.15, penetration: 1, noise: 1.4, sfx: 'impact_glass' },
  flesh: { color: 0x8e1410, particleCount: 12, decalChance: 0.35, penetration: 0.9, noise: 0.4, sfx: 'impact_flesh' },
  dirt: { color: 0x6b5b45, particleCount: 7, decalChance: 0.4, penetration: 0.6, noise: 0.8, sfx: 'impact_dirt' },
  water: { color: 0x86a8b8, particleCount: 14, decalChance: 0, penetration: 0.95, noise: 1.2, sfx: 'impact_water' },
  foliage: { color: 0x4a6b34, particleCount: 6, decalChance: 0.1, penetration: 0.98, noise: 0.5, sfx: 'impact_foliage' },
};
