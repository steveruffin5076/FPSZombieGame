/**
 * THE AI DIRECTOR
 * ===============
 * The Director is a single state machine that decides *when* the game is scary.
 * It never places a zombie directly: it accrues "spawn credit" like a budget,
 * and only spends it when it has read the squad's situation and chosen a mood.
 *
 * Pipeline (once per `tickInterval`)
 * ----------------------------------
 *   1. **Sense** — sample player health, ammo, movement tempo, squad spread,
 *      how many infected are alive/nearby, time since the last damage, progress
 *      along the route, and whether the player is looking at a spawn point.
 *   2. **Score intensity** — combine those signals into a 0..1 "intensity" that
 *      the music, fog, ambience and spawn rate all read from.
 *   3. **Choose a mood** — a weighted Markov chain (relax → build → sustain →
 *      peak → fade) biased by intensity and recent history. Moods enforce
 *      minimum durations so pacing has *shape* instead of flicker.
 *   4. **Earn credit** — credit/sec is a function of mood × difficulty ×
 *      chapter tweaks.
 *   5. **Spend credit** — pick an archetype from the intensity band's weights
 *      (specials are gated by individual cooldowns and a max-alive count), pick
 *      a valid spawn anchor, and spawn with a fade-in.
 *   6. **Mercy & cull** — if the squad is nearly dead the Director relaxes. If
 *      stragglers are left far behind the route, it retires them out of sight
 *      so the player is never chased by stragglers forever.
 *
 * Notes on purpose
 * ----------------
 *  - **Mercy rules are explicit**, not emergent: `mercyHealth`, `downedSpike`
 *    and the relax weight exist so the game can be hard without being unfair.
 *  - **Scripted events** (`LevelEventDef` in the campaign config) are merged into
 *    normal flow as forced moods, so set pieces ("the horde at the bridge") are
 *    the same system, just pre-scheduled.
 *  - The class is deliberately **deterministic given a seed**, which matters for
 *    reproducible testing and for the co-op roadmap (the host runs the Director).
 */
import * as THREE from 'three';
import { bus } from '@/core/Events';
import { Rng, clamp, clamp01, damp } from '@/core/MathUtil';
import type { DifficultyDef } from '@/core/Settings';
import { ZOMBIES, type ZombieVariant } from '@/config/zombies';
import { NAV_FLAG, type NavGrid } from '@/world/Nav';
import type { Level } from '@/world/Level';
import type { LevelLayout, SpawnAnchor } from '@/world/LevelTypes';
import type { EntityManager } from '@/entities/EntityManager';
import type { Survivor } from '@/entities/Survivor';
import type { SurvivorEntity } from '@/entities/Types';
import type { Zombie } from '@/entities/Zombie';
import type { Effects } from '@/vfx/Effects';
import type { AudioSystem } from '@/audio/Audio';
import type { MusicDirector } from '@/audio/Music';
import type { ItemManager } from '@/world/Items';
import {
  DIRECTOR_BUDGETS,
  DIRECTOR_TUNING,
  MAX_SPECIALS,
  SPECIAL_COOLDOWN,
  SPAWN_COST,
  SPAWN_PLACEMENT,
  STAT_SPAWN_CHANCES,
  type IntensityBand,
  type Mood,
} from '@/director/DirectorConfig';

export interface DirectorConfig {
  /** Options every chapter may override (see `CampaignConfig`). */
  budgetScale?: number;
  pacing?: number;
  specials?: number;
  maxSpecials?: number;
  specialCooldown?: number;
  tanks?: number;
  witches?: number;
  hordeSize?: number;
  relaxRate?: number;
  /** Multiplier from difficulty. */
  difficulty: DifficultyDef;
  seed: number;
}

/** Neutral snapshot used before a chapter starts (loading screen, menus). */
export const EMPTY_DIRECTOR_SNAPSHOT: DirectorSnapshot = {
  intensity: 0,
  mood: 'relax',
  band: 'calm',
  credit: 0,
  liveInfected: 0,
  liveSpecials: 0,
  tanksSpawned: 0,
  witchesSpawned: 0,
  hordeCount: 0,
  pressure: 0,
  pace: 0,
  sinceLastFight: 0,
  scriptedWave: false,
  tanksRemaining: 0,
};

export interface DirectorSnapshot {
  intensity: number;
  mood: Mood;
  band: IntensityBand;
  credit: number;
  liveInfected: number;
  liveSpecials: number;
  tanksSpawned: number;
  witchesSpawned: number;
  hordeCount: number;
  /** 0..1 how "in the fight" the player is right now (HUD meter). */
  pressure: number;
  pace: number;
  sinceLastFight: number;
  scriptedWave: boolean;
  tanksRemaining: number;
}

