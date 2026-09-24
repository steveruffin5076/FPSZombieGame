/**
 * AUDIO ENGINE
 * ============
 * 100% procedurally synthesised audio over the Web Audio API — no sample files,
 * so the whole soundtrack and SFX library cost zero download and every gunshot
 * can vary in pitch/timbre instead of repeating a single recording.
 *
 * Topology
 * --------
 *   voice ─┬─▶ dry ─────────────────────────────────┐
 *          └─▶ convolver (procedural IR) ─▶ wet ────┴─▶ busGain ─▶ compressor ─▶ out
 *
 * Sound design
 * ------------
 *  - A gunshot is layered: a high-passed noise "crack" (3 ms attack), a
 *    band-passed body burst, a low sine "thump" that carries the calibre, and a
 *    short mechanical tail. Detuning layers per shot is what prevents fatigue
 *    during a 100-zombie horde fight.
 *  - Infected vocalisations are formant-ish: a detuned saw with a pitch envelope
 *    plus band-passed noise "breath", which reads as human-but-wrong.
 *  - Distance cues: the Web Audio panner handles attenuation, and a low-pass
 *    filter darkens distant sources to simulate air absorption.
 *  - Voice limiting: concurrent voices are capped and identical cues are
 *    rate-limited, so the audio thread stays far away from crackling.
 */
import * as THREE from 'three';
import { Rng } from '@/core/MathUtil';
import type { GameSettings } from '@/core/Settings';
import { noise } from '@/world/Noise';
import type { WeaponDef } from '@/config/weapons';
import type { ZombieVariant } from '@/config/zombies';

export type SfxId =
  | 'dry_fire'
  | 'reload_rifle'
  | 'reload_smg'
  | 'reload_pistol'
  | 'reload_revolver'
  | 'reload_mag'
  | 'reload_shotgun_shell'
  | 'reload_bolt'
  | 'reload'
  | 'shot_rifle'
  | 'shot_ak'
  | 'shot_smg'
  | 'shot_shotgun'
  | 'shot_auto_sg'
  | 'shot_suppressed'
  | 'shot_sniper'
  | 'shot_dmr'
  | 'shot_pistol'
  | 'shot_magnum'
  | 'impact_concrete'
  | 'impact_metal'
  | 'impact_wood'
  | 'impact_glass'
  | 'impact_flesh'
  | 'impact_dirt'
  | 'impact_water'
  | 'impact_foliage'
  | 'explosion'
  | 'explosion_small'
  | 'melee_swing'
  | 'melee_hit_flesh'
  | 'melee_shove_hit'
  | 'throw'
  | 'heal_use'
  | 'heal_done'
  | 'footstep_concrete'
  | 'footstep_dirt'
  | 'footstep_metal'
  | 'footstep_water'
  | 'land'
  | 'jump'
  | 'door_open'
  | 'door_close'
  | 'door_break'
  | 'safe_room'
  | 'radio'
  | 'alarm'
  | 'generator'
  | 'horde_start'
  | 'horde_end'
  | 'hurt_light'
  | 'hurt_heavy'
  | 'downed'
  | 'reviving'
  | 'revived'
  | 'died'
  | 'pickup_weapon'
  | 'pickup_item'
  | 'ui_click'
  | 'ui_hover'
  | 'objective'
  | 'zombie_moan'
  | 'zombie_moan_fast'
  | 'zombie_moan_deep'
  | 'zombie_attack'
  | 'zombie_hurt'
  | 'zombie_die'
  | 'hunter_idle'
  | 'hunter_pounce'
  | 'hunter_die'
  | 'boomer_idle'
  | 'boomer_attack'
  | 'boomer_hurt'
  | 'boomer_explode'
  | 'smoker_idle'
  | 'smoker_tongue'
  | 'smoker_hurt'
  | 'smoker_die'
  | 'spitter_idle'
  | 'spitter_spit'
  | 'spitter_hurt'
  | 'spitter_die'
  | 'jockey_idle'
  | 'jockey_leap'
  | 'jockey_hurt'
  | 'jockey_die'
  | 'charger_idle'
  | 'charger_charge'
  | 'charger_hurt'
  | 'charger_die'
  | 'tank_roar'
  | 'tank_swing'
  | 'tank_hurt'
  | 'tank_die'
  | 'witch_cry'
  | 'witch_scream'
  | 'witch_hurt'
  | 'witch_die'
  | 'survivor_call'
  | 'survivor_pain'
  | 'hint';

export interface PlayOptions {
  position?: THREE.Vector3 | null;
  volume?: number;
  pitch?: number;
  ui?: boolean;
  maxDistance?: number;
  loopSeconds?: number;
  /** Truncate the sound after this many seconds (reload/sprint cues). */
  duration?: number;
}

/**
 * A synthesised sound is a list of layers. Each layer is either filtered noise
 * or an oscillator, with frequency/amplitude envelopes.
 */
interface Layer {
  kind: 'noise' | 'tone';
  /** Filter type for noise, oscillator type for tones. */
  type?: BiquadFilterType | OscillatorType;
  /** Start frequency (Hz). */
  f0: number;
  /** End frequency (Hz) — defaults to f0. */
  f1?: number;
  /** Filter Q for noise layers. */
  q?: number;
  /** Peak gain. */
  gain: number;
  /** Seconds. */
  dur: number;
  /** Attack time in seconds. */
  attack?: number;
  /** Amplitude curve: exponential (percussive) or linear. */
  curve?: 'exp' | 'lin';
  /** Per-play random detune amount (fraction of f0). */
  jitter?: number;
  /** Additive detune in cents for thickness. */
  spread?: number;
}

type Recipe = Layer[];

const N = (spec: Partial<Layer> & { f0: number; gain: number; dur: number }): Layer => ({ kind: 'noise', type: 'bandpass', q: 1, ...spec });
const T = (spec: Partial<Layer> & { f0: number; gain: number; dur: number }): Layer => ({ kind: 'tone', type: 'sine', ...spec });

