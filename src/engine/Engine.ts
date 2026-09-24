/**
 * ENGINE
 * ======
 * The composition root. Everything else in the game is a system with a narrow
 * job; this file is the only place that knows how they fit together.
 *
 * Ownership tree
 * --------------
 *   Engine
 *   ├─ Renderer            (WebGL + post chain + scene graph)
 *   ├─ AudioSystem / MusicDirector
 *   ├─ SettingsStore ──> quality, difficulty, sensitivity
 *   ├─ Input               (one keyboard/mouse/gamepad source)
 *   ├─ CollisionWorld + NavGrid         (per chapter)
 *   ├─ Level               (geometry, doors, lights, triggers, route)
 *   ├─ EntityManager       (zombies, projectiles, explosions, spatial hash)
 *   ├─ ItemManager         (streamed pickups)
 *   ├─ Director            (pacing, spawning, mercy) + MusicDirector
 *   ├─ Player + TeammateAI x3
 *   ├─ ZombieRenderer / SurvivorRenderer (procedural rigs)
 *   └─ Hud / Menus         (DOM only — never read by gameplay)
 *
 * Frame order
 * -----------
 *   input -> player -> teammates -> entities -> projectiles -> level -> director
 *   -> items -> effects -> audio listener -> renderer -> HUD
 *
 * Gameplay never reads the HUD and the HUD never writes gameplay state, which is
 * why the whole overlay can be hidden or disabled without changing how the game
 * plays — and why the state machine below can pause the world without any
 * "did the UI eat my input" special cases.
 */

import * as THREE from 'three';
import { bus } from '@/core/Events';
import { GameLoop } from '@/core/Loop';
import { clamp01, Rng } from '@/core/MathUtil';
import { SettingsStore, difficultyDef, detectDefaultTier, type GameSettings } from '@/core/Settings';
import { Input } from '@/core/Input';
import { CollisionWorld, CollisionScratch } from '@/physics/Collision';
import { NavGrid, NAV_FLAG } from '@/world/Nav';
import { Level } from '@/world/Level';
import { ItemManager } from '@/world/Items';
import { CAMPAIGN, CAMPAIGN_LENGTH, NARRATIVE, chapterDef, type ChapterDef } from '@/config/campaign';
import { SURVIVORS, ZOMBIES, type ZombieVariant } from '@/config/zombies';
import { weaponDef } from '@/config/weapons';
import { MaterialLibrary, ProceduralTextures, VfxTextures } from '@/render/Materials';
import { Renderer } from '@/render/Renderer';
import { ZombieRenderer, SurvivorRenderer } from '@/render/Characters';
import { Effects } from '@/vfx/Effects';
import { AudioSystem } from '@/audio/Audio';
import { MusicDirector } from '@/audio/Music';
import { EntityManager } from '@/entities/EntityManager';
import { Survivor } from '@/entities/Survivor';
import { Player } from '@/player/Player';
import { TeammateAI, DEFAULT_SQUAD_LOADOUT } from '@/entities/TeammateAI';
import { Zombie } from '@/entities/Zombie';
import type { CombatEvents, SurvivorEntity } from '@/entities/Types';
import { WeaponSystem } from '@/weapons/Weapons';
import { Director, EMPTY_DIRECTOR_SNAPSHOT } from '@/director/Director';
import { Hud } from '@/ui/Hud';
import { Menus, type ChapterStats } from '@/ui/Menus';

export type GameState = 'boot' | 'menu' | 'loading' | 'playing' | 'paused' | 'dead' | 'results';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  /** Reports boot/loading progress to the shell (used by main.ts). */
  onProgress?: (t: number, label: string) => void;
}

/** How long the safe room takes to "seal" once the squad is inside. */
const SAFE_ROOM_HOLD = 3;
/**
 * How long the safe-room countdown may stall before the stragglers are ordered
 * to regroup (the AI leash itself lives in `TeammateAI.update`).
 */
const STRANDED_ROOM_GRACE = 8;

export class Engine {
  readonly settings = new SettingsStore();
  readonly materials: MaterialLibrary;
  readonly vfxTextures = new VfxTextures();
  readonly renderer: Renderer;
  readonly audio: AudioSystem;
  readonly music: MusicDirector;
  readonly input: Input;
  readonly world = new CollisionWorld();
  readonly nav = new NavGrid();
  readonly effects: Effects;
  readonly entities: EntityManager;
  readonly level: Level;
  readonly items: ItemManager;
  readonly hud: Hud;
  readonly menus: Menus;
  readonly loop: GameLoop;

  private player: Player;
  private squad: Survivor[] = [];
  private teammates: TeammateAI[] = [];
  private director: Director | null = null;
  private zombieRig: ZombieRenderer;
  private survivorRig: SurvivorRenderer;

  /** Rendering-owned scratch objects (no per-frame allocation). */
  private readonly cameraDir = new THREE.Vector3();
  private readonly collisionScratch = new CollisionScratch();