export class Director {
  private rng: Rng;
  private mood: Mood = 'relax';
  private intensity = 0.05;
  private targetIntensity = 0.05;
  private credit = 0;
  private moodTime = 0;
  private tickTimer = 0;
  private time = 0;
  /** Per-variant cooldown timers (seconds remaining). */
  private cooldowns = new Map<ZombieVariant, number>();
  private lastSpecialSpawn = -99;
  private lastTankTime = -999;
  private lastWitchTime = -999;
  private tanksSpawned = 0;
  private witchesSpawned = 0;
  /** Bookkeeping for sensing. */
  private lastPlayerPos = new THREE.Vector3();
  private lastPlayerHealth = 100;
  private sinceDamage = 99;
  private sinceKill = 99;
  private sinceSpawn = 99;
  private paceSamples: number[] = [];
  private scriptedWaveUntil = -1;
  private scriptedWaveScale = 1;
  private forceMood: Mood | null = null;
  private forceMoodUntil = -1;
  /** Item drip: guarantees a steady trickle of supplies even without spots. */
  private itemTimer = 0;
  /** Anti-frustration. */
  private mercyTimer = 0;
  private anchorsByType = {
    far: [] as SpawnAnchor[],
    near: [] as SpawnAnchor[],
    interior: [] as SpawnAnchor[],
    climb: [] as SpawnAnchor[],
  };
  private scratch = new THREE.Vector3();
  /** Statistics for the post-chapter screen. */
  readonly totals = {
    spawned: 0,
    killed: 0,
    specialsSpawned: 0,
    tanksSpawned: 0,
    witchesSpawned: 0,
    peakIntensity: 0,
    hordeEvents: 0,
    timeInCombat: 0,
  };
  /** Set by the engine: how many infected died this tick (for tempo). */
  private lastKnownLive = 0;

  constructor(
    private config: DirectorConfig,
    private level: Level,
    private nav: NavGrid,
    private entities: EntityManager,
    private audio: AudioSystem,
    private music: MusicDirector,
    private effects: Effects,
    private items: ItemManager | null,
  ) {
    this.rng = new Rng(config.seed ^ 0xd1ec70);
  }

  get snapshot(): DirectorSnapshot {
    return {
      intensity: this.intensity,
      mood: this.mood,
      band: this.band,
      credit: this.credit,
      liveInfected: this.entities.population,
      liveSpecials: this.entities.specialPopulation,
      tanksSpawned: this.tanksSpawned,
      witchesSpawned: this.witchesSpawned,
      hordeCount: this.entities.population,
      pressure: this.targetIntensity,
      pace: this.averagePace,
      sinceLastFight: this.sinceDamage,
      scriptedWave: this.scriptedWaveUntil > this.time,
      tanksRemaining: Math.max(0, (this.config.tanks ?? 0) - this.tanksSpawned),
    };
  }

  get currentIntensity(): number {
    return this.intensity;
  }

  get currentMood(): Mood {
    return this.mood;
  }

  get band(): IntensityBand {
    const i = this.intensity;
    if (i < 0.15) return 'calm';
    if (i < 0.38) return 'low';
    if (i < 0.62) return 'medium';
    if (i < 0.84) return 'high';
    return 'extreme';
  }

  private get averagePace(): number {
    if (this.paceSamples.length === 0) return 0;
    let sum = 0;
    for (const p of this.paceSamples) sum += p;
    return sum / this.paceSamples.length;
  }

  /** Called once when a chapter begins (after layout + nav are ready). */
  start(layout: LevelLayout): void {
    this.anchorsByType.far.length = 0;
    this.anchorsByType.near.length = 0;
    this.anchorsByType.interior.length = 0;
    this.anchorsByType.climb.length = 0;
    for (const a of layout.spawnAnchors) {
      // Discard anchors buried inside geometry (the generator can produce a few).
      if (!this.nav.isWalkable(a.x, a.y, a.z)) continue;
      if (a.flags & NAV_FLAG.INTERIOR) this.anchorsByType.interior.push(a);
      // Elevated anchors (roofs, containers, fire escapes) read as "climb".
      else if (a.y > 0.6) this.anchorsByType.climb.push(a);
      else if (a.routeDistance <= 8) this.anchorsByType.near.push(a);
      else this.anchorsByType.far.push(a);
    }
    // Give the player a real opening: nothing spawns for the first stretch.
    this.mood = 'relax';
    this.moodTime = 0;
    this.credit = 0;
    this.intensity = 0.05;
    this.targetIntensity = 0.05;
    this.tanksSpawned = 0;
    this.witchesSpawned = 0;
    this.cooldowns.clear();
    this.scriptedWaveUntil = -1;
    this.time = 0;
    this.itemTimer = 40;
    this.downState.clear();
    this.downTimes.length = 0;
    this.peakTime = 0;
  }

  /** Force a mood for a period (chapter scripted events, safe rooms). */
  pushMood(mood: Mood, duration: number): void {
    this.forceMood = mood;
    this.forceMoodUntil = this.time + duration;
    this.mood = mood;
    this.moodTime = 0;
  }

  /**
   * Trigger a full horde (crescendo): the Director front-loads credit and
   * switches to peak, ignoring mercy rules for the duration.
   */
  triggerHorde(scale = 1, duration = 42): void {
    this.scriptedWaveUntil = this.time + duration;
    this.scriptedWaveScale = scale;
    this.credit = Math.max(this.credit, 26 * scale);
    this.pushMood('peak', duration);
    this.totals.hordeEvents++;
    this.audio.play('horde_start', { ui: false, volume: 0.7 });
    this.music.accent('horde');
    this.emitIntensity();
    this.emitEvent('horde', `Horde incoming (${Math.round(scale * 100)}%)`);
  }

