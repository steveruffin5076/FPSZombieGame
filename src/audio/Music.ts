/**
 * ADAPTIVE MUSIC DIRECTOR
 * =======================
 * A step sequencer that synthesises the score live, so it can react to the AI
 * Director frame-by-frame instead of crossfading pre-recorded stems.
 *
 * Layers (gains driven by intensity + mood):
 *   drone   — a low detuned pair that never stops; the "wrongness" layer.
 *   bass    — pulses on the pattern, filtered by intensity.
 *   pad     — sustained chord tones, only audible during tension and above.
 *   perc    — kick/hat pattern; the tempo itself scales with intensity.
 *   strings — dissonant stabs used for Tank/Witch reveals.
 *   horde   — tribal double-kick + rising noise sweep at peak intensity.
 *
 * Moods change the pattern table, tempo bounds and harmonic material. Intensity
 * (0..1) from the Director drives tempo, filter cutoff, dissonance and which
 * layers are audible — so quiet exploration is a drone, and a Tank fight is a
 * full rhythmic assault, without any hard cuts.
 */
import { clamp01, lerp } from '@/core/MathUtil';
import type { AudioSystem } from '@/audio/Audio';

export type Mood = 'calm' | 'tension' | 'combat' | 'panic' | 'relief' | 'horror';

interface MoodDef {
  tempoMin: number;
  tempoMax: number;
  /** 16-step patterns (1 = hit, 0 = rest). */
  kick: number[];
  snare: number[];
  hat: number[];
  bass: number[];
  /** Semitone offsets from the root, one octave span. */
  chord: number[];
  root: number;
  /** Dissonance amount (detune + minor-second stack). */
  dissonance: number;
  /** Layer enable thresholds. */
  padAt: number;
  percAt: number;
  stringsAt: number;
  hordeAt: number;
}

const MOODS: Record<Mood, MoodDef> = {
  calm: {
    tempoMin: 58,
    tempoMax: 68,
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    hat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    chord: [0, 7, 12],
    root: 55, // A1
    dissonance: 0.05,
    padAt: 0.25,
    percAt: 0.85,
    stringsAt: 0.9,
    hordeAt: 1.2,
  },
  tension: {
    tempoMin: 68,
    tempoMax: 84,
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
    bass: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    chord: [0, 3, 7, 10],
    root: 58,
    dissonance: 0.14,
    padAt: 0.18,
    percAt: 0.35,
    stringsAt: 0.72,
    hordeAt: 1.2,
  },
  combat: {
    tempoMin: 104,
    tempoMax: 124,
    kick: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0],
    hat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    bass: [1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1],
    chord: [0, 3, 7, 12],
    root: 62,
    dissonance: 0.22,
    padAt: 0.1,
    percAt: 0.12,
    stringsAt: 0.55,
    hordeAt: 0.95,
  },
  panic: {
    tempoMin: 126,
    tempoMax: 148,
    kick: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1],
    snare: [0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1],
    hat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    bass: [1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1],
    chord: [0, 1, 6, 8],
    root: 61,
    dissonance: 0.42,
    padAt: 0.05,
    percAt: 0.05,
    stringsAt: 0.35,
    hordeAt: 0.7,
  },
  horror: {
    tempoMin: 52,
    tempoMax: 62,
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    hat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    chord: [0, 1, 6, 13],
    root: 49,
    dissonance: 0.55,
    padAt: 0.01,
    percAt: 0.6,
    stringsAt: 0.2,
    hordeAt: 1.0,
  },
  relief: {
    tempoMin: 62,
    tempoMax: 72,
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    hat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    bass: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    chord: [0, 5, 9, 12],
    root: 57,
    dissonance: 0.04,
    padAt: 0.05,
    percAt: 0.5,
    stringsAt: 0.5,
    hordeAt: 1.2,
  },
};

export class MusicDirector {
  private mood: Mood = 'calm';
  private targetIntensity = 0;
  private intensity = 0;
  private step = 0;
  private nextTime = 0;
  private masterGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private droneGain: GainNode | null = null;
  private drones: OscillatorNode[] = [];
  private enabled = false;
  /** Set false while the game is paused / in menus. */
  running = false;

  constructor(private audio: AudioSystem) {}