  state: GameState = 'boot';
  chapterIndex = 0;
  chapter: ChapterDef = CAMPAIGN[0];
  /** Seconds the squad has held the safe room. */
  private safeRoomHold = 0;
  private safeRoomArmed = false;
  /**
   * Seconds the player has been waiting in the safe room for teammates who are
   * not inside yet. Feeds the AI regroup leash: the chapter cannot end until the
   * whole living squad is in, so a stuck straggler must be pulled in.
   */
  private safeRoomStall = 0;
  /** Stats accumulator for the results screen. */
  private stats: ChapterStats;
  private chapterTime = 0;
  private qualityWatchdog = 0;
  private objectiveLabel = '';
  private objectiveSub = '';
  private hordeActive = false;
  private debugOverlay = false;
  private lastAmmoWarn = 0;

  constructor(private readonly options: EngineOptions) {
    const settings = this.settings.current;

    // --- rendering ---------------------------------------------------------
    this.renderer = new Renderer(options.canvas, settings.quality);
    this.materials = new MaterialLibrary(new ProceduralTextures());
    this.materials.warmupTextures();
    this.effects = new Effects(this.vfxTextures, settings.quality);
    this.renderer.scene.add(this.effects.group);

    // --- audio -------------------------------------------------------------
    this.audio = new AudioSystem(settings);
    this.music = new MusicDirector(this.audio);
    this.audio.applySettings(settings);

    // --- input -------------------------------------------------------------
    this.input = new Input(options.canvas);
    this.input.attach();
    this.input.onRequestLock = () => this.audio.start();

    // --- world -------------------------------------------------------------
    this.level = new Level(this.world, this.materials, this.vfxTextures, settings.quality);
    this.renderer.scene.add(this.level.group);
    this.items = new ItemManager(this.world, this.materials, this.audio, this.effects);
    this.renderer.scene.add(this.items.group);

    // --- entities ----------------------------------------------------------
    this.entities = new EntityManager(
      this.world,
      this.nav,
      this.effects,
      this.audio,
      settings.quality,
      this.createCombatEvents(),
    );

    // --- rigs --------------------------------------------------------------
    this.zombieRig = new ZombieRenderer(this.materials, settings.quality);
    this.survivorRig = new SurvivorRenderer(this.materials, settings.quality);
    this.renderer.scene.add(this.zombieRig.group, this.survivorRig.group);

    // --- player ------------------------------------------------------------
    this.player = new Player(
      1,
      this.world,
      this.renderer.camera,
      this.input,
      this.entities,
      this.level,
      this.items,
      this.effects,
      this.audio,
      settings,
      this.collisionScratch,
    );
    this.entities.registerSurvivor(this.player);
    this.player.weapons = this.createWeaponSystem(this.player);
    this.player.weapons.setLevel(this.level);
    this.renderer.viewScene.add(this.player.weapons.viewModel);

    // --- ui ----------------------------------------------------------------
    this.hud = new Hud(options.overlay, settings);
    this.menus = new Menus(options.overlay, this.settings, {
      onStartCampaign: (i) => void this.startChapter(i),
      onResume: () => this.resume(),
      onRestartChapter: () => void this.startChapter(this.chapterIndex),
      onNextChapter: () => void this.startChapter(Math.min(CAMPAIGN_LENGTH - 1, this.chapterIndex + 1)),
      onQuitToMenu: () => this.quitToMenu(),
      onSettingsChanged: (s) => this.applySettings(s),
    });
    this.menus.onUiSound = (kind) => this.audio.play(kind === 'hover' ? 'ui_hover' : 'ui_click', { ui: true, volume: 0.5 });

    this.stats = this.emptyStats();

    // --- loop --------------------------------------------------------------
    this.loop = new GameLoop(
      {
        step: (dt) => this.step(dt),
        render: (dt, alpha) => this.render(dt, alpha),
        onVisibility: (visible) => {
          if (!visible && this.state === 'playing') this.pause();
        },
      },
      { fixedStep: 1 / 60, maxSteps: 5 },
    );

    this.wireEvents();
    this.applySettings(settings);
    document.addEventListener('keydown', this.onGlobalKey);
  }

  // -------------------------------------------------------------------------
  // Boot / chapter lifecycle
  // -------------------------------------------------------------------------

  async boot(): Promise<void> {
    this.options.onProgress?.(0.1, 'Setting the scene…');
    this.renderer.applyTheme(CAMPAIGN[0].theme);
    this.renderer.render(0.016, null);
    this.options.onProgress?.(0.35, 'Generating textures…');
    await frame();
    this.options.onProgress?.(0.6, 'Preparing audio…');
    // Audio cannot start until a gesture; pre-warm the buffers so the first
    // gunshot is not delayed by synthesis.
    this.audio.warmup();
    await frame();
    this.options.onProgress?.(0.9, 'Ready');
    this.state = 'menu';
    this.hud.setVisible(false);
    this.menus.showMain();
    this.options.onProgress?.(1, 'Ready');
  }

