/**
 * PROCEDURAL MATERIALS
 * ====================
 * Every texture in the game is generated at runtime on a canvas: no image
 * files, no download cost, no licensing questions, and the palette can be
 * re-tinted per chapter (a rainy downtown and a sunlit suburb share the same
 * recipe with different uniforms).
 *
 * How a surface is built
 * ----------------------
 *   1. A **colour pass** paints the albedo: base colour, large-scale blotches,
 *      then a material-specific detail pass (grout lines for tile, plank gaps
 *      for wood, aggregate speckle for asphalt, mortar for brick).
 *   2. A **height pass** reuses the same noise and detail rules, writing
 *      luminance into a second canvas.
 *   3. A **normal map** is derived from the height pass with a Sobel filter, and
 *      a **roughness map** is derived from the inverse of the height (pits are
 *      rougher than raised, polished areas).
 *
 * This is deliberately cheap: canvases are 256² and generated once per recipe
 * during the loading screen. The visual payoff is that flat, lit geometry reads
 * as real surfaces with normal-mapped grime rather than flat colours.
 */
import * as THREE from 'three';
import { Rng, clamp01 } from '@/core/MathUtil';

/**
 * The stable key set the level generator and renderer speak. Several keys map
 * onto the same procedural recipe (e.g. `roof` -> `roof_tile`), which keeps the
 * gameplay side simple while the renderer stays free to add detail variants.
 */
export type MaterialKey =
  | 'concrete'
  | 'brick'
  | 'asphalt'
  | 'wood'
  | 'metal'
  | 'tile'
  | 'plaster'
  | 'grass'
  | 'gravel'
  | 'roof'
  | 'sand'
  | 'flesh'
  | 'rust'
  | 'dirt'
  | 'glass'
  | 'water'
  | 'foliage';

/** MaterialKey -> procedural recipe. */
const KEY_TO_KIND: Record<MaterialKey, SurfaceKind> = {
  concrete: 'concrete',
  brick: 'brick',
  asphalt: 'asphalt',
  wood: 'wood',
  metal: 'metal',
  tile: 'tile',
  plaster: 'plaster',
  grass: 'grass',
  gravel: 'gravel',
  roof: 'roof_tile',
  sand: 'sandbag',
  flesh: 'flesh',
  rust: 'metal_rusted',
  dirt: 'dirt',
  glass: 'glass',
  water: 'water',
  foliage: 'foliage',
};

export type SurfaceKind =
  | 'concrete'
  | 'concrete_worn'
  | 'brick'
  | 'asphalt'
  | 'asphalt_wet'
  | 'wood'
  | 'plank'
  | 'metal'
  | 'metal_rusted'
  | 'tile'
  | 'plaster'
  | 'grass'
  | 'dirt'
  | 'gravel'
  | 'roof_tile'
  | 'sandbag'
  | 'glass'
  | 'flesh'
  | 'foliage'
  | 'water'
  | 'blood_ground'
  | 'brick_red'
  | 'concrete_dirty'
  | 'metal_painted'
  | 'wood_old';

interface Recipe {
  /** Base albedo. */
  base: number;
  /** Secondary colour used for blotches/speckle. */
  accent: number;
  /** Multiplier applied to the noise frequency (bigger = finer grain). */
  frequency: number;
  /** Contrast of the albedo noise. */
  contrast: number;
  /** Adds a regular pattern on top (grout, planks, bricks, tiles). */
  pattern?: 'brick' | 'tile' | 'planks' | 'shingles' | 'blocks';
  /** Pattern cell size in pixels. */
  patternScale?: number;
  /** Mortar/gap colour. */
  gapColor?: number;
  roughness: number;
  metalness: number;
  /** Overall height amplitude for the normal map. */
  bump: number;
  /** Tiling repetition hint (metres per tile). */
  metresPerTile: number;
  transparent?: boolean;
  emissive?: number;
}

