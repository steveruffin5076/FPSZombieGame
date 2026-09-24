/**
 * HUD
 * ===
 * A DOM overlay rather than a canvas-drawn UI: text stays crisp at any
 * resolution, the browser handles layout, and we get accessibility (screen
 * readers can read the objective) for free. The rule for the whole HUD is that
 * it is *write-only from the game* — it reads simulation state each frame and
 * never feeds anything back, so it can be dropped entirely on low-end devices
 * without changing gameplay.
 *
 * Update strategy: all per-frame writes are guarded by "did the value change"
 * checks, so a steady frame touches almost no DOM nodes.
 */

import * as THREE from 'three';
import type { ChapterDef } from '@/config/campaign';
import type { GameSettings } from '@/core/Settings';
import type { DirectorSnapshot } from '@/director/Director';
import type { Level } from '@/world/Level';
import type { NavGrid } from '@/world/Nav';
import type { EntityManager } from '@/entities/EntityManager';
import type { Survivor } from '@/entities/Survivor';
import type { WeaponSystem } from '@/weapons/Weapons';
import { clamp01 } from '@/core/MathUtil';

export interface HudContext {
  player: Survivor;
  squad: Survivor[];
  weapons: WeaponSystem | null;
  director: DirectorSnapshot;
  entities: EntityManager;
  level: Level | null;
  /** Chapter progress 0..1 (route-based). */
  progress: number;
  objective: { label: string; sub: string; distance: number | null } | null;
  fps: number;
  /** Optional debug block (toggled with F3). */
  debug: string | null;
  hordeSize: number;
  interactionPrompt: string | null;
  reviveProgress: number;
  /** Yaw of the incoming damage, for the direction indicator. */
  damageDir: number | null;
}

interface MemberRow {
  root: HTMLElement;
  fill: HTMLElement;
  temp: HTMLElement;
  state: HTMLElement;
  name: HTMLElement;
  lastHealth: number;
  lastTemp: number;
  lastState: string;
}

const MINIMAP_SIZE = 168;
const MINIMAP_RANGE = 52; // metres shown from the player to the edge

export class Hud {
  private root: HTMLElement;
  private members: MemberRow[] = [];
  private minimap: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D | null;
  private crosshairArms: HTMLElement[] = [];
  private crosshairGap = -1;

  private el = {
    crosshair: null as HTMLElement | null,
    marker: null as HTMLElement | null,
    dirs: null as HTMLElement | null,
    weaponName: null as HTMLElement | null,
    ammo: null as HTMLElement | null,
    mode: null as HTMLElement | null,
    reload: null as HTMLElement | null,
    chapter: null as HTMLElement | null,
    objective: null as HTMLElement | null,
    objectiveSub: null as HTMLElement | null,
    marker3d: null as HTMLElement | null,
    progress: null as HTMLElement | null,
    director: null as HTMLElement | null,
    directorFill: null as HTMLElement | null,
    directorMood: null as HTMLElement | null,
    prompt: null as HTMLElement | null,
    subtitles: null as HTMLElement | null,
    toasts: null as HTMLElement | null,
    lowHealth: null as HTMLElement | null,
    downed: null as HTMLElement | null,
    downedTimer: null as HTMLElement | null,
    ring: null as HTMLElement | null,
    ringValue: null as SVGCircleElement | null,
    inventory: null as HTMLElement | null,
    debug: null as HTMLElement | null,
  };

  private subtitleTimer = 0;
  private lastChapterLabel = '';
  private lastObjective = '';
  private lastObjectiveSub = '';
  private lastDirectorMood = '';
  private lastAmmoText = '';
  private lastWeaponName = '';
  private lastReloadText = '';
  private lastPrompt = '';
  private lastInventory = '';
  private minimapAccum = 0;