/** Gunshots are built from the same four-layer template with per-calibre tuning. */
function gunRecipe(bodyF: number, thumpF: number, gain: number, tail = 0.16): Recipe {
  return [
    N({ f0: 6200, q: 0.6, type: 'highpass', gain: gain * 0.85, dur: 0.045, attack: 0.0015, curve: 'exp', jitter: 0.08 }),
    N({ f0: bodyF, f1: bodyF * 0.35, q: 0.9, gain: gain, dur: 0.16, attack: 0.002, curve: 'exp', jitter: 0.06 }),
    T({ type: 'triangle', f0: thumpF, f1: thumpF * 0.55, gain: gain * 0.75, dur: 0.13, attack: 0.001, curve: 'exp', jitter: 0.05 }),
    N({ f0: 1800, q: 0.7, type: 'bandpass', gain: gain * 0.22, dur: tail, attack: 0.004, curve: 'exp', jitter: 0.2 }),
  ];
}

/** Infected vocalisations: a formant-ish growl plus breath noise. */
function voiceRecipe(base: number, growl: number, gain = 0.5, dur = 1.1, breath = 0.3): Recipe {
  return [
    T({ type: 'sawtooth', f0: base, f1: base * growl, gain: gain * 0.5, dur, attack: 0.09, curve: 'lin', jitter: 0.13, spread: 14 }),
    T({ type: 'square', f0: base * 0.5, f1: base * 0.42, gain: gain * 0.22, dur: dur * 1.05, attack: 0.12, curve: 'lin', jitter: 0.1 }),
    N({ f0: 900, f1: 480, q: 3.2, gain: gain * breath, dur, attack: 0.14, curve: 'lin', jitter: 0.25 }),
  ];
}