const RECIPES: Record<SurfaceKind, Recipe> = {
  concrete: { base: 0x9a958c, accent: 0x7d7a72, frequency: 3.2, contrast: 0.22, roughness: 0.88, metalness: 0.02, bump: 0.55, metresPerTile: 4 },
  concrete_worn: { base: 0x8b867d, accent: 0x615e58, frequency: 4.4, contrast: 0.3, roughness: 0.9, metalness: 0.02, bump: 0.7, metresPerTile: 4 },
  concrete_dirty: { base: 0x7c766c, accent: 0x4e4a44, frequency: 5.2, contrast: 0.36, roughness: 0.92, metalness: 0.02, bump: 0.8, metresPerTile: 4 },
  brick: { base: 0x7d5a4a, accent: 0x5a4034, frequency: 6, contrast: 0.24, pattern: 'brick', patternScale: 32, gapColor: 0xa8a49a, roughness: 0.94, metalness: 0.01, bump: 1.1, metresPerTile: 2 },
  brick_red: { base: 0x8e4a3a, accent: 0x6a352a, frequency: 5, contrast: 0.26, pattern: 'brick', patternScale: 28, gapColor: 0x9e9a90, roughness: 0.93, metalness: 0.01, bump: 1.15, metresPerTile: 2 },
  asphalt: { base: 0x3d3f42, accent: 0x2a2c2f, frequency: 9, contrast: 0.4, roughness: 0.86, metalness: 0.03, bump: 0.5, metresPerTile: 6 },
  asphalt_wet: { base: 0x2f3236, accent: 0x22252a, frequency: 9, contrast: 0.42, roughness: 0.42, metalness: 0.12, bump: 0.45, metresPerTile: 6 },
  wood: { base: 0x8a6742, accent: 0x6b4c2f, frequency: 7, contrast: 0.3, pattern: 'planks', patternScale: 42, gapColor: 0x3c2c1c, roughness: 0.8, metalness: 0.01, bump: 0.8, metresPerTile: 3 },
  wood_old: { base: 0x6d5539, accent: 0x4a3a28, frequency: 8, contrast: 0.36, pattern: 'planks', patternScale: 38, gapColor: 0x2c2116, roughness: 0.88, metalness: 0.01, bump: 0.95, metresPerTile: 3 },
  plank: { base: 0x9a7a54, accent: 0x735a3c, frequency: 6, contrast: 0.28, pattern: 'planks', patternScale: 30, gapColor: 0x40301e, roughness: 0.85, metalness: 0.01, bump: 0.9, metresPerTile: 2.5 },
  metal: { base: 0x8b9096, accent: 0x6a7076, frequency: 5, contrast: 0.18, roughness: 0.38, metalness: 0.85, bump: 0.35, metresPerTile: 3 },
  metal_painted: { base: 0x53606b, accent: 0x3c4650, frequency: 4, contrast: 0.16, roughness: 0.48, metalness: 0.55, bump: 0.3, metresPerTile: 3 },
  metal_rusted: { base: 0x7a5636, accent: 0x4e3924, frequency: 6, contrast: 0.42, roughness: 0.8, metalness: 0.35, bump: 0.6, metresPerTile: 3 },
  tile: { base: 0xb9b6ad, accent: 0x8f8d86, frequency: 4, contrast: 0.14, pattern: 'tile', patternScale: 48, gapColor: 0x6d6b64, roughness: 0.35, metalness: 0.05, bump: 0.5, metresPerTile: 2.5 },
  plaster: { base: 0xa8a196, accent: 0x8b847a, frequency: 3.5, contrast: 0.18, roughness: 0.9, metalness: 0.01, bump: 0.35, metresPerTile: 3.5 },
  grass: { base: 0x4e5a34, accent: 0x39452a, frequency: 14, contrast: 0.42, roughness: 0.95, metalness: 0, bump: 1, metresPerTile: 3 },
  dirt: { base: 0x5b4a36, accent: 0x3f3324, frequency: 7, contrast: 0.34, roughness: 0.96, metalness: 0, bump: 0.7, metresPerTile: 4 },
  gravel: { base: 0x6b6459, accent: 0x4e4a42, frequency: 11, contrast: 0.45, roughness: 0.93, metalness: 0.02, bump: 0.9, metresPerTile: 3 },
  roof_tile: { base: 0x5c4a42, accent: 0x453833, frequency: 5, contrast: 0.24, pattern: 'shingles', patternScale: 26, gapColor: 0x2f2622, roughness: 0.85, metalness: 0.03, bump: 0.85, metresPerTile: 2.5 },
  sandbag: { base: 0x7d7055, accent: 0x5f5540, frequency: 10, contrast: 0.3, roughness: 0.92, metalness: 0.01, bump: 0.9, metresPerTile: 2 },
  glass: { base: 0x8fa4ad, accent: 0x6d8290, frequency: 2, contrast: 0.1, roughness: 0.12, metalness: 0.1, bump: 0.12, metresPerTile: 2, transparent: true },
  flesh: { base: 0x6d3b34, accent: 0x4d2a26, frequency: 8, contrast: 0.32, roughness: 0.7, metalness: 0.02, bump: 0.6, metresPerTile: 1 },
  foliage: { base: 0x3c4a2a, accent: 0x2b3620, frequency: 16, contrast: 0.4, roughness: 0.9, metalness: 0, bump: 0.8, metresPerTile: 2, transparent: true },
  water: { base: 0x2c3a3f, accent: 0x1e2a30, frequency: 3, contrast: 0.16, roughness: 0.06, metalness: 0.3, bump: 0.2, metresPerTile: 6 },
  blood_ground: { base: 0x4a1b18, accent: 0x2f1210, frequency: 6, contrast: 0.4, roughness: 0.55, metalness: 0.02, bump: 0.25, metresPerTile: 2 },
};

