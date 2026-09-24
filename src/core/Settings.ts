/**
 * SETTINGS + QUALITY PRESETS
 * ==========================
 * One serialisable object drives: input sensitivity, audio mix, rendering
 * quality and difficulty. Persisted to localStorage so a player never has to
 * re-tune the game.
 *
 * Quality tiers are *declarative*: every system reads `settings.quality.*`
 * rather than testing a string, so adding a tier only means adding a preset.
 */
import { bus } from '@/core/Events';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';
export type Difficulty = 'easy' | 'normal' | 'hard' | 'expert';

/** How much blood/gib VFX the effects system is allowed to spawn. */
export type GoreLevel = 'off' | 'reduced' | 'full';

export interface QualitySettings {
  tier: QualityTier;
  /** Device pixel ratio clamp (1 = no supersampling). */
  pixelRatio: number;
  /** Shadow map resolution (0 disables shadows entirely). */
  shadowMapSize: number;
  shadows: boolean;
  /** Maximum dynamic point lights kept alive at once. */
  maxDynamicLights: number;
  /** Enable the bloom / colour-grade post chain. */
  postProcessing: boolean;
  /** Bloom strength. */
  bloom: number;
  /** Screen-space ambient occlusion approximation (SSAO-lite via vertex darkening). */
  ambientOcclusion: boolean;
  anisotropy: number;
  /** Maximum simultaneously animated (skinned) zombies before switching to LOD. */
  maxAnimatedZombies: number;
  /** Zombies beyond this distance freeze their animation. */
  animationDistance: number;
  /** Distance at which zombies render as low-detail proxies / are culled. */
  zombieLodDistance: number;
  /** Hard cap on live zombies (Director respects this). */
  maxLiveZombies: number;
  /** Ragdoll/gib particle budget. */
  maxParticles: number;
  /** Decals kept alive. */
  maxDecals: number;
  /** Render distance for props. */
  viewDistance: number;
  /** Fog distance. */
  fogDistance: number;
  /** Anti-aliasing (MSAA samples when post is off). */
  msaa: number;
  /** Model detail: extra geometry on characters/props. */
  detailGeometry: boolean;
  /** Use instanced sub-draws for limbs (nicer animation, more CPU). */
  animatedLimbs: boolean;
  /** Volumetric-ish light shafts (screen quad). */
  godRays: boolean;
  /** Gore amount (0 disables gibs and heavy blood for a cleaner look). */
  goreLevel: GoreLevel;
}

export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low',
    pixelRatio: 0.85,
    shadowMapSize: 0,
    shadows: false,
    maxDynamicLights: 2,
    postProcessing: false,
    bloom: 0,
    ambientOcclusion: false,
    anisotropy: 1,
    maxAnimatedZombies: 38,
    animationDistance: 45,
    zombieLodDistance: 95,
    maxLiveZombies: 42,
    maxParticles: 350,
    goreLevel: 'reduced',
    maxDecals: 24,
    viewDistance: 130,
    fogDistance: 90,
    msaa: 0,
    detailGeometry: false,
    animatedLimbs: false,
    godRays: false,
  },
  medium: {
    tier: 'medium',
    pixelRatio: 1,
    shadowMapSize: 1024,
    shadows: true,
    maxDynamicLights: 4,
    postProcessing: true,
    bloom: 0.55,
    ambientOcclusion: true,
    anisotropy: 4,
    maxAnimatedZombies: 80,
    animationDistance: 70,
    zombieLodDistance: 150,
    maxLiveZombies: 75,
    maxParticles: 900,
    goreLevel: 'full',
    maxDecals: 64,
    viewDistance: 220,
    fogDistance: 150,
    msaa: 0,
    detailGeometry: true,
    animatedLimbs: true,
    godRays: true,
  },
  high: {
    tier: 'high',
    pixelRatio: 1,
    shadowMapSize: 2048,
    shadows: true,
    maxDynamicLights: 8,
    postProcessing: true,
    bloom: 0.7,
    ambientOcclusion: true,
    anisotropy: 8,
    maxAnimatedZombies: 140,
    animationDistance: 95,
    zombieLodDistance: 220,
    maxLiveZombies: 110,
    maxParticles: 1800,
    goreLevel: 'full',
    maxDecals: 110,
    viewDistance: 320,
    fogDistance: 210,
    msaa: 2,
    detailGeometry: true,
    animatedLimbs: true,
    godRays: true,
  },
  ultra: {
    tier: 'ultra',
    pixelRatio: 1.25,
    shadowMapSize: 4096,
    shadows: true,
    maxDynamicLights: 12,
    postProcessing: true,
    bloom: 0.85,
    ambientOcclusion: true,
    anisotropy: 16,
    maxAnimatedZombies: 220,
    animationDistance: 130,
    zombieLodDistance: 320,
    maxLiveZombies: 160,
    maxParticles: 3200,
    goreLevel: 'full',
    maxDecals: 180,
    viewDistance: 450,
    fogDistance: 280,
    msaa: 4,
    detailGeometry: true,
    animatedLimbs: true,
    godRays: true,
  },
};