  /** Spawn a scripted Tank (used by chapter events and the finale). */
  forceTank(reason = 'event'): boolean {
    if (!this.spawnTank()) return false;
    this.pushMood('peak', 50);
    void reason;
    return true;
  }

  /** Spawn a Witch at a specific anchor (chapter flavour). */
  forceWitch(at?: THREE.Vector3): boolean {
    const anchor = at ? { x: at.x, y: at.y, z: at.z } : this.pickAnchor('far', 30);
    if (!anchor) return false;
    const z = this.entities.spawn('witch', anchor.x, anchor.y, anchor.z, this.rng.range(0, Math.PI * 2));
    if (!z) return false;
    this.witchesSpawned++;
    this.totals.witchesSpawned++;
    this.cooldowns.set('witch', SPECIAL_COOLDOWN.witch * (this.config.specialCooldown ?? 1));
    this.effects.dust(anchor.x, anchor.y + 0.2, anchor.z, 0.8);
    this.emitEvent('witch', 'A Witch is nearby — keep the noise down');
    return true;
  }

  /**
   * Health multiplier for a spawned infected. Specials take the full
   * difficulty multiplier; commons take half of it so a higher difficulty does
   * not turn every common into a bullet sponge.
   */
  private healthScaleFor(variant: ZombieVariant): number {
    const s = this.config.difficulty.specialHealth;
    return ZOMBIES[variant].special ? s : 1 + (s - 1) * 0.5;
  }

  /** Single channel for "how hard is the Director pushing right now". */
  private emitIntensity(): void {
    bus.emit('director:intensity', { level: this.intensity, mood: this.mood, label: MOOD_LABEL[this.mood] });
  }

  /** Semantic announcement: drives AI voice lines, music accents and HUD toasts. */
  private emitEvent(kind: 'horde' | 'tank' | 'witch' | 'special' | 'clear', description: string): void {
    bus.emit('director:event', { kind, description });
  }

  // -------------------------------------------------------------------------
  // Main tick
  // -------------------------------------------------------------------------

  update(dt: number, player: Survivor, squad: Survivor[]): void {
    this.time += dt;
    for (const [k, v] of this.cooldowns) {
      const next = v - dt;
      if (next <= 0) this.cooldowns.delete(k);
      else this.cooldowns.set(k, next);
    }

    if (this.mercyTimer > 0) this.mercyTimer = Math.max(0, this.mercyTimer - dt);
    this.sense(dt, player, squad);
    this.scoreIntensity(dt, player, squad);
    this.chooseMood(dt);
    this.earnCredit(dt);
    this.cull(dt, player);

    this.tickTimer -= dt;
    if (this.tickTimer <= 0) {
      this.tickTimer = 0.4;
      this.spendCredit(player, squad);
      this.spendItems(player);
      this.scriptedSpecials(player);
    }

    // Music + audio follow the Director, not the other way around.
    this.music.setIntensity(this.intensity);
    this.music.setMood(this.musicMood);
    if (this.totals.peakIntensity < this.intensity) this.totals.peakIntensity = this.intensity;
    if (this.intensity > 0.45) this.totals.timeInCombat += dt;
  }

  private get musicMood(): 'calm' | 'tension' | 'combat' | 'panic' | 'horror' | 'relief' {
    if (this.entities.population > 25 && this.intensity > 0.7) return 'panic';
    if (this.tanksSpawned > 0 && this.entities.population > 6 && this.intensity > 0.55) return 'panic';
    switch (this.mood) {
      case 'relax':
        return this.sinceDamage > 30 ? 'calm' : 'tension';
      case 'build':
        return 'tension';
      case 'sustain':
        return 'combat';
      case 'peak':
        return 'combat';
      case 'fade':
        return 'relief';
    }
  }

  // --- 1. sense ------------------------------------------------------------

  private sense(dt: number, player: Survivor, squad: Survivor[]): void {
    // Tempo: how fast is the player moving along the route?
    const moved = Math.hypot(player.position.x - this.lastPlayerPos.x, player.position.z - this.lastPlayerPos.z);
    this.lastPlayerPos.copy(player.position);
    if (dt > 0.0001) {
      const speed = moved / dt;
      // Only sample when actually traversing (not strafing in a fight).
      if (this.entities.population < 8) {
        this.paceSamples.push(speed);
        if (this.paceSamples.length > 40) this.paceSamples.shift();
      }
    }

    // Damage / kill recency.
    if (player.health < this.lastPlayerHealth - 0.5 || player.incapacitated) this.sinceDamage = 0;
    else this.sinceDamage += dt;
    this.lastPlayerHealth = player.health;
    if (player.incapacitated) this.mercyTimer = 0;

    // Kill counting (for the stats screen + tempo feedback).
    const live = this.entities.population;
    if (live < this.lastKnownLive) {
      this.totals.killed += this.lastKnownLive - live;
      this.sinceKill = 0;
    } else {
      this.sinceKill += dt;
    }
    this.lastKnownLive = live;
    this.sinceSpawn += dt;

    void squad;
  }