  /**
   * Load a chapter. This is intentionally a single async method: level
   * generation, nav bake, squad placement and Director creation all happen
   * inside it, so "a chapter" is atomically either loaded or not.
   */
  async startChapter(index: number): Promise<void> {
    const chapter = chapterDef(index);
    this.chapterIndex = index;
    this.chapter = chapter;
    this.state = 'loading';
    this.hud.setVisible(false);
    this.loop.setPaused(true);

    // A loading panel doubles as the briefing screen.
    const tip = NARRATIVE.loadingTips[Math.floor(Math.random() * NARRATIVE.loadingTips.length)];
    this.menus.showLoading(chapter, tip);

    const onProgress = (t: number, label: string) => {
      this.menus.updateLoading(clamp01(t), label);
      this.options.onProgress?.(clamp01(t), label);
    };

    // 1. World + level -----------------------------------------------------
    this.world.clear();
    this.effects.clear();
    this.entities.clear();
    this.items.clear();
    this.zombieRig.clear();
    this.survivorRig.clear();
    await frame();

    const layout = this.level.load(chapter, (t, label) => onProgress(t * 0.55, label));
    bus.emit('chapter:start', { chapterIndex: index, name: chapter.name });

    // 2. Navigation --------------------------------------------------------
    onProgress(0.6, 'Baking navigation…');
    await frame();
    this.nav.bake(this.world, () => undefined);
    this.level.markRouteOnNav();

    // 3. Rendering setup ---------------------------------------------------
    onProgress(0.75, 'Applying atmosphere…');
    this.renderer.applyTheme(chapter.theme);
    this.hud.setNav(this.nav, this.level);
    this.hud.setChapter(chapter, index, CAMPAIGN_LENGTH);
    this.items.load(layout, this.level);

    // 4. Squad -------------------------------------------------------------
    onProgress(0.85, 'Deploying survivors…');
    this.spawnSquad(layout.playerSpawn.x, layout.playerSpawn.y, layout.playerSpawn.z, layout.playerSpawn.yaw);

    // 5. Director ----------------------------------------------------------
    this.director = new Director(
      {
        difficulty: difficultyDef(this.settings.current.difficulty),
        seed: chapter.seed ^ 0x9e3779b9,
        ...chapter.director,
      },
      this.level,
      this.nav,
      this.entities,
      this.audio,
      this.music,
      this.effects,
      this.items,
    );
    this.entities.allowedVariants = variantsForChapter(chapter);
    this.director.start(layout);

    // 6. Chapter bookkeeping ----------------------------------------------
    this.stats = this.emptyStats();
    this.chapterTime = 0;
    this.safeRoomHold = 0;
    this.safeRoomArmed = false;
    this.safeRoomStall = 0;
    this.hordeActive = false;
    this.objectiveLabel = chapter.events[0]?.name ?? `Reach the ${chapter.safeRoomLabel.toLowerCase()}`;
    this.objectiveSub = chapter.events[0]?.objective ?? 'Follow the route';
    this.hud.toast(`CHAPTER ${index + 1}: ${chapter.name}`, 'info', 4200);
    this.hud.setObjective(this.objectiveLabel, this.objectiveSub, null);

    this.state = 'playing';
    this.loop.setPaused(false);
    this.menus.hide();
    this.hud.setVisible(true);
    this.input.requestLock();
    this.audio.start();
    this.music.attach();
    this.music.setRunning(true);
    this.music.setMood('calm');
    this.audio.setAmbient('outdoor', chapter.theme.weather);
    this.radioLine(NARRATIVE.radio.start(chapter.name));
    onProgress(1, 'Ready');
  }