const RECIPES: Partial<Record<SfxId, Recipe>> = {
  // --- weapons ------------------------------------------------------------
  shot_rifle: gunRecipe(2600, 118, 0.5),
  shot_ak: gunRecipe(2100, 96, 0.58, 0.2),
  shot_smg: gunRecipe(3100, 150, 0.42),
  shot_dmr: gunRecipe(2300, 104, 0.55, 0.22),
  shot_sniper: gunRecipe(1700, 78, 0.72, 0.3),
  shot_pistol: gunRecipe(3400, 175, 0.4),
  shot_magnum: gunRecipe(2000, 92, 0.62, 0.24),
  shot_shotgun: [
    N({ f0: 1400, f1: 380, q: 0.7, gain: 0.75, dur: 0.3, attack: 0.002, curve: 'exp', jitter: 0.05 }),
    N({ f0: 7000, type: 'highpass', gain: 0.4, dur: 0.05, attack: 0.001, curve: 'exp' }),
    T({ f0: 82, f1: 46, gain: 0.62, dur: 0.22, attack: 0.001, curve: 'exp' }),
  ],
  shot_auto_sg: [
    N({ f0: 1500, f1: 460, q: 0.8, gain: 0.6, dur: 0.24, attack: 0.002, curve: 'exp', jitter: 0.07 }),
    T({ f0: 90, f1: 52, gain: 0.5, dur: 0.18, attack: 0.001, curve: 'exp' }),
  ],
  shot_suppressed: [
    N({ f0: 1100, f1: 520, q: 2.4, gain: 0.28, dur: 0.1, attack: 0.002, curve: 'exp', jitter: 0.1 }),
    N({ f0: 3200, type: 'highpass', gain: 0.08, dur: 0.03, attack: 0.001 }),
    T({ f0: 150, f1: 96, gain: 0.14, dur: 0.08, attack: 0.001, curve: 'exp' }),
  ],
  dry_fire: [N({ f0: 2600, q: 6, gain: 0.22, dur: 0.035, attack: 0.001, curve: 'exp' }), T({ f0: 320, f1: 180, gain: 0.06, dur: 0.03 })],
  reload_rifle: [
    N({ f0: 1800, q: 4, gain: 0.18, dur: 0.06, attack: 0.001, curve: 'exp' }),
    T({ f0: 420, f1: 240, gain: 0.1, dur: 0.05 }),
  ],
  reload_mag: [N({ f0: 2200, q: 5, gain: 0.2, dur: 0.07, attack: 0.001 }), N({ f0: 1400, q: 4, gain: 0.16, dur: 0.09, attack: 0.002 })],
  reload_smg: [N({ f0: 2600, q: 5, gain: 0.16, dur: 0.05, attack: 0.001 }), T({ f0: 520, f1: 300, gain: 0.08, dur: 0.05 })],
  reload_pistol: [N({ f0: 2800, q: 6, gain: 0.15, dur: 0.05, attack: 0.001 })],
  reload_revolver: [N({ f0: 2400, q: 7, gain: 0.18, dur: 0.05 }), N({ f0: 1600, q: 6, gain: 0.14, dur: 0.06 })],
  reload_shotgun_shell: [N({ f0: 1500, q: 4, gain: 0.18, dur: 0.06, attack: 0.001 }), T({ f0: 240, f1: 160, gain: 0.08, dur: 0.05 })],
  reload_bolt: [N({ f0: 3200, q: 8, gain: 0.16, dur: 0.04 }), N({ f0: 2000, q: 6, gain: 0.14, dur: 0.05 })],
  reload: [N({ f0: 2200, q: 5, gain: 0.15, dur: 0.06, attack: 0.001 })],

  // --- impacts ------------------------------------------------------------
  impact_concrete: [N({ f0: 1500, q: 1.2, gain: 0.34, dur: 0.09, attack: 0.001, curve: 'exp', jitter: 0.2 }), T({ f0: 160, f1: 90, gain: 0.14, dur: 0.06 })],
  impact_metal: [N({ f0: 3800, q: 3.5, gain: 0.3, dur: 0.14, attack: 0.001, curve: 'exp', jitter: 0.25 }), T({ f0: 2600, f1: 1400, gain: 0.16, dur: 0.2, jitter: 0.3 })],
  impact_wood: [N({ f0: 1100, q: 2.2, gain: 0.32, dur: 0.08, attack: 0.001, jitter: 0.2 }), T({ f0: 320, f1: 180, gain: 0.16, dur: 0.07 })],
  impact_glass: [N({ f0: 6500, q: 2.6, gain: 0.3, dur: 0.22, attack: 0.001, jitter: 0.3 }), T({ f0: 4200, f1: 2600, gain: 0.14, dur: 0.25, jitter: 0.35 })],
  impact_flesh: [N({ f0: 700, f1: 320, q: 1.6, gain: 0.36, dur: 0.13, attack: 0.001, jitter: 0.22 }), T({ f0: 130, f1: 70, gain: 0.18, dur: 0.1 })],
  impact_dirt: [N({ f0: 900, q: 1, gain: 0.26, dur: 0.1, attack: 0.002, jitter: 0.25 })],
  impact_water: [N({ f0: 2200, q: 1.4, gain: 0.3, dur: 0.2, attack: 0.002, jitter: 0.25 })],
  impact_foliage: [N({ f0: 4200, q: 1.2, gain: 0.2, dur: 0.12, attack: 0.003 })],

  // --- explosives ---------------------------------------------------------
  explosion: [
    N({ f0: 900, f1: 150, q: 0.6, gain: 0.9, dur: 0.7, attack: 0.003, curve: 'exp' }),
    T({ f0: 60, f1: 28, gain: 0.9, dur: 0.55, attack: 0.002, curve: 'exp' }),
    N({ f0: 5000, type: 'highpass', gain: 0.4, dur: 0.06, attack: 0.001 }),
    N({ f0: 400, q: 0.7, gain: 0.5, dur: 1.4, attack: 0.05, curve: 'lin' }),
  ],
  explosion_small: [N({ f0: 1200, f1: 260, q: 0.7, gain: 0.7, dur: 0.35, attack: 0.002, curve: 'exp' }), T({ f0: 90, f1: 45, gain: 0.6, dur: 0.28, attack: 0.002 })],
  boomer_explode: [N({ f0: 600, f1: 180, q: 0.8, gain: 0.8, dur: 0.5, attack: 0.004, curve: 'exp' }), N({ f0: 2400, q: 1.2, gain: 0.4, dur: 0.9, attack: 0.02, curve: 'lin' })],

  // --- melee / player ----------------------------------------------------
  melee_swing: [N({ f0: 3200, q: 1.4, gain: 0.16, dur: 0.14, attack: 0.02, curve: 'lin', jitter: 0.3 })],
  melee_hit_flesh: [N({ f0: 500, f1: 220, q: 1.4, gain: 0.6, dur: 0.18, attack: 0.001, curve: 'exp', jitter: 0.2 }), T({ f0: 90, f1: 50, gain: 0.3, dur: 0.14 })],
  melee_shove_hit: [N({ f0: 900, q: 2, gain: 0.4, dur: 0.16, attack: 0.002 }), T({ f0: 140, f1: 80, gain: 0.22, dur: 0.12 })],
  throw: [N({ f0: 3000, q: 1.2, gain: 0.12, dur: 0.2, attack: 0.03, curve: 'lin' })],
  heal_use: [N({ f0: 2600, q: 3, gain: 0.14, dur: 0.3, attack: 0.05, curve: 'lin' })],
  heal_done: [T({ f0: 520, f1: 780, gain: 0.1, dur: 0.3, attack: 0.05, type: 'sine' })],

  // --- movement ----------------------------------------------------------
  footstep_concrete: [N({ f0: 1400, q: 1.1, gain: 0.2, dur: 0.08, attack: 0.002, jitter: 0.3 })],
  footstep_dirt: [N({ f0: 800, q: 1, gain: 0.18, dur: 0.09, attack: 0.003, jitter: 0.3 })],
  footstep_metal: [N({ f0: 2600, q: 2.6, gain: 0.2, dur: 0.11, attack: 0.002, jitter: 0.3 }), T({ f0: 900, f1: 520, gain: 0.08, dur: 0.12 })],
  footstep_water: [N({ f0: 2000, q: 1, gain: 0.22, dur: 0.16, attack: 0.003, jitter: 0.3 })],
  land: [N({ f0: 700, f1: 300, q: 1, gain: 0.3, dur: 0.16, attack: 0.001 })],
  jump: [N({ f0: 1200, q: 1.2, gain: 0.12, dur: 0.08, attack: 0.002 })],

  // --- world -------------------------------------------------------------
  door_open: [N({ f0: 800, q: 2.4, gain: 0.24, dur: 0.5, attack: 0.03, curve: 'lin', jitter: 0.2 }), T({ f0: 180, f1: 240, gain: 0.1, dur: 0.4 })],
  door_close: [N({ f0: 600, q: 2, gain: 0.26, dur: 0.25, attack: 0.01, curve: 'lin' }), T({ f0: 120, f1: 70, gain: 0.18, dur: 0.2 })],
  door_break: [N({ f0: 1800, q: 1.2, gain: 0.55, dur: 0.4, attack: 0.002, curve: 'exp' }), N({ f0: 900, q: 1, gain: 0.4, dur: 0.6, attack: 0.01, curve: 'lin' })],
  safe_room: [T({ f0: 420, gain: 0.14, dur: 1.2, attack: 0.2, type: 'sine' }), T({ f0: 630, gain: 0.1, dur: 1.6, attack: 0.3, type: 'sine' })],
  radio: [N({ f0: 2200, q: 2.4, gain: 0.14, dur: 0.7, attack: 0.05, curve: 'lin' }), T({ f0: 300, f1: 220, gain: 0.06, dur: 0.6 })],
  alarm: [T({ f0: 700, f1: 900, gain: 0.24, dur: 1.4, attack: 0.05, type: 'square' })],
  generator: [T({ f0: 46, gain: 0.35, dur: 2.4, attack: 0.4, type: 'sawtooth' }), N({ f0: 900, q: 1.6, gain: 0.12, dur: 2.4, attack: 0.4, curve: 'lin' })],
  horde_start: [T({ f0: 110, f1: 190, gain: 0.3, dur: 1.6, attack: 0.05, type: 'sawtooth' }), N({ f0: 700, q: 1.2, gain: 0.2, dur: 2, attack: 0.2, curve: 'lin' })],
  horde_end: [T({ f0: 200, f1: 90, gain: 0.2, dur: 1.8, attack: 0.1, type: 'triangle' })],

  // --- player state ------------------------------------------------------
  hurt_light: [N({ f0: 700, q: 1.4, gain: 0.3, dur: 0.25, attack: 0.004, curve: 'lin' }), T({ f0: 220, f1: 150, gain: 0.16, dur: 0.3 })],
  hurt_heavy: [N({ f0: 500, f1: 260, q: 1.1, gain: 0.5, dur: 0.5, attack: 0.004, curve: 'lin' }), T({ f0: 130, f1: 70, gain: 0.3, dur: 0.45 })],
  downed: [T({ f0: 300, f1: 120, gain: 0.25, dur: 1.2, attack: 0.02, type: 'triangle' })],
  reviving: [N({ f0: 1600, q: 2, gain: 0.12, dur: 0.5, attack: 0.08, curve: 'lin' })],
  revived: [T({ f0: 520, f1: 900, gain: 0.18, dur: 0.6, attack: 0.05 })],
  died: [T({ f0: 220, f1: 60, gain: 0.3, dur: 2.2, attack: 0.02, type: 'sawtooth' })],
  pickup_weapon: [N({ f0: 2400, q: 4, gain: 0.16, dur: 0.1, attack: 0.002 }), T({ f0: 480, f1: 720, gain: 0.1, dur: 0.16 })],
  pickup_item: [T({ f0: 620, f1: 900, gain: 0.1, dur: 0.2, attack: 0.01 })],
  ui_click: [T({ f0: 900, f1: 1400, gain: 0.07, dur: 0.08, attack: 0.004 })],
  ui_hover: [T({ f0: 1400, gain: 0.03, dur: 0.05, attack: 0.004 })],
  objective: [T({ f0: 380, gain: 0.1, dur: 1.1, attack: 0.15 }), T({ f0: 570, f1: 640, gain: 0.08, dur: 1.3, attack: 0.25 })],
  hint: [T({ f0: 700, f1: 500, gain: 0.05, dur: 0.3 })],

  // --- infected ----------------------------------------------------------
  zombie_moan: voiceRecipe(150, 0.75, 0.5, 1.3, 0.35),
  zombie_moan_fast: voiceRecipe(180, 0.7, 0.45, 1.0, 0.45),
  zombie_moan_deep: voiceRecipe(96, 0.8, 0.55, 1.5, 0.25),
  zombie_attack: [N({ f0: 1100, f1: 400, q: 1.2, gain: 0.4, dur: 0.3, attack: 0.01, curve: 'lin' }), T({ f0: 190, f1: 120, gain: 0.22, dur: 0.28 })],
  zombie_hurt: [N({ f0: 900, f1: 380, q: 1.4, gain: 0.38, dur: 0.25, attack: 0.004, curve: 'exp' })],
  zombie_die: voiceRecipe(130, 0.45, 0.45, 1.0, 0.3),
  hunter_idle: voiceRecipe(260, 1.35, 0.34, 0.7, 0.5),
  hunter_pounce: [T({ f0: 620, f1: 380, gain: 0.4, dur: 0.7, attack: 0.02, type: 'sawtooth' }), N({ f0: 2200, q: 1.4, gain: 0.3, dur: 0.6, attack: 0.02, curve: 'lin' })],
  hunter_die: voiceRecipe(300, 0.4, 0.4, 0.9, 0.4),
  boomer_idle: voiceRecipe(72, 1.1, 0.5, 1.6, 0.5),
  boomer_attack: [N({ f0: 500, f1: 200, q: 1, gain: 0.5, dur: 0.5, attack: 0.02, curve: 'lin' }), T({ f0: 88, f1: 60, gain: 0.3, dur: 0.5 })],
  boomer_hurt: [N({ f0: 420, q: 1.1, gain: 0.42, dur: 0.4, attack: 0.005 })],
  smoker_idle: [N({ f0: 620, q: 3.4, gain: 0.34, dur: 1.3, attack: 0.15, curve: 'lin', jitter: 0.2 }), T({ f0: 118, f1: 96, gain: 0.2, dur: 1.3, type: 'sawtooth' })],
  smoker_tongue: [N({ f0: 1600, f1: 500, q: 2.4, gain: 0.35, dur: 0.7, attack: 0.02, curve: 'lin' })],
  smoker_hurt: [N({ f0: 700, q: 2, gain: 0.34, dur: 0.35, attack: 0.005 })],
  smoker_die: voiceRecipe(110, 0.5, 0.4, 1.4, 0.45),
  spitter_idle: [T({ f0: 330, f1: 260, gain: 0.24, dur: 0.9, type: 'sawtooth', attack: 0.1 }), N({ f0: 2800, q: 2, gain: 0.2, dur: 0.9, attack: 0.1, curve: 'lin' })],
  spitter_spit: [N({ f0: 1400, f1: 700, q: 1.6, gain: 0.36, dur: 0.45, attack: 0.03, curve: 'lin' })],
  spitter_hurt: [N({ f0: 1500, q: 2, gain: 0.3, dur: 0.3, attack: 0.004 })],
  spitter_die: voiceRecipe(200, 0.5, 0.36, 1.0, 0.4),
  jockey_idle: voiceRecipe(320, 1.5, 0.32, 0.6, 0.5),
  jockey_leap: [T({ f0: 700, f1: 1000, gain: 0.35, dur: 0.5, attack: 0.01, type: 'square' })],
  jockey_hurt: [N({ f0: 1800, q: 2.4, gain: 0.3, dur: 0.22, attack: 0.004 })],
  jockey_die: voiceRecipe(360, 0.4, 0.3, 0.7, 0.4),
  charger_idle: voiceRecipe(84, 1.15, 0.55, 1.4, 0.35),
  charger_charge: [T({ f0: 110, f1: 190, gain: 0.5, dur: 1.0, attack: 0.05, type: 'sawtooth' }), N({ f0: 700, q: 1, gain: 0.4, dur: 1.2, attack: 0.05, curve: 'lin' })],
  charger_hurt: [N({ f0: 520, q: 1.2, gain: 0.4, dur: 0.34, attack: 0.004 })],
  charger_die: voiceRecipe(70, 0.5, 0.5, 1.6, 0.3),
  tank_roar: [
    T({ f0: 58, f1: 44, gain: 0.9, dur: 2.4, attack: 0.12, type: 'sawtooth', jitter: 0.05 }),
    T({ f0: 88, f1: 66, gain: 0.5, dur: 2.2, attack: 0.2, type: 'square' }),
    N({ f0: 400, q: 0.9, gain: 0.5, dur: 2.4, attack: 0.15, curve: 'lin' }),
  ],
  tank_swing: [N({ f0: 300, f1: 120, q: 0.8, gain: 0.6, dur: 0.5, attack: 0.008, curve: 'exp' }), T({ f0: 60, f1: 38, gain: 0.45, dur: 0.4 })],
  tank_hurt: [T({ f0: 76, f1: 58, gain: 0.6, dur: 0.6, type: 'sawtooth' }), N({ f0: 600, q: 1, gain: 0.35, dur: 0.4 })],
  tank_die: [T({ f0: 60, f1: 26, gain: 0.8, dur: 3.0, attack: 0.05, type: 'sawtooth' }), N({ f0: 300, q: 0.8, gain: 0.5, dur: 2.6, attack: 0.2, curve: 'lin' })],
  witch_cry: [
    T({ f0: 320, f1: 250, gain: 0.5, dur: 1.8, attack: 0.2, type: 'sawtooth', jitter: 0.06, spread: 20 }),
    N({ f0: 1400, q: 3, gain: 0.3, dur: 1.8, attack: 0.3, curve: 'lin' }),
  ],
  witch_scream: [
    T({ f0: 520, f1: 1200, gain: 0.75, dur: 1.3, attack: 0.02, type: 'sawtooth', jitter: 0.05 }),
    N({ f0: 3000, q: 2, gain: 0.45, dur: 1.2, attack: 0.02, curve: 'lin' }),
  ],
  witch_hurt: [T({ f0: 460, f1: 700, gain: 0.5, dur: 0.7, type: 'sawtooth' })],
  witch_die: [T({ f0: 380, f1: 120, gain: 0.6, dur: 1.8, attack: 0.05, type: 'sawtooth' })],
  survivor_call: [T({ f0: 190, f1: 170, gain: 0.22, dur: 0.5, attack: 0.05, type: 'triangle' }), N({ f0: 1100, q: 2.2, gain: 0.14, dur: 0.5, attack: 0.08, curve: 'lin' })],
  survivor_pain: [T({ f0: 210, f1: 150, gain: 0.24, dur: 0.5, attack: 0.02, type: 'triangle' }), N({ f0: 900, q: 1.6, gain: 0.18, dur: 0.4, attack: 0.02, curve: 'lin' })],
};