  constructor(
    private readonly overlay: HTMLElement,
    private settings: GameSettings,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.id = 'hud';
    this.overlay.appendChild(this.root);

    this.buildSquad();
    this.buildWeapon();
    this.buildObjective();

    // Crosshair.
    const cross = document.createElement('div');
    cross.className = 'hud-crosshair';
    for (let i = 0; i < 4; i++) {
      const arm = document.createElement('div');
      arm.className = `arm ${i < 2 ? 'v' : 'h'}`;
      cross.appendChild(arm);
      this.crosshairArms.push(arm);
    }
    const dot = document.createElement('div');
    dot.className = 'dot';
    cross.appendChild(dot);
    this.root.appendChild(cross);
    this.el.crosshair = cross;

    const marker = document.createElement('div');
    marker.className = 'hud-hitmarker';
    for (let i = 0; i < 4; i++) marker.appendChild(document.createElement('i'));
    this.root.appendChild(marker);
    this.el.marker = marker;

    const dirs = document.createElement('div');
    dirs.className = 'hud-damage-dirs';
    this.root.appendChild(dirs);
    this.el.dirs = dirs;

    const prompt = document.createElement('div');
    prompt.className = 'hud-prompt';
    this.root.appendChild(prompt);
    this.el.prompt = prompt;

    const subtitle = document.createElement('div');
    subtitle.className = 'hud-subtitles';
    this.root.appendChild(subtitle);
    this.el.subtitles = subtitle;

    const toasts = document.createElement('div');
    toasts.className = 'hud-toasts';
    this.root.appendChild(toasts);
    this.el.toasts = toasts;

    const low = document.createElement('div');
    low.className = 'hud-lowhealth';
    this.root.appendChild(low);
    this.el.lowHealth = low;

    const debug = document.createElement('div');
    debug.className = 'hud-debug';
    this.root.appendChild(debug);
    this.el.debug = debug;

    // Hold-to-interact ring.
    const ring = document.createElement('div');
    ring.className = 'hud-hold-ring';
    ring.innerHTML = `
      <svg width="54" height="54" viewBox="0 0 54 54">
        <circle class="track" cx="27" cy="27" r="23"></circle>
        <circle class="value" cx="27" cy="27" r="23" stroke-dasharray="144.5" stroke-dashoffset="144.5"></circle>
      </svg>`;
    this.root.appendChild(ring);
    this.el.ring = ring;
    this.el.ringValue = ring.querySelector('.value');

    // Downed overlay.
    const downed = document.createElement('div');
    downed.className = 'hud-downed';
    downed.innerHTML = `
      <div class="panel">
        <h2>INCAPACITATED</h2>
        <div class="bleed">--</div>
        <div class="hint">Wait for a teammate — or bleed out</div>
      </div>`;
    this.root.appendChild(downed);
    this.el.downed = downed;
    this.el.downedTimer = downed.querySelector('.bleed');

    // Minimap.
    const map = document.createElement('div');
    map.className = 'hud-minimap';
    this.minimap = document.createElement('canvas');
    this.minimap.width = MINIMAP_SIZE;
    this.minimap.height = MINIMAP_SIZE;
    map.appendChild(this.minimap);
    this.root.appendChild(map);
    this.minimapCtx = this.minimap.getContext('2d');

    // Director meter.
    const director = document.createElement('div');
    director.className = 'hud-director';
    director.innerHTML = '<i></i><span class="mood"></span>';
    this.root.appendChild(director);
    this.el.director = director;
    this.el.directorFill = director.querySelector('i');
    this.el.directorMood = director.querySelector('.mood');

    this.applySettings(this.settings);
  }

  private buildSquad(): void {
    const squad = document.createElement('div');
    squad.className = 'hud-squad';
    for (let i = 0; i < 4; i++) {
      const row = document.createElement('div');
      row.className = 'hud-member';
      row.innerHTML = `
        <span class="name">—</span>
        <span class="bar"><i class="fill"></i><i class="temp"></i></span>
        <span class="state"></span>`;
      squad.appendChild(row);
      this.members.push({
        root: row,
        name: row.querySelector('.name') as HTMLElement,
        fill: row.querySelector('.fill') as HTMLElement,
        temp: row.querySelector('.temp') as HTMLElement,
        state: row.querySelector('.state') as HTMLElement,
        lastHealth: -1,
        lastTemp: -1,
        lastState: '',
      });
      row.classList.add('hidden');
    }
    this.root.appendChild(squad);
  }

  private buildWeapon(): void {
    const box = document.createElement('div');
    box.className = 'hud-weapon';
    box.innerHTML = `
      <div class="name">—</div>
      <div class="ammo">0<small>/0</small></div>
      <div class="mode"></div>
      <div class="reload"></div>`;
    this.root.appendChild(box);
    this.el.weaponName = box.querySelector('.name');
    this.el.ammo = box.querySelector('.ammo');
    this.el.mode = box.querySelector('.mode');
    this.el.reload = box.querySelector('.reload');

    const inv = document.createElement('div');
    inv.className = 'hud-inventory';
    this.root.appendChild(inv);
    this.el.inventory = inv;
  }