export interface GameSettings {
  version: number;
  // input
  mouseSensitivity: number;
  adsSensitivityMultiplier: number;
  invertY: boolean;
  fov: number;
  // audio
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  voiceVolume: number;
  // gameplay
  difficulty: Difficulty;
  friendlyFire: boolean;
  subtitles: boolean;
  crosshairStyle: 'dot' | 'cross' | 'dynamic';
  showDamageNumbers: boolean;
  viewBob: number;
  autoReload: boolean;
  toggleAds: boolean;
  holdToSprint: boolean;
  /** Director intensity HUD indicator. */
  showDirectorIndicator: boolean;
  /** Screen shake intensity multiplier. */
  screenShake: number;
  goreLevel: GoreLevel;
  // video
  quality: QualitySettings;
  /** Auto-drop quality when frame times spike (protects low-end devices). */
  adaptiveQuality: boolean;
  // accessibility
  uiScale: number;
  highContrastHud: boolean;
  colorblindMode: 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia';
}

const STORAGE_KEY = 'deadlight.settings.v1';

export const DEFAULT_SETTINGS: GameSettings = {
  version: 1,
  mouseSensitivity: 1,
  adsSensitivityMultiplier: 0.65,
  invertY: false,
  fov: 85,
  masterVolume: 0.9,
  sfxVolume: 1,
  musicVolume: 0.65,
  voiceVolume: 1,
  difficulty: 'normal',
  friendlyFire: true,
  subtitles: true,
  crosshairStyle: 'dynamic',
  showDamageNumbers: true,
  viewBob: 1,
  autoReload: true,
  toggleAds: false,
  holdToSprint: true,
  showDirectorIndicator: true,
  screenShake: 1,
  goreLevel: 'full',
  quality: { ...QUALITY_PRESETS.high },
  adaptiveQuality: true,
  uiScale: 1,
  highContrastHud: false,
  colorblindMode: 'off',
};

/** Detect a reasonable starting tier from the hardware we can see. */
export function detectDefaultTier(): QualityTier {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return 'low';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    const lower = renderer.toLowerCase();
    // Integrated / mobile parts: start conservative, the adaptive system can climb.
    if (/intel|uhd|hd graphics|apple m1|mali|adreno|powervr|swiftshader|llvmpipe/.test(lower)) return 'medium';
    if (/rtx|radeon rx|arc a|apple m[2-9]/.test(lower)) return 'high';
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (mem !== undefined && mem <= 4) return 'medium';
    return 'high';
  } catch {
    return 'medium';
  }
}

export class SettingsStore {
  private data: GameSettings = structuredClone(DEFAULT_SETTINGS);

  constructor() {
    this.load();
    if (!this.detectCapabilities().webgl2) {
      this.data.quality = { ...QUALITY_PRESETS.low };
    }
  }

  get current(): GameSettings {
    return this.data;
  }

  get quality(): QualitySettings {
    return this.data.quality;
  }

  /** Replace the whole settings object (menus bind to this). */
  apply(next: Partial<GameSettings>): void {
    this.data = { ...this.data, ...next };
    this.save();
    bus.emit('game:state', { state: 'settings-changed', previous: 'settings-changed' });
  }

  setQualityTier(tier: QualityTier): void {
    this.data.quality = { ...QUALITY_PRESETS[tier] };
    this.save();
    bus.emit('quality-changed', { tier: this.data.quality.tier });
  }

  /**
   * Patch individual quality fields without changing tier — the settings menu
   * lets players turn shadows or post-processing off independently.
   */
  patchQuality(patch: Partial<QualitySettings>): void {
    this.data.quality = { ...this.data.quality, ...patch };
    this.save();
    bus.emit('quality-changed', { tier: this.data.quality.tier });
  }

  /**
   * Degrade gracefully when the frame budget is blown. Called by the adaptive
   * quality controller in `main.ts`; returns the new tier when it changed.
   */
  stepDownQuality(): QualityTier | null {
    const order: QualityTier[] = ['ultra', 'high', 'medium', 'low'];
    const idx = order.indexOf(this.data.quality.tier);
    if (idx < 0 || idx >= order.length - 1) return null;
    const next = order[idx + 1];
    this.setQualityTier(next);
    return next;
  }