/** How loud each sound is for the *gameplay* noise system (not audio volume). */
export const NOISE_LOUDNESS: Partial<Record<SfxId, number>> = {
  shot_rifle: 34,
  shot_ak: 36,
  shot_dmr: 38,
  shot_sniper: 44,
  shot_shotgun: 46,
  shot_auto_sg: 42,
  shot_magnum: 40,
  shot_pistol: 30,
  shot_suppressed: 11,
  shot_smg: 30,
  explosion: 90,
  explosion_small: 60,
  door_break: 30,
  door_open: 14,
  alarm: 70,
  melee_hit_flesh: 12,
  zombie_die: 10,
  zombie_attack: 6,
};

export class AudioSystem {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private voiceBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private convolver: ConvolverNode | null = null;
  private wetGain: GainNode | null = null;
  private dryGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private rand = new Rng(0x51de);
  private listenerPos = new THREE.Vector3();
  private started = false;
  private settings: GameSettings;
  private wetAmount = 0.25;
  private activeVoices = 0;
  private maxVoices = 44;
  private lastPlayed = new Map<SfxId, number>();
  private time = 0;
  /** Ambient bed state. */
  private ambientGain: GainNode | null = null;
  private ambientNodes: AudioNode[] = [];
  private ambientMood = '';
  /** Multiplier for "muffled" states (underwater, deafened by a Boomer). */
  private deafen = 0;