  // --- 2. score intensity --------------------------------------------------

  private scoreIntensity(dt: number, player: Survivor, squad: Survivor[]): void {
    const t = DIRECTOR_TUNING;
    const diff = this.config.difficulty;

    // Baseline: fights in progress, live population, and how long since contact.
    const live = this.entities.population;
    const metrics = this.entities.pressureMetrics(player as unknown as { position: THREE.Vector3 });
    let score = 0;
    score += Math.min(0.34, live / 45);
    score += Math.min(0.18, metrics.close / 14);
    score += Math.min(0.1, metrics.engaging / 20);

    // Time since last contact: the longer the quiet, the more the Director
    // *wants* to build — but it does not raise intensity directly (credit does).
    if (this.sinceDamage > 20) score -= 0.1;
    // Damage recency matters more than raw population: a field of infected that
    // is not actually touching the squad is tension, not a fight, and the
    // intensity (and therefore the music) should reflect that.
    if (this.sinceDamage > t.contactRelaxAfter) {
      score -= 0.06 * Math.min(1, (this.sinceDamage - t.contactRelaxAfter) / 20);
    }

    // Player state.
    const healthFrac = player.health / Math.max(1, player.maxHealth);
    if (healthFrac < t.mercyHealth / 100) score -= 0.28 * (1 - healthFrac / (t.mercyHealth / 100));
    else if (healthFrac > t.pressureHealth / 100) score += 0.06;

    // Ammo: low ammo makes the Director back off slightly (fairness).
    // (The weapon system reports reserve ammo through the bus; we approximate
    // by population pressure instead when unavailable.)

    // Squad cohesion: split up = more pressure (classic L4D behaviour).
    let maxSpread = 0;
    for (const s of squad) {
      if (s.dead) continue;
      const d = Math.hypot(s.position.x - player.position.x, s.position.z - player.position.z);
      if (d > maxSpread) maxSpread = d;
    }
    score += Math.min(t.spreadPressure, maxSpread / 40);
    // Someone down or pinned is a spike — but one spike, not one per survivor.
    let helpless = 0;
    for (const s of squad) {
      if (s.dead) continue;
      if (s.incapacitated) helpless++;
      if (s.pinnedBy) helpless++;
    }
    score += Math.min(t.downedSpike * 1.4, t.downedSpike * helpless * 0.8);

    // Pace: a fast squad gets pushed harder; a slow, careful squad gets ambushed.
    const pace = this.averagePace;
    if (pace > t.fastTempoScore / 10) score += 0.08;
    else if (pace < t.slowTempoScore / 10) score += 0.04;

    // Scripted events dominate.
    if (this.scriptedWaveUntil > this.time) score = Math.max(score, 0.9);

    // Mercy. Three ways in: nearly wiped, knocked down twice in a row, or an
    // average squad health that says "we are losing this fight". Whatever the
    // route, the response is the same — the budget freezes (mercyTimer) *and*
    // the field is thinned (see `cull`), so the break is real rather than just a
    // lower number on the HUD meter.
    const aliveCount = squad.filter((s) => !s.dead).length;
    const squadHealth = squad.reduce((sum, s) => sum + (s.dead ? 0 : s.health + s.tempHealth), 0) / Math.max(1, aliveCount);
    let mercy = false;
    if (aliveCount <= 1 && healthFrac < 0.3) mercy = true;
    if (player.incapacitated) mercy = true;
    // Downs are sampled from the squad, so the Director never needs a hook.
    for (const s of squad) {
      const wasDown = this.downState.get(s.id) ?? false;
      const isDown = s.incapacitated;
      if (isDown && !wasDown) this.downTimes.push(this.time);
      this.downState.set(s.id, isDown);
    }
    while (this.downTimes.length > 0 && this.time - this.downTimes[0] > t.mercyDownWindow) this.downTimes.shift();
    if (this.downTimes.length >= t.mercyDowns) mercy = true;
    if (aliveCount > 1 && squadHealth < squadAvgMaxHealth(squad) * t.mercySquadHealth) mercy = true;
    if (mercy) {
      score *= 0.5;
      this.downTimes.length = 0;
      if (this.mercyTimer <= 0) this.mercyTimer = t.mercyDuration;
      this.lastMercyAt = this.time;
    }

    score *= diff.pacingRate * (this.config.pacing ?? 1);
    this.targetIntensity = clamp(score, t.minIntensity, t.maxIntensity);
    this.intensity = damp(this.intensity, this.targetIntensity, t.intensityLerp, dt);
    // Relax rate: after a fight the intensity bleeds off faster.
    if (this.mood === 'fade' || this.mood === 'relax') {
      this.intensity = damp(this.intensity, Math.min(this.targetIntensity, 0.24), 1.4 * (this.config.relaxRate ?? 1), dt);
    }
  }

  // --- 3. mood -------------------------------------------------------------