/** Runtime-generated texture set for one surface. */
export interface SurfaceTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  /** Multiplier colour so chapter themes can tint a shared recipe. */
  tint: THREE.Color;
}

export class ProceduralTextures {
  private cache = new Map<SurfaceKind, SurfaceTextures>();
  private size: number;

  constructor(size = 256) {
    this.size = size;
  }

  /** Generate (or fetch) the texture set for a surface kind. */
  get(kind: SurfaceKind): SurfaceTextures {
    const existing = this.cache.get(kind);
    if (existing) return existing;
    const recipe = RECIPES[kind];
    const rng = new Rng(hashString(kind));
    const { colorCanvas, heightCanvas } = this.paint(recipe, rng);
    const map = canvasTexture(colorCanvas);
    const normalMap = canvasTexture(normalFromHeight(heightCanvas, recipe.bump));
    const roughnessMap = canvasTexture(roughnessFromHeight(heightCanvas, recipe.roughness));
    const set: SurfaceTextures = { map, normalMap, roughnessMap, tint: new THREE.Color(0xffffff) };
    this.cache.set(kind, set);
    return set;
  }

  /** All recipes, used by the loader to pre-generate without hitching. */
  static kinds(): SurfaceKind[] {
    return Object.keys(RECIPES) as SurfaceKind[];
  }