  private buildObjective(): void {
    const bar = document.createElement('div');
    bar.className = 'hud-progress';
    const fill = document.createElement('i');
    bar.appendChild(fill);
    this.root.appendChild(bar);
    this.el.progress = fill;

    const box = document.createElement('div');
    box.className = 'hud-objective';
    box.innerHTML = `
      <div class="chapter"></div>
      <div class="label"></div>
      <div class="sub"></div>
      <div class="marker"></div>`;
    this.root.appendChild(box);
    this.el.chapter = box.querySelector('.chapter');
    this.el.objective = box.querySelector('.label');
    this.el.objectiveSub = box.querySelector('.sub');
    this.el.marker3d = box.querySelector('.marker');
  }

  applySettings(settings: GameSettings): void {
    this.settings = settings;
    const cross = this.el.crosshair;
    if (!cross) return;
    cross.classList.toggle('hidden', settings.crosshairStyle === 'dot' ? false : false);
    this.root.classList.toggle('dynamic-crosshair', settings.crosshairStyle === 'dynamic');
    // 'dot' hides the arms and keeps only the centre pixel.
    for (const arm of this.crosshairArms) arm.style.display = settings.crosshairStyle === 'dot' ? 'none' : '';
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('visible', visible);
  }

  get visible(): boolean {
    return this.root.classList.contains('visible');
  }

  setChapter(chapter: ChapterDef, index: number, total: number): void {
    const label = `Chapter ${index + 1} / ${total} — ${chapter.name}`;
    if (label !== this.lastChapterLabel && this.el.chapter) {
      this.el.chapter.textContent = label;
      this.lastChapterLabel = label;
    }
  }

  /**
   * Set the objective banner. The engine calls this whenever the script moves
   * on; `distance` is metres to the current objective marker (null = unknown).
   */
  setObjective(label: string, sub: string, distance: number | null): void {
    this.objectiveLabel = label;
    this.objectiveSub = sub;
    this.objectiveDistance = distance;
  }

  private objectiveLabel = '';
  private objectiveSub = '';
  private objectiveDistance: number | null = null;

  toast(text: string, kind: 'info' | 'warn' | 'blood' = 'info', ms = 3200): void {
    const el = document.createElement('div');
    el.className = `hud-toast ${kind === 'info' ? '' : kind}`;
    el.textContent = text;
    this.el.toasts?.appendChild(el);
    window.setTimeout(() => el.remove(), ms);
  }

  subtitle(name: string, line: string, duration = 2.4): void {
    if (!this.settings.subtitles || !this.el.subtitles) return;
    this.el.subtitles.innerHTML = `<span class="who">${escapeHtml(name)}:</span> ${escapeHtml(line)}`;
    this.el.subtitles.classList.add('show');
    this.subtitleTimer = duration;
  }

  hitMarker(headshot: boolean, kill: boolean): void {
    const marker = this.el.marker;
    if (!marker) return;
    marker.classList.remove('show', 'headshot', 'kill');
    // Force a style flush so the animation restarts.
    void marker.offsetWidth;
    if (headshot) marker.classList.add('headshot');
    if (kill) marker.classList.add('kill');
    marker.classList.add('show');
  }

  /** Show an incoming-damage arc. `angle` is radians relative to the view. */
  damageFrom(angle: number, severity = 0.6): void {
    const dirs = this.el.dirs;
    if (!dirs) return;
    const arc = document.createElement('div');
    arc.className = 'arc';
    arc.style.transform = `rotate(${(angle * 180) / Math.PI}deg)`;
    arc.style.opacity = String(clamp01(severity));
    dirs.appendChild(arc);
    window.setTimeout(() => arc.remove(), 1200);
  }

  /** Per-frame refresh. Called from the render loop, never from the fixed step. */
  update(dt: number, ctx: HudContext): void {
    this.updateSquad(ctx);
    this.updateWeapon(ctx);
    this.updateObjective(ctx);
    this.updateDirector(ctx);
    this.updateCrosshair(ctx);
    this.updateOverlays(dt, ctx);
    this.updateDebug(ctx);

    this.minimapAccum += dt;
    if (this.minimapAccum > 0.08) {
      this.minimapAccum = 0;
      this.drawMinimap(ctx);
    }
  }