  constructor(settings: GameSettings) {
    this.settings = settings;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  async start(): Promise<boolean> {
    if (this.started) return true;
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;
      await ctx.resume();

      this.master = ctx.createGain();
      this.master.gain.value = this.settings.masterVolume;
      this.compressor = ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -12;
      this.compressor.knee.value = 22;
      this.compressor.ratio.value = 6;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.18;
      this.master.connect(this.compressor);
      this.compressor.connect(ctx.destination);

      this.dryGain = ctx.createGain();
      this.dryGain.gain.value = 1;
      this.wetGain = ctx.createGain();
      this.wetGain.gain.value = this.wetAmount;
      this.convolver = ctx.createConvolver();
      this.convolver.buffer = this.makeImpulse(1.6, 2.8);
      this.dryGain.connect(this.master);
      this.wetGain.connect(this.convolver);
      this.convolver.connect(this.master);

      this.sfxBus = ctx.createGain();
      this.voiceBus = ctx.createGain();
      this.musicBus = ctx.createGain();
      this.ambientGain = ctx.createGain();
      this.ambientGain.gain.value = 0.0;
      this.sfxBus.gain.value = this.settings.sfxVolume;
      this.voiceBus.gain.value = this.settings.voiceVolume;
      this.musicBus.gain.value = this.settings.musicVolume;
      for (const bus of [this.sfxBus, this.voiceBus, this.musicBus, this.ambientGain]) {
        bus.connect(this.dryGain);
        bus.connect(this.wetGain);
      }

      this.noiseBuffer = this.makeNoise(2.5, 0x9e3779b9);
      this.started = true;
      return true;
    } catch (err) {
      console.warn('[Audio] failed to initialise:', err);
      return false;
    }
  }