  private paint(recipe: Recipe, rng: Rng): { colorCanvas: HTMLCanvasElement; heightCanvas: HTMLCanvasElement } {
    const size = this.size;
    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = size;
    colorCanvas.height = size;
    const heightCanvas = document.createElement('canvas');
    heightCanvas.width = size;
    heightCanvas.height = size;
    const cctx = colorCanvas.getContext('2d')!;
    const hctx = heightCanvas.getContext('2d')!;
    const cimg = cctx.createImageData(size, size);
    const himg = hctx.createImageData(size, size);

    const base = new THREE.Color(recipe.base);
    const accent = new THREE.Color(recipe.accent);
    const gap = new THREE.Color(recipe.gapColor ?? 0x000000);
    const freq = recipe.frequency / size;
    const seed = Math.floor(rng.next() * 1000);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        // Multi-octave value noise gives the "dirty, uneven" base.
        let n = fbm(x * freq, y * freq, seed, 4);
        // Second, coarser octave for large blotches (dirt spread, wear).
        const blotch = fbm(x * freq * 0.25 + 13.7, y * freq * 0.25 + 7.1, seed + 91, 3);
        n = n * 0.65 + blotch * 0.35;
        let r = base.r + (accent.r - base.r) * clamp01(n);
        let g = base.g + (accent.g - base.g) * clamp01(n);
        let b = base.b + (accent.b - base.b) * clamp01(n);
        // Contrast scaling around the base colour.
        r = base.r + (r - base.r) * (1 + recipe.contrast);
        g = base.g + (g - base.g) * (1 + recipe.contrast);
        b = base.b + (b - base.b) * (1 + recipe.contrast);

        let height = n * 0.6;

        // --- pattern overlays ---------------------------------------------
        if (recipe.pattern) {
          const cell = recipe.patternScale ?? 32;
          const px = x % cell;
          const py = y % cell;
          switch (recipe.pattern) {
            case 'brick': {
              const row = Math.floor(y / cell);
              const offset = row % 2 === 0 ? 0 : cell * 0.5;
              const bx = (x + offset) % cell;
              const mortar = px < 3 || py < 3;
              const staggerMortar = bx < 3;
              if (mortar || staggerMortar) {
                r = gap.r;
                g = gap.g;
                b = gap.b;
                height = 0.2;
              } else {
                // Per-brick tint variation.
                const brickRand = hash2(Math.floor((x + offset) / cell), row);
                r += (brickRand - 0.5) * 0.12;
                g += (brickRand - 0.5) * 0.1;
                b += (brickRand - 0.5) * 0.08;
                height = 0.75 + brickRand * 0.12;
              }
              break;
            }
            case 'tile': {
              const gapSize = 2;
              const jitter = Math.floor(hash2(Math.floor(x / cell), Math.floor(y / cell)) * 0.06);
              if (px < gapSize || py < gapSize) {
                r = gap.r + jitter;
                g = gap.g + jitter;
                b = gap.b + jitter;
                height = 0.15;
              } else {
                height = 0.85;
                // Grout shading darkens the tile edge.
                const edge = Math.min(px, py, cell - px, cell - py) / (cell * 0.25);
                const shade = 0.85 + clamp01(edge) * 0.15;
                r *= shade;
                g *= shade;
                b *= shade;
              }
              break;
            }
            case 'planks': {
              const plankHeight = cell;
              const py2 = y % plankHeight;
              const plankIndex = Math.floor(y / plankHeight);
              const offset = hash2(plankIndex, 3) * 12;
              const gapOk = py2 < 3;
              // Long grain streaks run along the plank.
              const grain = fbm((x + offset) * 0.06, y * 0.5, seed + plankIndex * 17, 3);
              r += (grain - 0.5) * 0.12;
              g += (grain - 0.5) * 0.1;
              b += (grain - 0.5) * 0.07;
              if (gapOk) {
                r = gap.r;
                g = gap.g;
                b = gap.b;
                height = 0.15;
              } else {
                height = 0.7 + grain * 0.2;
                // Occasional knot.
                if (hash2(plankIndex, Math.floor(x / 10)) > 0.985) {
                  r *= 0.7;
                  g *= 0.7;
                  b *= 0.7;
                  height = 0.45;
                }
              }
              break;
            }
            case 'shingles': {
              const shingleH = cell;
              const row = Math.floor(y / shingleH);
              const offset = row % 2 === 0 ? 0 : cell * 0.5;
              const sx = (x + offset) % cell;
              const sy = y % shingleH;
              if (sy < 2) {
                r = gap.r;
                g = gap.g;
                b = gap.b;
                height = 0.2;
              } else {
                const shade = 0.75 + (1 - sy / shingleH) * 0.35;
                r *= shade;
                g *= shade;
                b *= shade;
                height = 0.6 + (1 - sy / shingleH) * 0.35;
              }
              void sx;
              break;
            }
            case 'blocks': {
              if (px < 2 || py < 2) {
                r = gap.r;
                g = gap.g;
                b = gap.b;
                height = 0.2;
              } else {
                height = 0.8;
              }
              break;
            }
          }
        }

        // Slight edge darkening keeps tiles readable when repeated.
        const edgeFalloff = Math.min(x, y, size - 1 - x, size - 1 - y) / (size * 0.08);
        const tint = 0.94 + clamp01(edgeFalloff) * 0.06;

        cimg.data[i] = Math.round(clamp01(r * tint) * 255);
        cimg.data[i + 1] = Math.round(clamp01(g * tint) * 255);
        cimg.data[i + 2] = Math.round(clamp01(b * tint) * 255);
        cimg.data[i + 3] = 255;
        const hv = Math.round(clamp01(height) * 255);
        himg.data[i] = hv;
        himg.data[i + 1] = hv;
        himg.data[i + 2] = hv;
        himg.data[i + 3] = 255;
      }
    }
    cctx.putImageData(cimg, 0, 0);
    hctx.putImageData(himg, 0, 0);
    return { colorCanvas, heightCanvas };
  }
}

/** Clone a texture with an independent repeat (three stores `repeat` per Texture). */
function cloneWithRepeat(tex: THREE.Texture, repeat: number): THREE.Texture {
  const clone = tex.clone();
  clone.wrapS = tex.wrapS;
  clone.wrapT = tex.wrapT;
  clone.repeat.set(repeat, repeat);
  clone.needsUpdate = true;
  return clone;
}