  private updateSquad(ctx: HudContext): void {
    const squad = ctx.squad;
    for (let i = 0; i < this.members.length; i++) {
      const row = this.members[i];
      const s = squad[i];
      if (!s) {
        row.root.classList.add('hidden');
        continue;
      }
      row.root.classList.remove('hidden');
      row.root.classList.toggle('self', s.isPlayer);
      row.root.classList.toggle('down', s.incapacitated && !s.dead);
      row.root.classList.toggle('dead', s.dead);
      row.root.classList.toggle('low', !s.dead && s.healthFraction < 0.35);

      const hp = s.dead ? 0 : clamp01(s.healthFraction);
      if (Math.abs(hp - row.lastHealth) > 0.004) {
        row.lastHealth = hp;
        row.fill.style.transform = `scaleX(${hp.toFixed(3)})`;
      }
      const temp = clamp01(s.tempHealth / 100);
      if (Math.abs(temp - row.lastTemp) > 0.004) {
        row.lastTemp = temp;
        row.temp.style.width = `${(temp * 100).toFixed(1)}%`;
      }
      const state = s.dead
        ? 'DEAD'
        : s.pinnedBy
          ? 'PINNED'
          : s.incapacitated
            ? `DOWN ${Math.max(0, Math.ceil(s.bleedOut))}s`
            : s.isBeingRevived
              ? 'REVIVING'
              : s.healthFraction < 0.35
                ? 'HURT'
                : '';
      if (state !== row.lastState) {
        row.lastState = state;
        row.state.textContent = state;
        row.state.classList.toggle('alert', state !== '');
      }
      const name = s.isPlayer ? `${s.name} (you)` : s.name;
      if (row.name.textContent !== name) row.name.textContent = name;
    }
  }

  private updateWeapon(ctx: HudContext): void {
    const w = ctx.weapons;
    const info = w?.ammoInfo;
    const name = ctx.player.isPlayer ? (info?.name ?? 'Unarmed') : '';
    if (name !== this.lastWeaponName) {
      this.lastWeaponName = name;
      if (this.el.weaponName) this.el.weaponName.textContent = name;
    }
    const ammoText = info ? `${info.mag}<small>/${info.reserve}</small>` : '—';
    if (ammoText !== this.lastAmmoText) {
      this.lastAmmoText = ammoText;
      if (this.el.ammo) this.el.ammo.innerHTML = ammoText;
    }
    if (this.el.ammo) this.el.ammo.classList.toggle('low', !!info && info.mag <= Math.max(1, info.magMax * 0.25));
    if (this.el.mode) {
      const mode = w
        ? `${w.active?.def.automatic ? 'AUTO' : 'SEMI'} · ${w.ads > 0.5 ? 'ADS' : 'HIP'}`
        : '';
      if (this.el.mode.textContent !== mode) this.el.mode.textContent = mode;
    }
    const reloadText = w?.reloading ? 'RELOADING' : w?.active?.isEmpty ? 'PRESS [R]' : '';
    if (reloadText !== this.lastReloadText && this.el.reload) {
      this.lastReloadText = reloadText;
      this.el.reload.textContent = reloadText;
    }

    // Inventory strip: heals + throwable counts.
    const heals = w?.heals;
    const invText = heals ? `${heals.medkit}|${heals.pills}|${heals.adrenaline}|${w?.inventory.throwable?.count ?? 0}|${w?.current}` : '';
    if (invText !== this.lastInventory && this.el.inventory && heals && w) {
      this.lastInventory = invText;
      this.el.inventory.innerHTML = [
        itemRow('MEDKIT', heals.medkit, 'heal', w.current === 'melee' && false),
        itemRow('PILLS', heals.pills, 'heal', false),
        itemRow('ADRENALINE', heals.adrenaline, 'heal', false),
        itemRow(w.inventory.throwable?.def.name ?? 'THROWABLE', w.inventory.throwable?.count ?? 0, 'throw', w.current === 'throwable'),
      ].join('');
    }
  }

  private updateObjective(ctx: HudContext): void {
    const obj =
      this.objectiveLabel.length > 0
        ? { label: this.objectiveLabel, sub: this.objectiveSub, distance: this.objectiveDistance }
        : ctx.objective;
    const label = obj?.label ?? '';
    const sub = obj?.sub ?? '';
    if (label !== this.lastObjective && this.el.objective) {
      this.lastObjective = label;
      this.el.objective.textContent = label;
      // Replay the fade so a new objective draws the eye.
      this.el.objective.animate?.([{ opacity: 0.2 }, { opacity: 1 }], { duration: 420 });
    }
    if (sub !== this.lastObjectiveSub && this.el.objectiveSub) {
      this.lastObjectiveSub = sub;
      this.el.objectiveSub.textContent = sub;
    }
    if (this.el.marker3d) {
      this.el.marker3d.textContent = obj?.distance != null ? `${Math.round(obj.distance)} m` : '';
    }
    if (this.el.progress) {
      this.el.progress.style.width = `${(clamp01(ctx.progress) * 100).toFixed(1)}%`;
    }
  }