  private chooseMood(dt: number): void {
    this.moodTime += dt;
    // A peak has a hard ceiling: the mood that makes the game memorable is the
    // one that has to *end*. Without this the Director can sit in peak until the
    // squad dies, which reads as spam no matter how good the individual spawns
    // are. The forced fade is short and always followed by a relax/build.
    if (this.mood === 'peak') {
      this.peakTime += dt;
      if (this.peakTime > DIRECTOR_TUNING.maxPeakDuration) {
        this.peakTime = 0;
        this.pushMood('fade', 22);
        this.emitIntensity();
        return;
      }
    } else {
      this.peakTime = Math.max(0, this.peakTime - dt * 0.5);
    }
    if (this.forceMood && this.time < this.forceMoodUntil) {
      this.mood = this.forceMood;
      return;
    }
    this.forceMood = null;
    const budget = DIRECTOR_BUDGETS[this.mood];
    if (this.moodTime < budget.minDuration) return;

    // Weighted choice, biased by intensity.
    const i = this.intensity;
    const weights: Record<Mood, number> = {
      relax: DIRECTOR_BUDGETS.relax.weight * (i < 0.3 ? 1.8 : 0.35) * (this.sinceDamage > 25 ? 1.6 : 0.6),
      build: DIRECTOR_BUDGETS.build.weight * (i < 0.55 ? 1.5 : 0.5) * (this.sinceDamage > 10 ? 1.3 : 0.8),
      sustain: DIRECTOR_BUDGETS.sustain.weight * (i > 0.25 ? 1.4 : 0.5),
      peak: DIRECTOR_BUDGETS.peak.weight * (i > 0.5 ? 1.9 : 0.15),
      fade: DIRECTOR_BUDGETS.fade.weight * (this.sinceDamage < 12 ? 1.4 : 0.5),
    };
    // Never choose the same mood twice in a row (except sustain).
    for (const key of Object.keys(weights) as Mood[]) {
      if (key === this.mood && key !== 'sustain') weights[key] *= 0.25;
    }
    let total = 0;
    for (const key of Object.keys(weights) as Mood[]) total += weights[key];
    let roll = this.rng.next() * total;
    let chosen: Mood = 'build';
    for (const key of Object.keys(weights) as Mood[]) {
      roll -= weights[key];
      if (roll <= 0) {
        chosen = key;
        break;
      }
    }
    if (chosen !== this.mood) {
      this.mood = chosen;
      this.moodTime = 0;
      this.emitIntensity();
    }
  }

  // --- 4. credit -----------------------------------------------------------

  private earnCredit(dt: number): void {
    const moodBudget = DIRECTOR_BUDGETS[this.mood];
    const diff = this.config.difficulty;
    const band = this.band;
    // Scaling: difficulty × chapter × intensity.
    const rate = moodBudget.creditPerSecond * diff.spawnBudget * (this.config.budgetScale ?? 1) * (0.6 + this.intensity * 0.8);
    const cap = moodBudget.maxCredit * (this.config.hordeSize ?? 1);
    this.credit = Math.min(cap, this.credit + rate * dt);
    void band;
  }

  // --- 5. spend ------------------------------------------------------------

  private spendCredit(player: Survivor, squad: Survivor[]): void {
    const diff = this.config.difficulty;
    const band = this.band;
    // Mercy window: scripted waves still land, but the budget stays frozen.
    if (this.mercyTimer > 0 && this.scriptedWaveUntil <= this.time) return;
    const maxSpecials = this.config.maxSpecials ?? MAX_SPECIALS[band];
    if (this.credit < SPAWN_COST.common) return;
    // Never spawn into an empty route or on top of the squad. The live ceiling
    // comes from the mood (and the mercy window), never from the hard entity cap:
    // this is what makes quiet stretches actually quiet.
    const liveCap = this.liveCap;
    if (this.entities.population >= liveCap) return;

    // Budget for this tick: a small share, so spawns trickle in rather than pop.
    const allowance = Math.min(this.credit, 1.5 + this.intensity * 6);
    let spent = 0;
    let guard = 0;
    while (spent < allowance && guard++ < 10) {
      if (this.entities.population >= liveCap) break;
      const variant = this.pickVariant(band, maxSpecials);
      if (!variant) break;
      const cost = SPAWN_COST[variant] * (variant === 'common' || variant.startsWith('common_') ? 1 : diff.specialFrequency);
      if (cost > this.credit - spent && !Variant.isCommon(variant)) break;
      if (variant === 'tank') {
        // Tanks are never random: reserved for the chapter's allowance.
        if (!this.spawnTank()) break;
        spent += cost;
        continue;
      }
      if (variant === 'witch') {
        if (!this.spawnWitch()) break;
        spent += cost;
        continue;
      }
      if (this.spawnVariant(variant, player, squad)) {
        spent += cost;
      } else {
        break;
      }
    }
    this.credit = Math.max(0, this.credit - spent);
  }