  attach(): void {
    const ctx = this.audio.context;
    const dest = this.audio.musicDestination;
    if (!ctx || !dest || this.masterGain) return;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 1200;
    this.filter.Q.value = 0.8;
    this.masterGain.connect(this.filter);
    this.filter.connect(dest);

    // Drone layer: two detuned saws + a sub sine, permanently running.
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.0;
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 320;
    this.droneGain.connect(droneFilter);
    droneFilter.connect(this.masterGain);
    const base = MOODS.calm.root * 0.5;
    for (const [freq, detune, type] of [
      [base, -6, 'sawtooth'],
      [base, 7, 'sawtooth'],
      [base * 0.5, 0, 'sine'],
    ] as [number, number, OscillatorType][]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(this.droneGain);
      osc.start();
      this.drones.push(osc);
    }
    this.enabled = true;
  }

  setMood(mood: Mood): void {
    if (this.mood === mood) return;
    this.mood = mood;
  }

  get currentMood(): Mood {
    return this.mood;
  }

  /** Director intensity 0..1 — smoothly approached. */
  setIntensity(v: number): void {
    this.targetIntensity = clamp01(v);
  }

  /** Begin/stop the score (safe-room rest, menus). */
  setRunning(on: boolean): void {
    this.running = on;
    if (!this.audio.context) return;
    this.attach();
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(on ? 0.5 : 0.0, this.audio.context.currentTime, 0.8);
  }