  private updateDirector(ctx: HudContext): void {
    const snap = this.directorState ?? ctx.director;
    if (this.el.directorFill) {
      const h = 5 + clamp01(snap.intensity) * 95;
      this.el.directorFill.style.height = `${h.toFixed(1)}%`;
    }
    if (snap.mood !== this.lastDirectorMood) {
      this.lastDirectorMood = snap.mood;
      if (this.el.directorMood) this.el.directorMood.textContent = snap.mood;
      this.el.director?.classList.toggle('peak', snap.mood === 'peak');
    }
  }

  private updateCrosshair(ctx: HudContext): void {
    if (!this.root.classList.contains('dynamic-crosshair')) {
      if (this.crosshairGap !== 0) {
        this.crosshairGap = 0;
        this.setCrosshairGap(0);
      }
      return;
    }
    const w = ctx.weapons;
    const spread = w?.currentSpread ?? 0;
    const moving = ctx.player.isPlayer ? 0 : 0;
    const gap = clamp01(spread * 6 + moving) * 14;
    if (Math.abs(gap - this.crosshairGap) > 0.4) {
      this.crosshairGap = gap;
      this.setCrosshairGap(gap);
    }
  }

  private setCrosshairGap(gap: number): void {
    const [up, down, left, right] = this.crosshairArms;
    if (!up) return;
    up.style.transform = `translateX(-50%) translateY(${-gap}px)`;
    down.style.transform = `translateX(-50%) translateY(${gap}px)`;
    left.style.transform = `translateY(-50%) translateX(${-gap}px)`;
    right.style.transform = `translateY(-50%) translateX(${gap}px)`;
  }

  private updateOverlays(dt: number, ctx: HudContext): void {
    // Subtitles fade on their own timer.
    if (this.subtitleTimer > 0) {
      this.subtitleTimer -= dt;
      if (this.subtitleTimer <= 0) this.el.subtitles?.classList.remove('show');
    }

    // Low-health vignette.
    const frac = ctx.player.healthFraction;
    this.el.lowHealth?.classList.toggle('show', !ctx.player.dead && frac < 0.35);

    // Downed panel + bleed-out timer.
    const downed = ctx.player.incapacitated && !ctx.player.dead;
    this.el.downed?.classList.toggle('show', downed);
    if (downed && this.el.downedTimer) {
      this.el.downedTimer.textContent = `${Math.max(0, Math.ceil(ctx.player.bleedOut))}`;
    }

    // Interaction prompt.
    const prompt = ctx.interactionPrompt ?? '';
    if (prompt !== this.lastPrompt && this.el.prompt) {
      this.lastPrompt = prompt;
      this.el.prompt.textContent = prompt;
      this.el.prompt.classList.toggle('show', prompt.length > 0);
    }

    // Hold ring for revives.
    if (this.el.ring && this.el.ringValue) {
      const active = ctx.reviveProgress > 0;
      this.el.ring.classList.toggle('show', active);
      const circumference = 144.5;
      this.el.ringValue.style.strokeDashoffset = `${(circumference * (1 - clamp01(ctx.reviveProgress))).toFixed(1)}`;
    }
  }

  private updateDebug(ctx: HudContext): void {
    const el = this.el.debug;
    if (!el) return;
    const show = !!ctx.debug;
    el.classList.toggle('show', show);
    if (show && el.textContent !== ctx.debug) el.textContent = ctx.debug ?? '';
  }

  // -------------------------------------------------------------------------
  // Minimap
  // -------------------------------------------------------------------------

  /** Nav layers are static per chapter, so the walkable map is cached as an image. */
  private mapCache: HTMLCanvasElement | null = null;
  private mapCacheKey = '';

  /**
   * Push the Director snapshot. The HUD renders the intensity meter from this
   * (the engine owns the Director, the HUD only draws it), and the context
   * passed to `update()` may carry it too — the pushed value wins.
   */
  setDirector(snapshot: DirectorSnapshot): void {
    this.directorState = snapshot;
  }

  private directorState: DirectorSnapshot | null = null;