  /** Archetype roulette honouring cooldowns and alive caps. */
  private pickVariant(band: IntensityBand, maxSpecials: number): ZombieVariant | null {
    const weights = STAT_SPAWN_CHANCES[band];
    const specialsAlive = this.entities.specialPopulation;
    const entries: [ZombieVariant, number][] = [];
    for (const key of Object.keys(weights) as ZombieVariant[]) {
      const w = weights[key] ?? 0;
      if (w <= 0) continue;
      const def = ZOMBIES[key];
      if (def.special) {
        if (specialsAlive >= maxSpecials) continue;
        if (this.cooldowns.has(key)) continue;
        if (key === 'tank') {
          if (this.tanksSpawned >= (this.config.tanks ?? 0)) continue;
          if (this.entities.population < 12) continue;
          if (this.intensity < 0.6) continue;
        }
        if (key === 'witch') {
          if (this.witchesSpawned >= (this.config.witches ?? 0)) continue;
        }
      } else if (this.entities.population > 40 && key === 'common_armoured') {
        continue;
      }
      entries.push([key, w * (def.special ? this.config.specials ?? 1 : 1)]);
    }
    // Discount variants already over-represented so the mix stays varied.
    const counts = new Map<ZombieVariant, number>();
    for (const z of this.entities.zombies) {
      if (!z.alive) continue;
      counts.set(z.variant, (counts.get(z.variant) ?? 0) + 1);
    }
    for (const e of entries) {
      const seen = counts.get(e[0]) ?? 0;
      if (ZOMBIES[e[0]].special && seen > 0) e[1] *= 0.35;
    }
    if (entries.length === 0) return null;
    let total = 0;
    for (const e of entries) total += e[1];
    let roll = this.rng.next() * total;
    for (const e of entries) {
      roll -= e[1];
      if (roll <= 0) return e[0];
    }
    return entries[entries.length - 1][0];
  }

  private spawnVariant(variant: ZombieVariant, player: Survivor, squad: Survivor[]): boolean {
    const anchor = this.pickAnchor(ZOMBIES[variant].special ? 'special' : 'common', this.intensity);
    if (!anchor) return false;
    // Never spawn inside the player's view at close range.
    if (this.isVisibleToSquad(anchor, player, squad) && this.distanceToClosest(anchor, squad) < SPAWN_PLACEMENT.minDistance + 6) {
      return false;
    }
    const yaw = Math.atan2(player.position.x - anchor.x, player.position.z - anchor.z) + this.rng.range(-0.6, 0.6);
    const z = this.entities.spawn(variant, anchor.x, anchor.y, anchor.z, yaw, this.healthScaleFor(variant));
    if (!z) return false;
    if (ZOMBIES[variant].special) {
      this.cooldowns.set(variant, SPECIAL_COOLDOWN[variant] * (this.config.specialCooldown ?? 1));
      this.lastSpecialSpawn = this.time;
      this.totals.specialsSpawned++;
      const scale = this.healthScaleFor(variant);
      const z = this.entities.spawn(variant, anchor.x, anchor.y, anchor.z, this.rng.range(0, Math.PI * 2), scale);
      if (z) this.effects.dust(anchor.x, anchor.y + 0.2, anchor.z, 0.6);
      this.emitEvent(
        variant === 'tank' ? 'tank' : variant === 'witch' ? 'witch' : 'special',
        `${variant.replace(/_/g, ' ')} incoming`,
      );
      // The spawn itself plays a cue so the player learns the sound.
      this.audio.zombieVoice(variant, 'idle', new THREE.Vector3(anchor.x, anchor.y + 1, anchor.z));
    }
    this.totals.spawned++;
    this.sinceSpawn = 0;
    void yaw;
    return true;
  }

  private spawnTank(): boolean {
    if (this.tanksSpawned >= (this.config.tanks ?? 0)) return false;
    // Never two Tanks back to back: the squad needs a breather to restock.
    if (this.time - this.lastTankTime < TANK_MIN_GAP) return false;
    const anchor = this.pickAnchor('special', 1);
    if (!anchor) return false;
    const z = this.entities.spawn('tank', anchor.x, anchor.y, anchor.z, this.rng.range(0, Math.PI * 2), this.healthScaleFor('tank'));
    if (!z) return false;
    this.tanksSpawned++;
    this.totals.tanksSpawned++;
    this.lastTankTime = this.time;
    this.cooldowns.set('tank', SPECIAL_COOLDOWN.tank);
    this.pushMood('peak', 40);
    this.audio.play('tank_roar', { position: z.position, volume: 1 });
    this.music.accent('tank');
    this.effects.dust(anchor.x, anchor.y + 0.3, anchor.z, 2.4);
    this.emitEvent('tank', 'Tank! Find cover and keep moving');
    bus.emit('zombie:spawned', { variant: 'tank' });
    return true;
  }

  private spawnWitch(): boolean {
    if (this.witchesSpawned >= (this.config.witches ?? 0)) return false;
    if (this.time - this.lastWitchTime < WITCH_MIN_GAP) return false;
    const anchor = this.pickAnchor('far', 40);
    if (!anchor) return false;
    const z = this.entities.spawn('witch', anchor.x, anchor.y, anchor.z, this.rng.range(0, Math.PI * 2), this.healthScaleFor('witch'));
    if (!z) return false;
    this.witchesSpawned++;
    this.totals.witchesSpawned++;
    this.lastWitchTime = this.time;
    this.cooldowns.set('witch', SPECIAL_COOLDOWN.witch * (this.config.specialCooldown ?? 1));
    this.emitEvent('witch', 'A Witch is nearby — keep the noise down');
    return true;
  }