  /** One-shot musical accent (Tank appearance, safe room). */
  accent(kind: 'tank' | 'safe' | 'horde' | 'death'): void {
    const ctx = this.audio.context;
    if (!ctx || !this.enabled || !this.masterGain) return;
    const t = ctx.currentTime;
    const def = MOODS[this.mood];
    const root = def.root;
    switch (kind) {
      case 'tank': {
        // Two low brass-ish stabs a tritone apart.
        for (const [dt, semi] of [
          [0, 0],
          [0.42, 6],
        ] as [number, number][]) {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = root * 0.5 * Math.pow(2, semi / 12);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t + dt);
          g.gain.linearRampToValueAtTime(0.42, t + dt + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 1.4);
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = 900;
          osc.connect(lp);
          lp.connect(g);
          g.connect(this.masterGain);
          osc.start(t + dt);
          osc.stop(t + dt + 1.6);
        }
        break;
      }
      case 'safe': {
        // A resolving major third — the game's only "good" chord.
        for (const [i, semi] of [0, 4, 7].entries()) {
          const osc = ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = root * Math.pow(2, semi / 12);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t + i * 0.2);
          g.gain.linearRampToValueAtTime(0.16, t + i * 0.2 + 0.6);
          g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.2 + 3.4);
          osc.connect(g);
          g.connect(this.masterGain);
          osc.start(t + i * 0.2);
          osc.stop(t + i * 0.2 + 3.6);
        }
        break;
      }
      case 'horde': {
        // Rising noise sweep + accelerating drum roll.
        const src = ctx.createBufferSource();
        src.buffer = this.audio.noiseSourceBuffer;
        src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.4;
        bp.frequency.setValueAtTime(200, t);
        bp.frequency.exponentialRampToValueAtTime(4200, t + 1.6);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.24, t + 1.5);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
        src.connect(bp);
        bp.connect(g);
        g.connect(this.masterGain);
        src.start(t);
        src.stop(t + 2.4);
        break;
      }
      case 'death': {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(root, t);
        osc.frequency.exponentialRampToValueAtTime(root * 0.25, t + 2.4);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.3, t + 0.1);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
        osc.connect(g);
        g.connect(this.masterGain);
        osc.start(t);
        osc.stop(t + 2.8);
        break;
      }
    }
  }

  /** Scheduler: call every frame. */
  update(dt: number): void {
    const ctx = this.audio.context;
    if (!ctx || !this.enabled || !this.masterGain || !this.filter) return;
    this.intensity += (this.targetIntensity - this.intensity) * (1 - Math.exp(-1.6 * dt));
    const def = MOODS[this.mood];
    const tempo = lerp(def.tempoMin, def.tempoMax, this.intensity);
    const stepDur = 60 / tempo / 4; // 16th notes
    const t = ctx.currentTime;

    // Drone intensity.
    if (this.droneGain) {
      this.droneGain.gain.setTargetAtTime(0.16 + this.intensity * 0.12, t, 0.6);
      for (let i = 0; i < this.drones.length; i++) {
        const target = MOODS[this.mood].root * (i === 2 ? 0.25 : 0.5) * 2;
        const detune = (i === 1 ? 7 : i === 0 ? -6 : 0) * (1 + def.dissonance * 3);
        this.drones[i].frequency.setTargetAtTime(target, t, 1.2);
        this.drones[i].detune.setTargetAtTime(detune, t, 1.2);
      }
    }
    this.filter.frequency.setTargetAtTime(600 + this.intensity * 3200, t, 0.5);

    if (!this.running) return;
    if (this.nextTime === 0) this.nextTime = t + 0.1;

    // Look-ahead scheduling (two beats is plenty).
    let guard = 0;
    while (this.nextTime < t + 0.25 && guard++ < 32) {
      this.scheduleStep(this.step, this.nextTime, stepDur, def);
      this.step = (this.step + 1) % 16;
      this.nextTime += stepDur;
    }
    if (guard >= 32) this.nextTime = t + 0.25;
    if (this.audio.context && this.audio.context.state === 'suspended') {
      this.nextTime = 0;
    }
  }

  private scheduleStep(step: number, when: number, stepDur: number, def: MoodDef): void {
    const ctx = this.audio.context!;
    const i = this.intensity;

    // --- percussion --------------------------------------------------------
    if (i >= def.percAt) {
      if (def.kick[step]) this.drum(when, 'kick', 0.5 * Math.min(1, i + 0.2));
      if (def.snare[step]) this.drum(when, 'snare', 0.28);
      if (def.hat[step]) this.drum(when, 'hat', 0.07 + i * 0.05);
    }
    // --- bass --------------------------------------------------------------
    if (def.bass[step]) {
      const semi = def.chord[(step / 4) % def.chord.length | 0] ?? 0;
      const freq = def.root * 0.5 * Math.pow(2, semi / 12);
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.16 + i * 0.1, when + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, when + stepDur * 2.4);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 260 + i * 700;
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.masterGain!);
      osc.start(when);
      osc.stop(when + stepDur * 2.6);
    }
    // --- pad (every 4th step = one beat) ------------------------------------
    if (i >= def.padAt && step % 4 === 0) {
      const semi = def.chord[(step / 4) % def.chord.length];
      const freq = def.root * Math.pow(2, semi / 12);
      for (const detune of [-def.dissonance * 40, def.dissonance * 40]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.linearRampToValueAtTime(0.05 + i * 0.05, when + stepDur * 2);
        g.gain.exponentialRampToValueAtTime(0.0001, when + stepDur * 8);
        osc.connect(g);
        g.connect(this.masterGain!);
        osc.start(when);
        osc.stop(when + stepDur * 9);
      }
    }
    // --- dissonant strings --------------------------------------------------
    if (i >= def.stringsAt && step % 8 === 0) {
      const semi = def.chord[(step / 8) % def.chord.length];
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = def.root * 2 * Math.pow(2, semi / 12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.045 + i * 0.04, when + 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, when + stepDur * 6);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 400;
      osc.connect(hp);
      hp.connect(g);
      g.connect(this.masterGain!);
      osc.start(when);
      osc.stop(when + stepDur * 7);
    }
    // --- horde layer: double kick + rising tension --------------------------
    if (i >= def.hordeAt) {
      if (step % 2 === 0) this.drum(when, 'kick', 0.42);
      if (step % 4 === 2) this.drum(when, 'snare', 0.24);
    }
  }

  private drum(when: number, kind: 'kick' | 'snare' | 'hat', gain: number): void {
    const ctx = this.audio.context!;
    if (kind === 'kick') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(130, when);
      osc.frequency.exponentialRampToValueAtTime(42, when + 0.14);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(gain, when + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.24);
      osc.connect(g);
      g.connect(this.masterGain!);
      osc.start(when);
      osc.stop(when + 0.3);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.audio.noiseSourceBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    if (kind === 'snare') {
      f.type = 'bandpass';
      f.frequency.value = 1900;
      f.Q.value = 0.8;
    } else {
      f.type = 'highpass';
      f.frequency.value = 7000;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + (kind === 'snare' ? 0.18 : 0.06));
    src.connect(f);
    f.connect(g);
    g.connect(this.masterGain!);
    src.start(when, Math.random());
    src.stop(when + 0.3);
  }

  dispose(): void {
    for (const d of this.drones) {
      try {
        d.stop();
      } catch {
        /* already stopped */
      }
      d.disconnect();
    }
    this.drones.length = 0;
    this.masterGain?.disconnect();
    this.masterGain = null;
    this.enabled = false;
  }
}