  private spawnSquad(x: number, y: number, z: number, yaw: number): void {
    this.player.spawnAt(x, y + 0.3, z, yaw);
    this.player.weapons?.give('pistol_m9', weaponDef('pistol_m9').magazine, 60);
    // The player starts with the chapter's tier-1 primary in hand (a pistol-only
    // start leaves the squad's damage output entirely to the AI teammates).
    const startPrimary = this.chapter?.startPrimary ?? null;
    if (startPrimary) {
      const def = weaponDef(startPrimary);
      this.player.weapons?.give(startPrimary, def.magazine, def.reserveMax);
      this.player.weapons?.equip('primary', startPrimary, true);
    } else {
      this.player.weapons?.equip('secondary', 'pistol_m9', true);
    }
    this.player.weapons?.giveHeal('medkit', 1);
    this.player.weapons?.giveHeal('pills', 1);
    this.player.weapons?.give('pipe_bomb', 1, 1);

    // Teammates spawn behind the player and slightly offset to the sides.
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    for (let i = 0; i < 3; i++) {
      const personality = SURVIVORS[i % SURVIVORS.length];
      const loadout = DEFAULT_SQUAD_LOADOUT[i % DEFAULT_SQUAD_LOADOUT.length];
      const side = (i - 1) * 1.6;
      const tx = x - forwardX * 2.4 + forwardZ * side;
      const tz = z - forwardZ * 2.4 - forwardX * side;
      let ai = this.teammates[i];
      if (!ai) {
        ai = new TeammateAI(2 + i, personality, this.world, this.nav, this.entities, this.effects, this.audio, loadout, i);
        this.teammates[i] = ai;
      }
      ai.resetForChapter(loadout);
      ai.char.teleport(tx, y + 0.3, tz);
      ai.char.snapToGround(4);
      ai.facing = yaw;
      if (!this.squad.includes(ai)) {
        this.squad.push(ai);
        this.entities.registerSurvivor(ai);
      }
    }
    if (!this.squad.includes(this.player)) this.squad.unshift(this.player);
  }

  private createWeaponSystem(host: Player): WeaponSystem {
    return new WeaponSystem(
      host,
      this.world,
      this.entities,
      this.materials,
      this.effects,
      this.audio,
      this.settings.current,
    );
  }

  private createCombatEvents(): CombatEvents {
    return {
      onZombieKilled: (z, opts) => {
        this.stats.kills += 1;
        if (opts.headshot) this.stats.headshots += 1;
        if (ZOMBIES[z.variant].special) this.stats.specialsKilled += 1;
        this.stats.damageDealt += opts.damage;
        bus.emit('zombie:killed', { variant: z.variant, headshot: opts.headshot, overkill: opts.damage });
      },
      onZombieSpawned: () => undefined,
      onSurvivorDowned: (s, attacker) => this.onSurvivorDowned(s.id, attacker),
      onSurvivorDied: (s) => this.onSurvivorDied(s.id),
      onSurvivorDamaged: (s, amount, source) => {
        const angle = source
          ? Math.atan2(source.x - this.player.position.x, source.z - this.player.position.z) - this.player.yaw
          : 0;
        this.onSurvivorDamaged(s.id, amount, angle);
      },
      onPin: (s: SurvivorEntity) => {
        this.hud.toast(`${s.name.toUpperCase()} IS PINNED`, 'blood');
        this.audio.play('survivor_pain', { position: s.position, volume: 0.9 });
      },
      onUnpin: () => undefined,
      onAbility: () => undefined,
      onDoorDamage: (doorId, amount) => {
        this.level.damageDoor(doorId, amount);
      },
      applyDamage: (target, amount, opts) => {
        target.takeDamage(amount, opts);
      },
    };
  }

  private applySettings(settings: GameSettings): void {
    this.renderer.applyQuality(settings.quality);
    this.effects.applyQuality(settings.quality);
    this.entities.applyQuality(settings.quality);
    this.zombieRig.applyQuality(settings.quality);
    this.survivorRig.applyQuality(settings.quality);
    this.level.applyQuality(settings.quality);
    this.player.applySettings(settings);
    this.player.weapons?.applySettings(settings);
    this.audio.applySettings(settings);
    this.hud.applySettings(settings);
    this.entities.maxLive = settings.quality.maxLiveZombies;
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.loop.setPaused(true);
    this.menus.showPause(this.settings.current);
    this.input.releaseLock();
    this.music.setRunning(true);
    this.audio.setDeafen(0.6);
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.menus.hide();
    this.loop.setPaused(false);
    this.input.requestLock();
    this.audio.setDeafen(0);
  }

  quitToMenu(): void {
    this.state = 'menu';
    this.loop.setPaused(true);
    this.hud.setVisible(false);
    this.menus.showMain();
    this.music.setRunning(true);
    this.music.setMood('calm');
    this.input.releaseLock();
    this.audio.setDeafen(0);
  }

  // -------------------------------------------------------------------------
  // Survivor life-cycle
  // -------------------------------------------------------------------------
  // These three handlers are reached two ways: the CombatEvents callbacks above
  // (used by systems that hold an event sink) and the shared game bus, which is
  // where `Survivor` itself reports damage, downing and death. Both paths land
  // here, so the bookkeeping below is idempotent per event.

  private readonly handledDown = new Set<number>();
  private readonly handledDeath = new Set<number>();

  private squadMember(id: number): Survivor | null {
    for (const s of this.squad) if (s.id === id) return s;
    return null;
  }