/** Wrap a canvas as a repeating texture. */
function canvasTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * Sobel-derived normal map. The blue channel is left at full strength: with
 * `tangentSpaceNormalMap` the derivative is only used for XY, and the geometry
 * provides the tangent frame.
 */
function normalFromHeight(height: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const size = height.width;
  const src = height.getContext('2d')!.getImageData(0, 0, size, size).data;
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const at = (x: number, y: number): number => {
    const xx = (x + size) % size;
    const yy = (y + size) % size;
    return src[(yy * size + xx) * 4] / 255;
  };
  const s = strength * 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);
      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);
      let nx = dx * s;
      let ny = dy * s;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Roughness = base roughness modulated by height (pits stay rough). */
function roughnessFromHeight(height: HTMLCanvasElement, baseRoughness: number): HTMLCanvasElement {
  const size = height.width;
  const src = height.getContext('2d')!.getImageData(0, 0, size, size).data;
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < src.length; i += 4) {
    const h = src[i] / 255;
    // Low areas (grout, cracks, pits) are rougher; raised areas slightly shinier.
    const r = clamp01(baseRoughness + (1 - h) * 0.28 - 0.1);
    const v = Math.round(r * 255);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Material library
// ---------------------------------------------------------------------------

export interface MaterialOptions {
  /** Colour multiply applied on top of the texture (chapter tinting). */
  tint?: number;
  roughnessScale?: number;
  metalnessScale?: number;
  /** Emissive intensity for glowing surfaces. */
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  vertexColors?: boolean;
  /** Tiling in world metres per texture tile (defaults to the recipe's). */
  metresPerTile?: number;
}

/** Cache of ready-to-use materials keyed by surface + options + repeat. */
export class MaterialLibrary {
  readonly textures: ProceduralTextures;
  private cache = new Map<string, THREE.Material>();
  private version = 0;

  constructor(textures: ProceduralTextures) {
    this.textures = textures;
  }

  /**
   * Get a standard material for a surface.
   *
   * `uvScale` multiplies the texture tiling. Level geometry authored through
   * `GeometryBatcher` already produces UVs in "tiles", so it passes 1; props and
   * breakables that are modelled in metres pass their own density instead.
   */
  surface(materialKey: MaterialKey | SurfaceKind, uvScale = 1, opts: MaterialOptions = {}): THREE.MeshStandardMaterial {
    const kind = (KEY_TO_KIND as Record<string, SurfaceKind>)[materialKey] ?? (materialKey as SurfaceKind);
    const key = `${kind}|${uvScale}|${JSON.stringify(opts)}`;
    const cached = this.cache.get(key);
    if (cached) return cached as THREE.MeshStandardMaterial;
    const tex = this.textures.get(kind);
    const recipeTint = opts.tint ?? 0xffffff;
    // Textures are shared between materials, so a non-default tiling needs a
    // cloned Texture with its own repeat (three.js stores repeat on the texture).
    const map = uvScale === 1 ? tex.map : cloneWithRepeat(tex.map, uvScale);
    const normalMap = uvScale === 1 ? tex.normalMap : cloneWithRepeat(tex.normalMap, uvScale);
    const roughnessMap = uvScale === 1 ? tex.roughnessMap : cloneWithRepeat(tex.roughnessMap, uvScale);
    const mat = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      roughnessMap,
      color: new THREE.Color(recipeTint),
      roughness: 1,
      metalness: 1,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      side: opts.side ?? THREE.FrontSide,
      vertexColors: opts.vertexColors ?? true,
      emissive: new THREE.Color(opts.emissive ?? 0x000000),
      emissiveIntensity: opts.emissiveIntensity ?? 0,
      normalScale: new THREE.Vector2(1, 1),
    });
    if (opts.roughnessScale !== undefined) {
      // Scale via the map multiplier instead of the scalar (three multiplies them).
      (mat as unknown as { roughness: number }).roughness = opts.roughnessScale;
    }
    if (opts.metalnessScale !== undefined) mat.metalness = opts.metalnessScale;
    mat.userData.metresPerTile = opts.metresPerTile ?? this.recipeMetres(kind);
    this.cache.set(key, mat);
    this.version++;
    return mat;
  }

  /** Pre-generate the standard surface set (boot-time cost, avoids hitches). */
  warmupTextures(): void {
    // The generators are lazy; touching the common set swaps a mid-fight hitch
    // for a slightly longer load screen.
    const kinds: SurfaceKind[] = ['concrete', 'brick', 'asphalt', 'wood', 'metal', 'plaster', 'grass', 'dirt'];
    for (const kind of kinds) this.textures.get(kind);
  }

  /** Flat, untextured material for props and view models. */
  plain(
    color: number,
    opts: {
      roughness?: number;
      metalness?: number;
      emissive?: number;
      emissiveIntensity?: number;
      toneMapped?: boolean;
      vertexColors?: boolean;
      transparent?: boolean;
      opacity?: number;
    } = {},
  ): THREE.MeshStandardMaterial {
    const key = `plain:${color}:${JSON.stringify(opts)}`;
    const cached = this.cache.get(key);
    if (cached) return cached as THREE.MeshStandardMaterial;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: opts.roughness ?? 0.8,
      metalness: opts.metalness ?? 0.05,
      emissive: new THREE.Color(opts.emissive ?? 0x000000),
      emissiveIntensity: opts.emissiveIntensity ?? (opts.emissive ? 1 : 0),
      toneMapped: opts.toneMapped ?? true,
      vertexColors: opts.vertexColors ?? false,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
    });
    this.cache.set(key, mat);
    this.version++;
    return mat;
  }

  /**
   * Character/zombie skin: a textured standard material tinted per archetype,
   * sharing the `flesh` recipe so the horde looks related but not identical.
   */
  character(tint: number, opts: MaterialOptions = {}): THREE.MeshStandardMaterial {
    return this.surface('flesh', 1, { tint, roughnessScale: 0.72, ...opts });
  }

  /** Unlit sprite-style material for particles and billboards. */
  sprite(map: THREE.Texture, blending: THREE.Blending = THREE.AdditiveBlending, opacity = 1, tint = 0xffffff): THREE.MeshBasicMaterial {
    const key = `sprite:${map.uuid}:${blending}:${opacity}:${tint}`;
    const cached = this.cache.get(key);
    if (cached) return cached as THREE.MeshBasicMaterial;
    const mat = new THREE.MeshBasicMaterial({
      map,
      color: new THREE.Color(tint),
      transparent: true,
      opacity,
      blending,
      depthWrite: false,
      toneMapped: blending === THREE.NormalBlending ? false : true,
    });
    this.cache.set(key, mat);
    return mat;
  }

  /** Distance-faded decal material (blood, scorch, bullet holes). */
  decal(map: THREE.Texture, tint: number, opacity = 0.85): THREE.MeshBasicMaterial {
    const key = `decal:${map.uuid}:${tint}:${opacity}`;
    const cached = this.cache.get(key);
    if (cached) return cached as THREE.MeshBasicMaterial;
    const mat = new THREE.MeshBasicMaterial({
      map,
      color: new THREE.Color(tint),
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false,
    });
    this.cache.set(key, mat);
    return mat;
  }

  /** Retint every cached `surface()` material for a new chapter palette. */
  applyTheme(tints: Partial<Record<SurfaceKind, number>>): void {
    for (const [key, mat] of this.cache) {
      if (!key.startsWith('surface:')) continue;
      const kind = key.split('|')[0] as SurfaceKind;
      const tint = tints[kind];
      if (tint === undefined) continue;
      (mat as THREE.MeshStandardMaterial).color.setHex(tint);
    }
  }

  private recipeMetres(kind: SurfaceKind): number {
    // Recipes carry their own tile size; keep it in sync with the batcher.
    return RECIPES[kind]?.metresPerTile ?? 4;
  }

  /** Number of cached materials (reported by the debug overlay). */
  get size(): number {
    return this.cache.size;
  }

  get cacheVersion(): number {
    return this.version;
  }
}

