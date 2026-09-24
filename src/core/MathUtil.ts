/**
 * Deterministic seeded RNG + math helpers.
 *
 * A single seeded generator (splitmix32 → xorshift) is used for all gameplay
 * randomness so that a run can be reproduced exactly from its seed — a hard
 * requirement for the "record a run and replay it" debugging workflow, and for
 * eventual client-side prediction in the multiplayer roadmap.
 */

export class Rng {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0 || 1;
  }

  /** Re-seed the generator (e.g. at the start of a chapter). */
  reseed(seed: number): void {
    this.state = seed >>> 0 || 1;
  }

  /** Raw 32-bit unsigned integer. */
  nextUint(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x || 0x9e3779b9;
    return this.state;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextUint() / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniformly pick an element. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Weighted pick: entries are [value, weight]. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const e of entries) total += e[1];
    let r = this.next() * total;
    for (const e of entries) {
      r -= e[1];
      if (r <= 0) return e[0];
    }
    return entries[entries.length - 1][0];
  }

  /** Gaussian-ish value in [-1,1] via the sum of three uniforms (cheap, no tails). */
  bell(): number {
    return (this.next() + this.next() + this.next()) / 1.5 - 1;
  }
}

/** Global gameplay RNG. Systems that need independence create their own `new Rng(seed)`. */
export const rng = new Rng(0x1f2e3d4c);

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Frame-rate independent exponential smoothing. `rate` ≈ 1/seconds-to-converge. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-rate * dt));
export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Shortest signed angular difference (b - a) wrapped to [-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Move `current` toward `target` by at most `maxDelta` radians. */
export function rotateToward(current: number, target: number, maxDelta: number): number {
  const d = angleDelta(current, target);
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Cheap deterministic value noise (2D) — used for procedural textures and wind sway. */
export function hash2(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smoothstep(xf);
  const v = smoothstep(yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Fractal Brownian motion over `valueNoise2`. */
export function fbm2(x: number, y: number, octaves = 4, lacunarity = 2.03, gain = 0.5): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Frame-time statistics with a rolling window (used by the perf HUD + auto-quality). */
export class PerfMonitor {
  private samples: number[] = [];
  private idx = 0;
  private readonly size: number;
  /** Smoothed frame time in ms. */
  avgMs = 16.7;
  /** 1% low frame time in ms — the number that actually describes "feel". */
  worstMs = 16.7;
  fps = 60;

  constructor(size = 90) {
    this.size = size;
    this.samples = new Array(size).fill(16.7);
  }

  push(ms: number): void {
    this.samples[this.idx] = ms;
    this.idx = (this.idx + 1) % this.size;
    let sum = 0;
    let worst = 0;
    for (let i = 0; i < this.size; i++) {
      const s = this.samples[i];
      sum += s;
      if (s > worst) worst = s;
    }
    this.avgMs = sum / this.size;
    this.worstMs = worst;
    this.fps = 1000 / Math.max(0.001, this.avgMs);
  }
}