  private onSurvivorDowned(id: number, attacker: unknown): void {
    const s = this.squadMember(id);
    if (!s || this.handledDown.has(id)) return;
    this.handledDown.add(id);
    this.stats.downs += 1;
    this.hud.toast(`${s.name.toUpperCase()} IS DOWN`, 'warn');
    this.music.accent('death');
    if (attacker) this.audio.play('zombie_attack', { position: s.position, volume: 0.8 });
    // A downed teammate calls for help; the others acknowledge.
    if (!s.isPlayer) {
      const ai = s as TeammateAI;
      ai.speak('downed');
      for (const other of this.teammates) if (other !== ai && !other.dead) other.announce('downed');
    } else {
      for (const ai of this.teammates) if (!ai.dead) ai.announce('downed');
    }
  }

  private onSurvivorDied(id: number): void {
    const s = this.squadMember(id);
    if (!s || this.handledDeath.has(id)) return;
    this.handledDeath.add(id);
    if (!s.isPlayer) {
      this.stats.teammatesLost += 1;
      this.hud.toast(`${s.name.toUpperCase()} DIED`, 'blood', 5000);
      for (const ai of this.teammates) if (!ai.dead) ai.speak('hurt', 4);
    }
    this.music.accent('death');
    if (s.isPlayer) this.onPlayerDeath(s);
  }

  private onSurvivorDamaged(id: number, amount: number, angle: number): void {
    if (id !== this.player.id) return;
    this.stats.damageTaken += amount;
    this.hud.damageFrom(angle, clamp01(amount / 25));
    this.renderer.pulseHurt(clamp01(amount / 30) * 0.35);
  }

  private onPlayerDeath(player: SurvivorEntity): void {
    if (this.state === 'dead' || this.state === 'results') return;
    this.state = 'dead';
    this.loop.setPaused(true);
    this.director?.finishChapter();
    this.music.accent('death');
    this.music.setRunning(false);
    this.hud.setVisible(false);
    this.input.releaseLock();
    this.menus.showDeath(player.causeOfDeath || 'Killed by the infected', this.stats);
  }

  private onChapterComplete(): void {
    if (this.state === 'results') return;
    this.state = 'results';
    this.loop.setPaused(true);
    this.menus.markChapterComplete(this.chapterIndex);
    this.director?.finishChapter();
    this.audio.play('safe_room', { ui: true, volume: 0.9 });
    this.music.setRunning(false);
    this.hud.setVisible(false);
    this.input.releaseLock();
    this.menus.showResults(this.stats, this.chapterIndex >= CAMPAIGN_LENGTH - 1);
  }

  /** Full heal + ammo, exactly like a real safe room. */
  private restockSquad(): void {
    this.items.restock(this.player.weapons as never, this.teammates);
    this.player.weapons?.restock();
  }