// ---------------------------------------------------------------------------
// Helper noise (mirrors core/MathUtil but kept local to avoid a dependency)
// ---------------------------------------------------------------------------

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash2(xi + seed, yi);
  const b = hash2(xi + 1 + seed, yi);
  const c = hash2(xi + seed, yi + 1);
  const d = hash2(xi + 1 + seed, yi + 1);
  const u = smooth(xf);
  const v = smooth(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let value = 0;
  let amplitude = 0.5;
  let total = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    value += valueNoise(fx, fy, seed + i * 31) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    fx *= 2.07;
    fy *= 2.03;
  }
  return value / Math.max(0.0001, total);
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Pre-generate every surface texture (used by the loading screen). */
export function warmupTextures(size = 256): ProceduralTextures {
  const textures = new ProceduralTextures(size);
  for (const kind of ProceduralTextures.kinds()) textures.get(kind);
  return textures;
}

export { RECIPES as SURFACE_RECIPES };

// ---------------------------------------------------------------------------
// VFX sprites
// ---------------------------------------------------------------------------

/**
 * Small canvas sprites for particles, decals and the muzzle flash. These are
 * alpha PNGs generated at boot: a soft radial falloff plus a little noise is
 * enough to read as smoke, blood, dust or light bloom in motion.
 */