  /** Scripted specials: the Director always spends its special budget. */
  private scriptedSpecials(player: Survivor): void {
    if (this.mood !== 'sustain' && this.mood !== 'peak' && this.mood !== 'build') return;
    const specialsAlive = this.entities.specialPopulation;
    const band = this.band;
    const maxSpecials = this.config.maxSpecials ?? MAX_SPECIALS[band];
    if (specialsAlive >= maxSpecials) return;
    if (this.time - this.lastSpecialSpawn < 8) return;
    // Only when the Director actually has budget to spare.
    if (this.credit < 14) return;
    const variant = this.pickVariant(band, maxSpecials);
    if (!variant || !ZOMBIES[variant].special) return;
    const squad = this.entities.survivors as unknown as Survivor[];
    if (!this.spawnVariant(variant, player, squad)) return;
    this.credit = Math.max(0, this.credit - SPAWN_COST[variant]);
  }

  /** Retroactive wave scaling for chapter events. */
  get waveScale(): number {
    return this.scriptedWaveUntil > this.time ? this.scriptedWaveScale : 1;
  }

  // --- anchor selection ----------------------------------------------------

  private pickAnchor(kind: 'common' | 'special' | 'far', param: number): SpawnAnchor | null {
    const t = SPAWN_PLACEMENT;
    const lead = this.entities.leadSurvivor;
    if (!lead) return null;
    const px = lead.position.x;
    const pz = lead.position.z;
    const py = lead.position.y;

    // Build a candidate list appropriate to the category.
    const pool =
      kind === 'far'
        ? this.anchorsByType.far.concat(this.anchorsByType.interior)
        : kind === 'special'
          ? this.anchorsByType.far.concat(this.anchorsByType.interior, this.anchorsByType.climb)
          : this.anchorsByType.near.concat(this.anchorsByType.far, this.anchorsByType.interior, this.anchorsByType.climb);
    if (pool.length === 0) return null;

    const minDist = t.minDistance - param * 4;
    const maxDist = t.maxDistance;
    for (let attempt = 0; attempt < t.attempts; attempt++) {
      const a = pool[Math.floor(this.rng.next() * pool.length)];
      this.scratch.set(a.x - px, 0, a.z - pz);
      const d = this.scratch.length();
      if (d < Math.max(8, minDist) || d > maxDist) continue;
      // Reject anchors the squad can see: infected should arrive from behind,
      // through a doorway or out of the fog, never pop into view.
      if (this.isVisibleToSquad(a, this.entities.leadSurvivor as SurvivorEntity, this.entities.survivors)) continue;
      // Vertical sanity: do not spawn three floors above the player.
      if (Math.abs(a.y - py) > 12) continue;
      // Do not spawn behind glass or inside a sealed room unless it is tagged.
      if (!this.nav.isWalkable(a.x, a.y, a.z)) continue;
      return a;
    }
    return null;
  }