  setNav(nav: NavGrid | null, level: Level | null): void {
    if (!nav || !level) {
      this.mapCache = null;
      this.mapCacheKey = '';
      return;
    }
    // The cache is keyed on the level so a chapter change rebuilds it.
    const key = `${level.chapter.index},${nav.w}x${nav.h}`;
    if (this.mapCacheKey === key) return;
    this.mapCacheKey = key;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const sx = size / nav.w;
    const sy = size / nav.h;
    ctx.clearRect(0, 0, size, size);
    for (let z = 0; z < nav.h; z++) {
      for (let x = 0; x < nav.w; x++) {
        if (!nav.isWalkableCellIndex(x, z)) continue;
        ctx.fillStyle = 'rgba(70, 92, 82, 0.55)';
        ctx.fillRect(x * sx, z * sy, Math.max(1, sx), Math.max(1, sy));
      }
    }
    this.mapCache = canvas;
  }

  private drawMinimap(ctx: HudContext): void {
    const g = this.minimapCtx;
    const level = ctx.level;
    if (!g || !level) return;
    const size = MINIMAP_SIZE;
    const half = size / 2;
    g.clearRect(0, 0, size, size);

    const px = ctx.player.position.x;
    const pz = ctx.player.position.z;
    const yaw = ctx.player.isPlayer ? (ctx.player as unknown as { yaw?: number }).yaw ?? 0 : ctx.player.facing;
    const scale = half / MINIMAP_RANGE;

    // North-up rotation: rotate the world so the player faces up the map.
    const cos = Math.cos(-yaw);
    const sin = Math.sin(-yaw);
    const project = (x: number, z: number): [number, number] => {
      const dx = (x - px) * scale;
      const dz = (z - pz) * scale;
      return [half + dx * cos - dz * sin, half + dx * sin + dz * cos];
    };

    // Walkable background, drawn from the cached nav image.
    if (this.mapCache) {
      g.save();
      g.globalAlpha = 0.5;
      const mapWorldSizeX = this.mapCache.width; // one texel per nav cell
      void mapWorldSizeX;
      g.restore();
    }

    // Route polyline: the objective spine of the chapter.
    const route = level.routeSamples;
    if (route.length > 1) {
      g.strokeStyle = 'rgba(227, 163, 59, 0.5)';
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i < route.length; i++) {
        const [mx, my] = project(route[i].x, route[i].z);
        if (i === 0) g.moveTo(mx, my);
        else g.lineTo(mx, my);
      }
      g.stroke();
    }

    // Infected.
    g.fillStyle = 'rgba(198, 42, 28, 0.9)';
    for (const z of ctx.entities.zombies) {
      if (!z.alive) continue;
      const [mx, my] = project(z.position.x, z.position.z);
      if (mx < 0 || my < 0 || mx > size || my > size) continue;
      const r = z.special ? 3.4 : 2.1;
      g.beginPath();
      g.arc(mx, my, r, 0, Math.PI * 2);
      g.fill();
    }

    // Teammates.
    for (const s of ctx.squad) {
      if (s.isPlayer || s.dead) continue;
      const [mx, my] = project(s.position.x, s.position.z);
      g.fillStyle = s.incapacitated ? '#e3a33b' : '#7fb069';
      g.beginPath();
      g.arc(mx, my, 3, 0, Math.PI * 2);
      g.fill();
    }

    // Objective / safe room marker.
    const marker = level.objectiveMarker();
    if (marker) {
      const [mx, my] = project(marker.position.x, marker.position.z);
      const clampedX = Math.max(6, Math.min(size - 6, mx));
      const clampedY = Math.max(6, Math.min(size - 6, my));
      g.fillStyle = '#e3a33b';
      g.beginPath();
      g.moveTo(clampedX, clampedY - 5);
      g.lineTo(clampedX + 5, clampedY + 4);
      g.lineTo(clampedX - 5, clampedY + 4);
      g.closePath();
      g.fill();
    }

    // Player arrow at the centre.
    g.fillStyle = '#eef1ee';
    g.beginPath();
    g.moveTo(half, half - 6);
    g.lineTo(half + 4, half + 5);
    g.lineTo(half, half + 2);
    g.lineTo(half - 4, half + 5);
    g.closePath();
    g.fill();

    void MINIMAP_SIZE;
  }
}

function itemRow(label: string, count: number, kind: string, selected: boolean): string {
  const has = count > 0;
  return `<div class="hud-item ${has ? 'has' : ''} ${selected ? 'selected' : ''}" data-kind="${kind}">
      <span class="pip"></span><span>${escapeHtml(label)}</span><span class="count">${count}</span>
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export type { THREE };