  private emptyStats(): ChapterStats {
    return {
      chapter: this.chapter,
      timeSeconds: 0,
      kills: 0,
      headshots: 0,
      specialsKilled: 0,
      damageDealt: 0,
      damageTaken: 0,
      revives: 0,
      downs: 0,
      shotsFired: 0,
      shotsHit: 0,
      teammatesLost: 0,
      peakIntensity: 0,
      hordeEvents: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Simulation step (fixed 60 Hz)
  // -------------------------------------------------------------------------

  private step(dt: number): void {
    if (this.state !== 'playing') return;
    this.chapterTime += dt;
    this.stats.timeSeconds = this.chapterTime;

    const canAct = this.state === 'playing' && !this.loop.isPaused;

    // 1. Player ------------------------------------------------------------
    this.player.step(dt, canAct);
    this.player.updateStatus(dt);

    // 2. Teammates ---------------------------------------------------------
    const squadEntities: Survivor[] = [];
    for (const s of this.squad) if (!s.dead) squadEntities.push(s);
    const lead = (this.entities.leadSurvivor as Survivor | null) ?? this.player;
    const difficulty = difficultyDef(this.settings.current.difficulty);
    for (const ai of this.teammates) {
      if (ai.dead) continue;
      ai.update(dt, {
        leadPos: lead.position,
        leadSlot: lead.flowSlot,
        threats: this.collectThreats(ai.position),
        zombieDamage: difficulty.zombieDamage,
        // The safe-room hold needs every living survivor inside: once the
        // countdown has stalled, stragglers are pulled in rather than waited on.
        regroup: this.safeRoomStall > STRANDED_ROOM_GRACE,
      });
    }

    // 3. Entities (zombies, projectiles, explosions) -----------------------
    this.entities.update(dt, {
      zombieDamage: difficulty.zombieDamage,
      zombieHealth: difficulty.specialHealth,
      friendlyFire: this.settings.current.friendlyFire,
    });

    // 4. Level (doors, lights, triggers, route progress) -------------------
    this.level.update(dt, this.player.position, this.player.alive);

    // 5. Director ----------------------------------------------------------
    this.director?.update(dt, this.player, squadEntities);
    const snapshot = this.director?.snapshot;
    if (snapshot) {
      this.stats.peakIntensity = Math.max(this.stats.peakIntensity, snapshot.intensity);
      this.stats.hordeEvents = this.director?.totals.hordeEvents ?? 0;
    }
    this.hud.setDirector(snapshot ?? EMPTY_DIRECTOR_SNAPSHOT);

    // 6. Items + hazards ---------------------------------------------------
    this.items.update(this.player.position, this.level.progress);
    this.items.updateVisuals(dt, this.chapterTime);

    // 7. Triggers ----------------------------------------------------------
    const fired = this.level.checkTriggers(this.player.position);
    for (const trigger of fired) this.onTrigger(trigger);

    // 8. Safe room ---------------------------------------------------------
    this.updateSafeRoom(dt);

    // 9. Audio listener ----------------------------------------------------
    this.player.aimDirection(this.cameraDir);
    this.audio.setListener(this.player.position, this.cameraDir);
    this.audio.tick(dt);
    this.music.update(dt);

    // 10. Objective + HUD-side state --------------------------------------
    this.updateObjective();
    this.updateWarnings(dt);
    // The chapter ends when the squad does. A player who is merely downed still
    // has a bleed-out timer and teammates who can rescue them; nobody left
    // standing at all is a wipe.
    if (this.player.dead || this.squadWiped()) this.onPlayerDeath(this.player);
  }

  /**
   * Threat list handed to the AI each frame: every living infected inside a
   * 30 m bubble, nearest first, capped so three teammates cannot make the
   * per-frame target scan quadratic in a 60-zombie horde.
   */
  private collectThreats(pos: THREE.Vector3): Zombie[] {
    const out = this.threatScratch;
    out.length = 0;
    for (const z of this.entities.zombies) {
      if (!z.alive) continue;
      if (z.position.distanceToSquared(pos) > 900) continue;
      out.push(z);
    }
    out.sort((a, b) => a.position.distanceToSquared(pos) - b.position.distanceToSquared(pos));
    if (out.length > 16) out.length = 16;
    return out;
  }

  private readonly threatScratch: Zombie[] = [];

  /** Scripted event triggers (crescendos, alarms, Tank reveals). */
  private onTrigger(trigger: { kind: string; name: string; objective: string; waveScale: number; x: number; z: number }): void {
    this.objectiveLabel = trigger.name;
    switch (trigger.kind) {
      case 'final_defence':
      case 'crescendo':
      case 'horde':
      case 'ambush':
      case 'gauntlet':
        this.director?.triggerHorde(trigger.waveScale, trigger.kind === 'final_defence' ? 90 : 42);
        this.hordeActive = true;
        this.hud.toast(trigger.name, 'blood', 4000);
        break;
      case 'tank':
        this.director?.forceTank(trigger.name);
        this.hud.toast('TANK INCOMING', 'blood', 4000);
        break;
      case 'witch':
        this.director?.forceWitch(new THREE.Vector3(trigger.x, this.level.floorAt(trigger.x, trigger.z), trigger.z));
        break;
      case 'alarm_car':
      case 'alarm':
        this.level.triggerAlarm(trigger.x, trigger.z);
        this.audio.play('alarm', { position: new THREE.Vector3(trigger.x, 2, trigger.z), volume: 0.9 });
        this.director?.triggerHorde(trigger.waveScale, 36);
        break;
      case 'generator_start':
        this.audio.play('generator', { position: new THREE.Vector3(trigger.x, 1, trigger.z), volume: 0.8 });
        this.director?.triggerHorde(trigger.waveScale, 30);
        break;
      case 'bridge_collapse':
        this.audio.play('explosion', { position: new THREE.Vector3(trigger.x, 2, trigger.z), volume: 1 });
        this.effects.dust(trigger.x, 2, trigger.z, 2.5);
        break;
      default:
        break;
    }
  }

  private updateSafeRoom(dt: number): void {
    const room = this.level.layout?.safeRoom;
    if (!room) return;
    const inRoom = (x: number, z: number): boolean =>
      Math.hypot(x - room.x, z - room.z) < Math.max(room.width, room.depth) * 0.75;
    const alive = this.aliveSquad();
    const allInside = alive.length > 0 && alive.every((s) => inRoom(s.position.x, s.position.z));
    if (!allInside) {
      this.safeRoomHold = 0;
      // The player is in the room but somebody is not: let `teammatesRegroup`
      // stop being true on its own, the stall timer drives the AI leash.
      const playerIn = inRoom(this.player.position.x, this.player.position.z);
      this.safeRoomStall = playerIn && !this.player.dead ? this.safeRoomStall + dt : 0;
      return;
    }
    this.safeRoomStall = 0;
    if (!this.safeRoomArmed) {
      this.safeRoomArmed = true;
      this.hud.toast('SAFE ROOM — HOLD POSITION', 'info', 3000);
      this.level.setDoorOpen(room.doorId, false, 'safetynet');
      this.radioLine(NARRATIVE.radio.arrived);
    }
    this.safeRoomHold += dt;
    if (this.safeRoomHold > SAFE_ROOM_HOLD) {
      this.restockSquad();
      this.onChapterComplete();
    }
  }

  private updateObjective(): void {
    const marker = this.level.objectiveMarker();
    let sub = this.objectiveSub;
    if (this.hordeActive) sub = 'Survive the horde';
    else if (this.level.progress > 0.9) sub = `Get to the ${this.chapter.safeRoomLabel.toLowerCase()}`;
    this.hud.setObjective(marker?.label ?? this.objectiveLabel, sub, marker?.distance ?? null);
  }

  private updateWarnings(dt: number): void {
    this.lastAmmoWarn += dt;
    const item = this.player.weapons?.active;
    if (!item) return;
    const low = item.def.slot !== 'melee' && item.ammo <= Math.max(1, Math.floor(item.def.magazine * 0.2)) && this.player.weapons?.reserveFor(item.def.ammoType) === 0;
    if (low && this.lastAmmoWarn > 25) {
      this.lastAmmoWarn = 0;
      this.hud.toast('LOW AMMO — SWITCH TO SIDEARM', 'warn', 2600);
      this.audio.play('hint', { ui: true, volume: 0.5 });
    }
  }

  /** True when every survivor is dead or incapacitated (chapter failed). */
  private squadWiped(): boolean {
    for (const s of this.squad) {
      if (!s.dead && !s.incapacitated) return false;
    }
    return this.squad.length > 0;
  }

  private aliveSquad(): Survivor[] {
    return this.squad.filter((s) => !s.dead);
  }

  private radioLine(line: string): void {
    this.audio.play('radio', { ui: true, volume: 0.7 });
    this.hud.subtitle('Radio', line, 3.4);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(dt: number, alpha: number): void {
    void alpha;

    // Rig animation and VFX run at frame rate, not at simulation rate.
    if (this.state === 'playing' || this.state === 'paused') {
      this.zombieRig.update(this.entities.zombies, dt, this.renderer.camera.position);
      this.survivorRig.sync(this.squad, dt, this.chapterTime);
      this.effects.update(dt);
    }

    this.renderer.setFlashlight(this.player.flashlight);
    this.renderer.setLowHealth(this.player.alive ? 1 - clamp01(this.player.healthFraction / 0.35) : 1);
    this.renderer.setAdrenaline(this.player.tempHealth > 0 ? clamp01(this.player.tempHealth / 40) : 0);
    this.renderer.render(dt, this.player.weapons?.viewModel ?? null);

    // HUD (skipped entirely while a menu owns the screen).
    if (this.hud.visible) {
      const snapshot = this.director?.snapshot;
      this.hud.update(dt, {
        player: this.player,
        squad: this.squad,
        weapons: this.player.weapons,
        director:
          snapshot ??
          ({
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
          } as const),
        entities: this.entities,
        level: this.level,
        progress: this.level.progress,
        objective: { label: this.objectiveLabel, sub: this.objectiveSub, distance: this.level.objectiveMarker()?.distance ?? null },
        fps: this.loop.fps,
        debug: this.debugOverlay ? this.debugText() : null,
        hordeSize: this.entities.population,
        interactionPrompt: this.player.interactPrompt,
        reviveProgress: this.currentReviveProgress(),
        damageDir: null,
      });
    }

    this.updateAdaptiveQuality(dt);
  }

  private currentReviveProgress(): number {
    for (const s of this.squad) {
      if (s.isBeingRevived) return s.reviveProgress;
    }
    return 0;
  }

  private debugText(): string {
    const info = this.renderer.debugInfo;
    const snap = this.director?.snapshot;
    return [
      `fps ${this.loop.fps.toFixed(0)}  frame ${this.loop.perf.avgMs.toFixed(1)}ms (1% ${this.loop.perf.worstMs.toFixed(1)}ms)`,
      `tier ${this.settings.current.quality.tier}  draws ${info.drawCalls}  tris ${(info.triangles / 1000).toFixed(0)}k`,
      `infected ${this.entities.population} (${this.entities.specialPopulation} special)  projectiles ${this.entities.projectiles.length}`,
      `director ${snap ? `${snap.mood} ${(snap.intensity * 100).toFixed(0)}% credit ${snap.credit.toFixed(1)}` : 'n/a'}`,
      `route ${(this.level.progress * 100).toFixed(0)}%  pos ${this.player.position.x.toFixed(1)}, ${this.player.position.y.toFixed(1)}, ${this.player.position.z.toFixed(1)}`,
      `alloc-free step: yes  steps/frame ${this.loop.stepsLastFrame}  dropped ${this.loop.droppedTime.toFixed(1)}s`,
    ].join('\n');
  }

  /**
   * Adaptive quality: if the machine cannot hold the target frame rate we drop
   * one tier (and say so) rather than letting the player fight the stutter. It
   * never climbs back automatically — a tier change mid-fight is more jarring
   * than a slightly conservative setting.
   */
  private updateAdaptiveQuality(dt: number): void {
    if (this.state !== 'playing') return;
    if (this.autoQualityDisabled) return;
    this.qualityWatchdog += dt;
    if (this.qualityWatchdog < 4) return;
    this.qualityWatchdog = 0;
    const target = this.loop.fps;
    if (target > 0 && target < 46) {
      const next = this.settings.stepDownQuality();
      if (next) {
        this.applySettings(this.settings.current);
        this.hud.toast(`QUALITY REDUCED TO ${next.toUpperCase()} FOR PERFORMANCE`, 'warn', 3600);
      } else {
        this.autoQualityDisabled = true;
      }
    }
  }

  private autoQualityDisabled = false;

  // -------------------------------------------------------------------------
  // Global input + events
  // -------------------------------------------------------------------------

  private onGlobalKey = (ev: KeyboardEvent): void => {
    if (ev.repeat) return;
    if (ev.code === 'F3') {
      this.debugOverlay = !this.debugOverlay;
      return;
    }
    if (ev.code === 'Escape') {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
      return;
    }
    if (ev.code === 'KeyM') {
      // Mute toggle: the first thing anyone reaches for.
      const s = this.settings.current;
      const next = s.masterVolume > 0 ? 0 : 0.8;
      this.settings.apply({ masterVolume: next });
      this.applySettings(this.settings.current);
      this.hud.toast(next === 0 ? 'MUTED' : 'UNMUTED', 'info', 1200);
    }
  };

  private wireEvents(): void {
    // Survivor life-cycle. `Survivor` reports through the shared bus, so this is
    // where downing, death and damage feedback actually arrive — the
    // `CombatEvents` equivalents above exist for systems that hold an event sink
    // (and for the co-op host, which will receive the same calls over the wire).
    bus.on('survivor:incapacitated', (e) => this.onSurvivorDowned(e.id, true));
    bus.on('survivor:died', (e) => this.onSurvivorDied(e.id));
    bus.on('player:damaged', (e) => this.onSurvivorDamaged(this.player.id, e.amount, e.direction));
    bus.on('survivor:revived', (e) => {
      this.handledDown.delete(e.id);
      const s = this.squadMember(e.id);
      if (s && !s.isPlayer) (s as TeammateAI).speak('thanks', 2);
    });
    bus.on('chapter:start', () => {
      this.handledDown.clear();
      this.handledDeath.clear();
    });

    bus.on('zombie:hit', (e) => {
      this.hud.hitMarker(e.headshot, false);
      this.stats.shotsHit += 1;
    });
    bus.on('zombie:killed', (e) => {
      this.hud.hitMarker(e.headshot, true);
    });
    bus.on('weapon:fire', () => {
      this.stats.shotsFired += 1;
    });
    bus.on('survivor:voice', (e) => {
      this.hud.subtitle(e.name, e.line, e.duration);
    });
    bus.on('survivor:revived', () => {
      this.stats.revives += 1;
    });
    bus.on('director:event', (e) => {
      // The AI reacts to the Director the way a human squad would: out loud.
      for (const ai of this.teammates) ai.announce(e.kind as 'horde' | 'tank' | 'witch' | 'clear' | 'downed');
      if (e.kind === 'horde') this.music.accent('horde');
      if (e.kind === 'tank') this.music.accent('tank');
      this.hud.toast(e.description, e.kind === 'horde' || e.kind === 'tank' ? 'blood' : 'warn', 3200);
    });
    bus.on('horde:end', () => {
      this.hordeActive = false;
    });
    bus.on('door:locked', () => this.hud.toast('LOCKED', 'warn', 1500));
    bus.on('breakable:broken', () => {
      this.audio.play('impact_glass', { position: this.player.position, volume: 0.4 });
    });
    bus.on('quality-changed', () => this.applySettings(this.settings.current));
    bus.on('chapter:start', () => {
      this.hud.setNav(this.nav, this.level);
    });
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onGlobalKey);
    this.loop.stop();
    this.input.dispose();
    this.zombieRig.clear();
    this.survivorRig.clear();
    this.effects.dispose();
    this.renderer.dispose();
    this.music.dispose();
    this.audio.dispose();
  }
}

/** Chapter variants: broader roster later in the campaign. */
function variantsForChapter(chapter: ChapterDef): ZombieVariant[] {
  const base: ZombieVariant[] = ['common', 'common_fast', 'common_armoured'];
  if (chapter.index === 0) return base;
  const specials: ZombieVariant[] = ['hunter', 'smoker', 'boomer'];
  if (chapter.index >= 1) specials.push('spitter');
  if (chapter.index >= 2) specials.push('jockey');
  if (chapter.index >= 3) specials.push('charger');
  return base.concat(specials);
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export type { SurvivorEntity };
export { NAV_FLAG, detectDefaultTier, Rng };