export class VfxTextures {
  readonly muzzle: THREE.Texture;
  readonly smoke: THREE.Texture;
  readonly spark: THREE.Texture;
  readonly blood: THREE.Texture;
  readonly bloodDecal: THREE.Texture;
  readonly bulletHole: THREE.Texture;
  readonly scorch: THREE.Texture;
  readonly splash: THREE.Texture;
  readonly bullet: THREE.Texture;
  readonly ring: THREE.Texture;
  readonly glow: THREE.Texture;
  readonly gib: THREE.Texture;
  /** Long thin streak used for rain and fast-moving debris. */
  readonly rainStreak: THREE.Texture;
  // --- aliases kept for readability at call sites -------------------------
  /** Blood splat (alias of `blood`). */
  readonly bloodSplatter: THREE.Texture;
  /** Alias of the muzzle flash sprite. */
  readonly flash: THREE.Texture;
  /** Bile/acid splat (alias of `splash`). */
  readonly bileSplat: THREE.Texture;

  constructor() {
    this.muzzle = makeSprite(64, (ctx, size, rnd) => {
      // A four-point star plus a hot core: reads as a flash at any size.
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255,255,240,1)');
      g.addColorStop(0.25, 'rgba(255,214,140,0.9)');
      g.addColorStop(0.6, 'rgba(255,150,60,0.35)');
      g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * Math.PI * 2 + rnd() * 0.4;
        ctx.save();
        ctx.translate(size / 2, size / 2);
        ctx.rotate(angle);
        ctx.fillStyle = 'rgba(255,230,180,0.55)';
        ctx.beginPath();
        ctx.moveTo(0, -1.5);
        ctx.lineTo(size * 0.5, 0);
        ctx.lineTo(0, 1.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    });
    this.smoke = makeSprite(64, (ctx, size, rnd) => {
      for (let i = 0; i < 26; i++) {
        const x = size / 2 + (rnd() - 0.5) * size * 0.55;
        const y = size / 2 + (rnd() - 0.5) * size * 0.55;
        const r = size * (0.08 + rnd() * 0.22);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const v = 150 + Math.floor(rnd() * 70);
        g.addColorStop(0, `rgba(${v},${v},${v},${0.28 + rnd() * 0.3})`);
        g.addColorStop(1, 'rgba(80,80,80,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    });
    this.spark = makeSprite(32, (ctx, size) => {
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255,255,220,1)');
      g.addColorStop(0.3, 'rgba(255,200,90,0.85)');
      g.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    });
    this.blood = makeSprite(48, (ctx, size, rnd) => {
      // A rough, organic splat with satellite droplets.
      ctx.fillStyle = 'rgba(120,12,10,0.95)';
      for (let i = 0; i < 14; i++) {
        const x = size / 2 + (rnd() - 0.5) * size * 0.4;
        const y = size / 2 + (rnd() - 0.5) * size * 0.4;
        const r = size * (0.06 + rnd() * 0.16);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 0; i < 18; i++) {
        const a = rnd() * Math.PI * 2;
        const d = size * (0.2 + rnd() * 0.28);
        const r = size * (0.012 + rnd() * 0.03);
        ctx.beginPath();
        ctx.arc(size / 2 + Math.cos(a) * d, size / 2 + Math.sin(a) * d, r, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    this.bloodDecal = makeSprite(64, (ctx, size, rnd) => {
      ctx.fillStyle = 'rgba(74,10,8,0.9)';
      for (let i = 0; i < 20; i++) {
        const x = size / 2 + (rnd() - 0.5) * size * 0.7;
        const y = size / 2 + (rnd() - 0.5) * size * 0.7;
        const r = size * (0.05 + rnd() * 0.2);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // A few streaks, as if something bled and was dragged.
      ctx.strokeStyle = 'rgba(74,10,8,0.75)';
      for (let i = 0; i < 4; i++) {
        ctx.lineWidth = size * (0.02 + rnd() * 0.04);
        ctx.beginPath();
        ctx.moveTo(size / 2 + (rnd() - 0.5) * size * 0.3, size / 2 + (rnd() - 0.5) * size * 0.3);
        ctx.lineTo(size / 2 + (rnd() - 0.5) * size * 0.9, size / 2 + (rnd() - 0.5) * size * 0.9);
        ctx.stroke();
      }
    });
    this.bulletHole = makeSprite(32, (ctx, size, rnd) => {
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(10,8,6,0.95)');
      g.addColorStop(0.45, 'rgba(40,36,32,0.7)');
      g.addColorStop(0.8, 'rgba(120,116,110,0.25)');
      g.addColorStop(1, 'rgba(120,116,110,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      // Radial cracks.
      ctx.strokeStyle = 'rgba(200,200,200,0.25)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 7; i++) {
        const a = rnd() * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(size / 2, size / 2);
        ctx.lineTo(size / 2 + Math.cos(a) * size * (0.25 + rnd() * 0.22), size / 2 + Math.sin(a) * size * (0.25 + rnd() * 0.22));
        ctx.stroke();
      }
    });
    this.scorch = makeSprite(64, (ctx, size, rnd) => {
      ctx.fillStyle = 'rgba(12,10,9,0.92)';
      for (let i = 0; i < 22; i++) {
        const a = rnd() * Math.PI * 2;
        const d = rnd() * size * 0.42;
        const r = size * (0.08 + rnd() * 0.2);
        ctx.beginPath();
        ctx.arc(size / 2 + Math.cos(a) * d, size / 2 + Math.sin(a) * d, r, 0, Math.PI * 2);
        ctx.fill();
      }
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(0,0,0,0.65)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    });
    this.splash = makeSprite(48, (ctx, size, rnd) => {
      for (let i = 0; i < 10; i++) {
        const x = size / 2 + (rnd() - 0.5) * size * 0.7;
        const y = size / 2 + (rnd() - 0.5) * size * 0.7;
        const r = size * (0.04 + rnd() * 0.14);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(190,190,190,0.5)');
        g.addColorStop(1, 'rgba(140,140,140,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    });
    this.bullet = makeSprite(16, (ctx, size) => {
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.5, 'rgba(255,230,170,0.6)');
      g.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    });
    this.ring = makeSprite(64, (ctx, size) => {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = size * 0.06;
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2);
      ctx.stroke();
    });
    this.glow = makeSprite(64, (ctx, size) => {
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.4, 'rgba(255,240,220,0.25)');
      g.addColorStop(1, 'rgba(255,240,220,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    });
    this.rainStreak = makeSprite(16, (ctx, size) => {
      const g = ctx.createLinearGradient(0, 0, 0, size);
      g.addColorStop(0, 'rgba(200,215,230,0)');
      g.addColorStop(0.5, 'rgba(210,225,240,0.5)');
      g.addColorStop(1, 'rgba(200,215,230,0)');
      ctx.fillStyle = g;
      ctx.fillRect(size * 0.4, 0, size * 0.2, size);
    });
    this.gib = makeSprite(32, (ctx, size, rnd) => {
      ctx.fillStyle = 'rgba(90,10,8,0.95)';
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.arc(size / 2 + (rnd() - 0.5) * size * 0.5, size / 2 + (rnd() - 0.5) * size * 0.5, size * (0.06 + rnd() * 0.15), 0, Math.PI * 2);
        ctx.fill();
      }
    });
    this.bloodSplatter = this.blood;
    this.flash = this.muzzle;
    this.bileSplat = this.splash;
  }
}

/** Build a sprite canvas with a custom painter. */
function makeSprite(size: number, paint: (ctx: CanvasRenderingContext2D, size: number, rnd: () => number) => void): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  const rnd = new Rng(0xbeef ^ size);
  paint(ctx, size, () => rnd.next());
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