  stepUpQuality(): QualityTier | null {
    const order: QualityTier[] = ['low', 'medium', 'high', 'ultra'];
    const idx = order.indexOf(this.data.quality.tier);
    if (idx < 0 || idx >= order.length - 1) return null;
    const next = order[idx + 1];
    this.setQualityTier(next);
    return next;
  }

  reset(): void {
    this.data = structuredClone(DEFAULT_SETTINGS);
    this.data.quality = { ...QUALITY_PRESETS[detectDefaultTier()] };
    this.save();
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* private-mode / quota — settings simply won't persist */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        this.data.quality = { ...QUALITY_PRESETS[detectDefaultTier()] };
        return;
      }
      const parsed = JSON.parse(raw) as Partial<GameSettings>;
      const qualityTier = parsed.quality?.tier;
      this.data = { ...DEFAULT_SETTINGS, ...parsed };
      // Re-hydrate the quality block from a preset so newly added fields exist.
      if (qualityTier && QUALITY_PRESETS[qualityTier]) {
        this.data.quality = { ...QUALITY_PRESETS[qualityTier], ...parsed.quality };
      } else {
        this.data.quality = { ...QUALITY_PRESETS[detectDefaultTier()] };
      }
    } catch {
      this.data = structuredClone(DEFAULT_SETTINGS);
    }
  }

  detectCapabilities(): { webgl2: boolean; webgpu: boolean; maxTextureSize: number } {
    const result = { webgl2: false, webgpu: false, maxTextureSize: 2048 };
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      if (gl) {
        result.webgl2 = true;
        result.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      }
      result.webgpu = typeof (navigator as Navigator & { gpu?: unknown }).gpu !== 'undefined';
    } catch {
      /* ignore */
    }
    return result;
  }
}

export const settingsStore = new SettingsStore();

/** Difficulty profiles consumed by the Director and damage systems. */
export interface DifficultyDef {
  id: Difficulty;
  name: string;
  label: string;
  /** Multiplier on damage dealt BY zombies to survivors. */
  zombieDamage: number;
  /** Multiplier on damage dealt by survivors to zombies. */
  survivorDamage: number;
  /** Multiplier on Director spawn budgets. */
  spawnBudget: number;
  /** Multiplier on how quickly Director intensity ramps. */
  pacingRate: number;
  /** Multiplier on item spawn frequency. */
  itemFrequency: number;
  /** Multiplier on special infected spawn frequency. */
  specialFrequency: number;
  /** Multiplier on health/ammo found in the world. */
  resourceRichness: number;
  /** How long survivors stay incapacitated before dying (seconds). */
  reviveWindow: number;
  /** Whether teammates can be permanently lost (expert). */
  permadeath: boolean;
  /** Extra health multiplier on specials. */
  specialHealth: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyDef> = {
  easy: {
    id: 'easy',
    name: 'easy',
    label: 'Recruit',
    zombieDamage: 0.55,
    survivorDamage: 1.25,
    spawnBudget: 0.6,
    pacingRate: 0.75,
    itemFrequency: 1.6,
    specialFrequency: 0.6,
    resourceRichness: 1.5,
    reviveWindow: 140,
    permadeath: false,
    specialHealth: 0.8,
  },
  normal: {
    id: 'normal',
    name: 'normal',
    label: 'Survivor',
    zombieDamage: 1,
    survivorDamage: 1,
    spawnBudget: 1,
    pacingRate: 1,
    itemFrequency: 1,
    specialFrequency: 1,
    resourceRichness: 1,
    reviveWindow: 100,
    permadeath: false,
    specialHealth: 1,
  },
  hard: {
    id: 'hard',
    name: 'hard',
    label: 'Advanced',
    zombieDamage: 1.4,
    survivorDamage: 0.95,
    spawnBudget: 1.35,
    pacingRate: 1.2,
    itemFrequency: 0.8,
    specialFrequency: 1.35,
    resourceRichness: 0.8,
    reviveWindow: 80,
    permadeath: false,
    specialHealth: 1.15,
  },
  expert: {
    id: 'expert',
    name: 'expert',
    label: 'Expert',
    zombieDamage: 1.9,
    survivorDamage: 0.9,
    spawnBudget: 1.75,
    pacingRate: 1.45,
    itemFrequency: 0.6,
    specialFrequency: 1.75,
    resourceRichness: 0.65,
    reviveWindow: 60,
    permadeath: true,
    specialHealth: 1.35,
  },
};

export function difficultyDef(d: Difficulty): DifficultyDef {
  return DIFFICULTIES[d] ?? DIFFICULTIES.normal;
}