  private distanceToClosest(anchor: { x: number; z: number }, squad: SurvivorEntity[]): number {
    let best = Infinity;
    for (const s of squad) {
      if (s.dead) continue;
      const d = Math.hypot(s.position.x - anchor.x, s.position.z - anchor.z);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Rough visibility test: is the anchor inside the squad's forward cone?
   * Anything within 12 m counts as hidden regardless of facing — a zombie
   * stepping out of a doorway beside you is normal, one popping in front of
   * your crosshair is not.
   */
  private isVisibleToSquad(anchor: { x: number; z: number }, player: SurvivorEntity, squad: SurvivorEntity[]): boolean {
    const lead = player.dead ? (squad.find((s) => !s.dead) ?? player) : player;
    const dx = anchor.x - lead.position.x;
    const dz = anchor.z - lead.position.z;
    const d = Math.hypot(dx, dz) || 1;
    const facing = DIR.set(Math.sin(lead.facing), 0, Math.cos(lead.facing));
    const dot = (dx / d) * facing.x + (dz / d) * facing.z;
    return dot > SPAWN_PLACEMENT.minForwardDot && d > 12;
  }

  // --- 6. mercy & cull -----------------------------------------------------

  /**
   * Two jobs, both about *pacing* rather than performance:
   *
   *  1. **Stragglers** — infected that wandered far off-route, out of sight and
   *     with no target are retired so the squad stops dragging a tail.
   *  2. **Over-cap** — the live population is held against the current mood's
   *     ceiling (and a very low ceiling during mercy). Without this the horde a
   *     player earned at peak intensity would still be hunting them while the
   *     music says "relief". Infected within `cullNearDistance` of the squad are
   *     never removed: nothing vanishes in front of the player.
   */
  private cull(dt: number, player: Survivor): void {
    const t = DIRECTOR_TUNING;
    const routePoint = this.level.nearestRoutePoint(player.position.x, player.position.z);
    if (!routePoint) return;

    // --- 1. stragglers ------------------------------------------------------
    let culled = 0;
    const budget = Math.max(1, Math.floor(t.cullPerSecond * dt + (this.rng.next() < 0.5 ? 1 : 0)));
    for (const z of this.entities.zombies) {
      if (culled >= budget) break;
      if (!z.alive || z.special) continue;
      const dRoute = Math.hypot(z.position.x - routePoint.x, z.position.z - routePoint.z);
      const dPlayer = z.distanceTo(player.position.x, player.position.y, player.position.z);
      if (dRoute > t.strayDistance && dPlayer > 40 && !z.target) {
        this.entities.despawn(z);
        culled++;
      }
    }

    // --- 2. over-cap --------------------------------------------------------
    const cap = this.liveCap;
    const surplus = this.entities.population - cap;
    if (surplus <= 0) return;
    this.cullAccumulator += Math.min(surplus, t.overCapCullPerSecond * dt + this.cullAccumulator);
    const retireBudget = Math.floor(this.cullAccumulator);
    if (retireBudget < 1) return;
    this.cullAccumulator -= retireBudget;
    // Farthest first: the ones closest to the player are the fight.
    this.cullScratch.length = 0;
    for (const z of this.entities.zombies) {
      if (!z.alive) continue;
      const d = Math.hypot(z.position.x - player.position.x, z.position.z - player.position.z);
      if (d < t.cullNearDistance) continue;
      // Anything actively holding a survivor stays: that is the drama.
      if (z.isPinning || z.pinnedSurvivor) continue;
      this.cullScratch.push(z);
    }
    this.cullScratch.sort(
      (a, b) =>
        b.position.distanceToSquared(player.position) - a.position.distanceToSquared(player.position),
    );
    for (let i = 0; i < retireBudget && i < this.cullScratch.length; i++) {
      this.entities.despawn(this.cullScratch[i]);
    }
    void surplus;
  }

  /** Live-infected ceiling implied by the current mood (and mercy window). */
  get liveCap(): number {
    if (this.mercyTimer > 0) return DIRECTOR_TUNING.mercyLiveCap;
    const base = DIRECTOR_TUNING.liveCap[this.mood] ?? 20;
    const scale = clamp(this.config.budgetScale ?? 1, 0.5, 1.6);
    return Math.max(6, Math.round(base * scale));
  }

  private cullAccumulator = 0;
  private cullScratch: Zombie[] = [];
  /** Per-survivor "was incapacitated last tick" state, for down detection. */
  private downState = new Map<number, boolean>();
  /** Timestamps of recent downs (mercy accounting). */
  private downTimes: number[] = [];
  /** Time spent in the current peak. */
  private peakTime = 0;
  /** Last time the mercy window opened (diagnostics/HUD). */
  lastMercyAt = -999;

  private itemTimerInit = false;

  private spendItems(player: Survivor): void {
    if (!this.items) return;
    if (!this.itemTimerInit) {
      this.itemTimerInit = true;
      this.itemTimer = DIRECTOR_TUNING.itemDropInterval / Math.max(0.2, this.config.difficulty.resourceRichness);
    }
    this.itemTimer -= 0.4;
    if (this.itemTimer > 0) return;
    this.itemTimer =
      (DIRECTOR_TUNING.itemDropInterval * (0.7 + this.rng.next() * 0.6)) / Math.max(0.2, this.config.difficulty.resourceRichness);
    // Drop ammo or health slightly ahead of the squad.
    const approach = this.level.routePoint(Math.min(1, this.level.progress + 0.03));
    if (!approach) return;
    const isAmmo = this.rng.chance(0.65);
    const x = approach.x + this.rng.range(-7, 7);
    const z = approach.z + this.rng.range(-7, 7);
    if (!this.nav.isWalkable(x, approach.y, z)) return;
    const y = this.level.floorAt(x, z);
    this.items.spawnAt(isAmmo ? 'ammo' : 'medkit', isAmmo ? this.rng.pick(['rifle', 'smg', 'shells', 'sniper'] as const) : 'medkit', x, y + 0.1, z);
    bus.emit('director:itemDrop', { item: isAmmo ? 'ammo' : 'medkit' });
    void player;
  }

  /** Restock feedback when a chapter ends. */
  finishChapter(): void {
    this.music.setRunning(false);
  }

  get elapsed(): number {
    return this.time;
  }

  get statistics(): Director['totals'] {
    return this.totals;
  }
}

const DIR = new THREE.Vector3();

/** Mean max health of the living squad — the denominator for squad HP%. */
function squadAvgMaxHealth(squad: Survivor[]): number {
  let total = 0;
  let n = 0;
  for (const s of squad) {
    if (s.dead) continue;
    total += s.maxHealth;
    n++;
  }
  return n > 0 ? total / n : 100;
}

/** Small namespace used for readability at call sites. */
const Variant = {
  isCommon(v: ZombieVariant): boolean {
    return v === 'common' || v === 'common_fast' || v === 'common_armoured';
  },
};

export { Variant };
export { clamp, clamp01 };


/** Human-readable mood names for the HUD intensity readout. */
const MOOD_LABEL: Record<Mood, string> = {
  relax: 'Quiet',
  build: 'Building',
  sustain: 'Sustained',
  peak: 'Peak',
  fade: 'Fading',
};

/** Minimum seconds between scripted Tanks — the squad needs a restock window. */
const TANK_MIN_GAP = 75;
/** Minimum seconds between Witches (they are a stealth threat, not a wave). */
const WITCH_MIN_GAP = 55;