  get isRunning(): boolean {
    return this.started && this.ctx?.state === 'running';
  }

  get musicDestination(): GainNode | null {
    return this.musicBus;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get noiseSourceBuffer(): AudioBuffer | null {
    return this.noiseBuffer;
  }

  // -------------------------------------------------------------------------
  // Buffers
  // -------------------------------------------------------------------------

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buffer = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const early = i < rate * 0.045 ? 0.65 * Math.exp(-(i / (rate * 0.045)) * 4) : 0;
        data[i] = ((Math.random() * 2 - 1) * Math.pow(1 - t, decay) + early) * 0.5;
      }
    }
    return buffer;
  }

  private makeNoise(seconds: number, seed: number): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buffer = ctx.createBuffer(2, len, rate);
    let s = seed >>> 0;
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        data[i] = (s / 4294967296) * 2 - 1;
      }
    }
    return buffer;
  }

  // -------------------------------------------------------------------------
  // Mix / listener
  // -------------------------------------------------------------------------

  applySettings(s: GameSettings): void {
    this.settings = s;
    if (!this.started || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.master?.gain.setTargetAtTime(s.masterVolume, t, 0.05);
    this.sfxBus?.gain.setTargetAtTime(s.sfxVolume, t, 0.05);
    this.voiceBus?.gain.setTargetAtTime(s.voiceVolume, t, 0.05);
    this.musicBus?.gain.setTargetAtTime(s.musicVolume, t, 0.05);
  }

  /** Reverb blend for the current environment (interiors are wetter). */
  setEnvironment(wet: number): void {
    this.wetAmount = clamp01(wet);
    if (this.wetGain && this.ctx) this.wetGain.gain.setTargetAtTime(this.wetAmount, this.ctx.currentTime, 0.5);
  }

  /** Duck/muffle everything (Boomer bile, explosions nearby). */
  /**
   * Pre-build the noise buffer / reverb impulse. Safe to call before `start()`:
   * it does nothing until an AudioContext exists, and the engine calls it again
   * on the first user gesture.
   */
  warmup(): void {
    if (!this.ctx) return;
    // Touch the lazily-built nodes so the first shot never pays for them.
    this.noiseSourceBuffer;
    this.master;
    this.dryGain;
    this.wetGain;
  }

  setDeafen(amount: number): void {
    this.deafen = clamp01(amount);
    if (!this.ctx || !this.sfxBus) return;
    const t = this.ctx.currentTime;
    this.sfxBus.gain.setTargetAtTime(this.settings.sfxVolume * (1 - this.deafen * 0.55), t, 0.08);
  }

  setListener(position: THREE.Vector3, forward: THREE.Vector3): void {
    this.listenerPos.copy(position);
    if (!this.ctx) return;
    const listener = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (listener.positionX) {
      listener.positionX.setTargetAtTime(position.x, t, 0.02);
      listener.positionY.setTargetAtTime(position.y, t, 0.02);
      listener.positionZ.setTargetAtTime(position.z, t, 0.02);
      listener.forwardX.setTargetAtTime(forward.x, t, 0.02);
      listener.forwardY.setTargetAtTime(forward.y, t, 0.02);
      listener.forwardZ.setTargetAtTime(forward.z, t, 0.02);
      listener.upX.setTargetAtTime(0, t, 0.02);
      listener.upY.setTargetAtTime(1, t, 0.02);
      listener.upZ.setTargetAtTime(0, t, 0.02);
    } else {
      const legacy = listener as unknown as {
        setPosition?: (x: number, y: number, z: number) => void;
        setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
      };
      legacy.setPosition?.(position.x, position.y, position.z);
      legacy.setOrientation?.(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  // -------------------------------------------------------------------------
  // Voice rendering
  // -------------------------------------------------------------------------

  private outputFor(position: THREE.Vector3 | null | undefined, bus: GainNode | null, maxDistance: number): AudioNode {
    const ctx = this.ctx!;
    if (!position || !bus) return bus ?? ctx.destination;
    const dist = position.distanceTo(this.listenerPos);
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 2.4;
    panner.maxDistance = Math.max(20, maxDistance);
    panner.rolloffFactor = 1.0;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;
    panner.connect(bus);
    // Air absorption + wall thickness approximation.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(700, 15000 * Math.exp(-dist / 50));
    lp.Q.value = 0.5;
    lp.connect(panner);
    return lp;
  }

  /**
   * Render a recipe: schedules every layer at `t0`.
   * Returns the total duration in seconds.
   */
  private render(recipe: Recipe, opts: PlayOptions, bus: GainNode | null, t0: number): number {
    const ctx = this.ctx!;
    const out = this.outputFor(opts.position ?? null, bus, opts.maxDistance ?? 220);
    const volume = (opts.volume ?? 1) * (1 - this.deafen * 0.5);
    const pitch = opts.pitch ?? 1;
    let longest = 0;

    for (const layer of recipe) {
      const jitterF = 1 + (this.rand.next() * 2 - 1) * (layer.jitter ?? 0);
      const f0 = layer.f0 * jitterF * (layer.kind === 'tone' ? pitch : 1);
      const f1 = (layer.f1 ?? layer.f0) * jitterF * (layer.kind === 'tone' ? pitch : 1);
      let dur = layer.dur / (layer.kind === 'tone' ? Math.max(0.5, pitch) : 1);
      if (opts.duration !== undefined) dur = Math.min(dur, opts.duration);
      longest = Math.max(longest, dur);

      const env = ctx.createGain();
      const attack = layer.attack ?? 0.002;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(layer.gain * volume, t0 + attack);
      if (layer.curve === 'lin') {
        env.gain.linearRampToValueAtTime(0.0001, t0 + dur);
      } else {
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      }
      env.connect(out);

      if (layer.kind === 'noise') {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        src.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = layer.type as BiquadFilterType;
        filter.frequency.setValueAtTime(Math.max(30, f0), t0);
        if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
        filter.Q.value = layer.q ?? 1;
        src.connect(filter);
        filter.connect(env);
        // Random offset into the noise buffer keeps repeats from phase-matching.
        src.start(t0, this.rand.next() * 2);
        src.stop(t0 + dur + 0.05);
      } else {
        const osc = ctx.createOscillator();
        osc.type = (layer.type as OscillatorType) ?? 'sine';
        osc.frequency.setValueAtTime(Math.max(20, f0), t0);
        if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
        if (layer.spread) {
          // Thickness: detune a second oscillator slightly.
          const osc2 = ctx.createOscillator();
          osc2.type = osc.type;
          osc2.frequency.setValueAtTime(Math.max(20, f0 * (1 + layer.spread / 1200)), t0);
          if (f1 !== f0) osc2.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * (1 + layer.spread / 1200)), t0 + dur);
          osc2.connect(env);
          osc2.start(t0);
          osc2.stop(t0 + dur + 0.05);
        }
        osc.connect(env);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
      }
    }
    return longest;
  }

  /**
   * Play a synthesised sound.
   * @returns the sound's duration in seconds (0 when it was skipped).
   */
  play(id: SfxId, opts: PlayOptions = {}): number {
    if (!this.started || !this.ctx || this.ctx.state !== 'running') return 0;
    const recipe = RECIPES[id];
    if (!recipe) return 0;

    // Rate-limit identical cues so a horde does not stack 60 moans at once.
    const now = this.ctx.currentTime;
    const last = this.lastPlayed.get(id) ?? -99;
    const minGap = id.startsWith('zombie') || id.endsWith('_idle') ? 0.14 : 0.016;
    if (now - last < minGap) return 0;
    if (this.activeVoices >= this.maxVoices) return 0;
    this.lastPlayed.set(id, now);

    // Distance culling.
    if (opts.position) {
      const d = opts.position.distanceTo(this.listenerPos);
      const max = opts.maxDistance ?? 220;
      if (d > max) return 0;
    }

    const bus = opts.ui ? this.voiceBus : id.startsWith('survivor') || id.startsWith('hint') ? this.voiceBus : this.sfxBus;
    this.activeVoices++;
    const dur = this.render(recipe, opts, bus, now + 0.005);
    // Release the voice slot when the sound is done.
    window.setTimeout(
      () => {
        this.activeVoices = Math.max(0, this.activeVoices - 1);
      },
      Math.max(30, dur * 1000),
    );
    return dur;
  }

  /** Weapon-specific gunshot: pitch/timbre scaled by the weapon's sound spec. */
  gunshot(def: WeaponDef, position: THREE.Vector3): void {
    const id = def.sfx.shot as SfxId;
    const pitch = 0.94 + this.rand.next() * 0.12 - (def.sfx.loudness > 1.1 ? 0.08 : 0);
    const dur = this.play(id, { position, pitch, volume: 0.85 + def.sfx.loudness * 0.2, maxDistance: def.sfx.loudness < 0.5 ? 60 : 320 });
    void dur;
  }

  impactSurface(surface: string, position: THREE.Vector3): void {
    const map: Record<string, SfxId> = {
      concrete: 'impact_concrete',
      metal: 'impact_metal',
      wood: 'impact_wood',
      glass: 'impact_glass',
      flesh: 'impact_flesh',
      dirt: 'impact_dirt',
      water: 'impact_water',
      foliage: 'impact_foliage',
    };
    const id = map[surface] ?? 'impact_concrete';
    this.play(id, { position, pitch: 0.9 + this.rand.next() * 0.25, volume: 0.75 });
  }

  impactFlesh(position: THREE.Vector3, heavy = false): void {
    this.play('impact_flesh', { position, pitch: 0.85 + this.rand.next() * 0.3, volume: heavy ? 1.1 : 0.8 });
  }

  /** Subtle non-spatial confirmation tick when the player's shot connects. */
  hitmarker(headshot: boolean): void {
    this.play('ui_click', { ui: true, pitch: headshot ? 1.6 : 1.15, volume: headshot ? 0.5 : 0.28 });
  }

  /** Footstep with a surface-aware sound. */
  footstep(surface: string, position: THREE.Vector3, volume = 0.5): void {
    const map: Record<string, SfxId> = {
      concrete: 'footstep_concrete',
      metal: 'footstep_metal',
      wood: 'footstep_concrete',
      dirt: 'footstep_dirt',
      gravel: 'footstep_dirt',
      grass: 'footstep_dirt',
      water: 'footstep_water',
      flesh: 'footstep_dirt',
      foliage: 'footstep_dirt',
      glass: 'footstep_concrete',
    };
    this.play(map[surface] ?? 'footstep_concrete', {
      position,
      pitch: 0.9 + this.rand.next() * 0.2,
      volume,
      maxDistance: 45,
    });
  }

  /** Infected vocalisation with per-variant flavour. */
  zombieVoice(variant: ZombieVariant, kind: 'idle' | 'attack' | 'hurt' | 'die', position: THREE.Vector3): void {
    const base = variant === 'common' ? 'zombie' : variant;
    const id = `${base}_${kind}` as SfxId;
    const fallback: Record<string, SfxId> = {
      common_idle: 'zombie_moan',
      common_attack: 'zombie_attack',
      common_hurt: 'zombie_hurt',
      common_die: 'zombie_die',
      common_fast_idle: 'zombie_moan_fast',
      common_fast_attack: 'zombie_attack',
      common_fast_hurt: 'zombie_hurt',
      common_fast_die: 'zombie_die',
      common_armoured_idle: 'zombie_moan_deep',
      common_armoured_attack: 'zombie_attack',
      common_armoured_hurt: 'impact_metal',
      common_armoured_die: 'zombie_die',
    };
    const key = `${variant}_${kind}`;
    const resolved = RECIPES[id] ? id : (fallback[key] ?? 'zombie_moan');
    this.play(resolved, {
      position,
      pitch: 0.88 + this.rand.next() * 0.3,
      volume: kind === 'idle' ? 0.55 : 0.8,
      maxDistance: kind === 'idle' ? 70 : 140,
    });
  }

  /**
   * Emit a gameplay noise event (attracts infected) *and* the matching sound.
   * Kept together so audio and AI can never disagree about what made noise.
   */
  emitNoise(position: THREE.Vector3, loudness: number, source: 'gunshot' | 'explosion' | 'melee' | 'footstep' | 'door' | 'voice' | 'alarm' | 'glass' | 'zombie' = 'gunshot'): void {
    noise.emit(position, loudness, source, this.time);
  }

  /** Distant atmospheric one-shots (car alarms, collapsing structures, crows). */
  ambience(kind: 'distant_moan' | 'metal_creak' | 'distant_alarm', position: THREE.Vector3): void {
    switch (kind) {
      case 'distant_moan':
        this.play('zombie_moan_deep', { position, pitch: 0.7, volume: 0.35, maxDistance: 160 });
        break;
      case 'metal_creak':
        this.play('door_open', { position, pitch: 0.55, volume: 0.22, maxDistance: 90 });
        break;
      case 'distant_alarm':
        this.play('alarm', { position, pitch: 0.6, volume: 0.2, maxDistance: 200 });
        break;
    }
  }

  /**
   * Ambient bed: wind/rain/industrial hum. Built from filtered noise loops that
   * are created once and re-shaped when the environment changes.
   */
  setAmbient(kind: string, weather: string): void {
    if (!this.started || !this.ctx || !this.ambientGain) return;
    const key = `${kind}|${weather}`;
    if (key === this.ambientMood) return;
    this.ambientMood = key;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Tear down the previous bed.
    for (const n of this.ambientNodes) {
      try {
        (n as AudioBufferSourceNode).stop?.(t + 0.2);
      } catch {
        /* not a source */
      }
      n.disconnect();
    }
    this.ambientNodes.length = 0;

    const rainAmount = weather === 'rain' ? 1 : weather === 'storm' ? 1.4 : weather === 'snow' ? 0.2 : 0;
    const windAmount = weather === 'fog' ? 0.35 : weather === 'storm' ? 1 : weather === 'clear' ? 0.2 : 0.45;
    const industrial = kind.includes('industrial') || kind.includes('city_night') ? 1 : 0.25;

    // Base: low rumble.
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noiseBuffer;
    rumble.loop = true;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 180 + industrial * 120;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.06 + industrial * 0.05;
    rumble.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(this.ambientGain);
    rumble.start(t, 0.3);
    this.ambientNodes.push(rumble);

    // Wind: band-passed noise with a slow LFO on the filter frequency.
    if (windAmount > 0.05) {
      const wind = ctx.createBufferSource();
      wind.buffer = this.noiseBuffer;
      wind.loop = true;
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.value = 480;
      windFilter.Q.value = 0.7;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 220 * windAmount;
      lfo.connect(lfoGain);
      lfoGain.connect(windFilter.frequency);
      const windGain = ctx.createGain();
      windGain.gain.value = 0.05 * windAmount;
      wind.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(this.ambientGain);
      wind.start(t, 0.5);
      lfo.start(t);
      this.ambientNodes.push(wind, lfo);
    }

    // Rain: bright filtered noise, slightly modulated.
    if (rainAmount > 0.05) {
      const rain = ctx.createBufferSource();
      rain.buffer = this.noiseBuffer;
      rain.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 8000;
      const g = ctx.createGain();
      g.gain.value = 0.05 * rainAmount;
      rain.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(this.ambientGain);
      rain.start(t, 1.1);
      this.ambientNodes.push(rain);
    }

    this.ambientGain.gain.setTargetAtTime(1, t, 1.2);
  }

  setAmbientLevel(level: number): void {
    if (!this.ambientGain || !this.ctx) return;
    this.ambientGain.gain.setTargetAtTime(clamp01(level), this.ctx.currentTime, 0.6);
  }

  stopAmbient(): void {
    if (!this.ambientGain || !this.ctx) return;
    this.ambientGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
  }

  tick(dt: number): void {
    this.time += dt;
  }

  get timeSeconds(): number {
    return this.time;
  }

  /** Free everything (used on teardown). */
  async dispose(): Promise<void> {
    this.stopAmbient();
    if (this.ctx) await this.ctx.close();
    this.started = false;
    this.ctx = null;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export { RECIPES as SFX_RECIPES };
