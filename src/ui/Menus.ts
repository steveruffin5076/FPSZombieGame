/**
 * MENUS
 * =====
 * Every screen outside of gameplay: title, chapter select, settings, pause,
 * death, chapter results and the campaign epilogue.
 *
 * The menus are a plain DOM state machine with a single visible screen at a
 * time. They never touch the simulation directly — they call back into the
 * engine, which owns the game state. That keeps "what can happen while paused"
 * in one place instead of scattered across UI handlers.
 */

import * as THREE from 'three';
import { CAMPAIGN, NARRATIVE, type ChapterDef } from '@/config/campaign';
import { DIFFICULTIES, QUALITY_PRESETS, type Difficulty, type GameSettings, type QualityTier, type SettingsStore } from '@/core/Settings';

export interface ChapterStats {
  chapter: ChapterDef;
  timeSeconds: number;
  kills: number;
  headshots: number;
  specialsKilled: number;
  damageDealt: number;
  damageTaken: number;
  revives: number;
  /** Times a squad member was knocked down (including the player). */
  downs: number;
  shotsFired: number;
  shotsHit: number;
  teammatesLost: number;
  /** Director statistics for the "pacing" line. */
  peakIntensity: number;
  hordeEvents: number;
}

export interface MenuCallbacks {
  onStartCampaign: (chapterIndex: number) => void;
  onResume: () => void;
  onRestartChapter: () => void;
  onNextChapter: () => void;
  onQuitToMenu: () => void;
  onSettingsChanged: (settings: GameSettings) => void;
}

type Screen = 'none' | 'main' | 'chapters' | 'settings' | 'controls' | 'pause' | 'death' | 'results' | 'epilogue';

export class Menus {
  private root: HTMLElement;
  private screen: Screen = 'none';
  private screenEl: HTMLElement | null = null;
  /** Remembers where the settings screen was opened from. */
  private settingsReturn: Screen = 'main';
  /** Highest chapter the player has unlocked. */
  private unlocked = 0;
  /** Set by the engine so menu interaction is audible. */
  onUiSound: ((kind: 'click' | 'hover') => void) | null = null;

  constructor(
    private readonly overlay: HTMLElement,
    private readonly settings: SettingsStore,
    private readonly callbacks: MenuCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'menu-layer';
    this.root.id = 'menus';
    this.overlay.appendChild(this.root);
    this.unlocked = this.loadProgress();
  }

  // -------------------------------------------------------------------------
  // Progress persistence
  // -------------------------------------------------------------------------

  private loadProgress(): number {
    try {
      const raw = localStorage.getItem('deadlight.progress');
      if (!raw) return 0;
      const parsed = JSON.parse(raw) as { unlocked?: number };
      return Math.max(0, Math.min(CAMPAIGN.length - 1, parsed.unlocked ?? 0));
    } catch {
      return 0;
    }
  }

  markChapterComplete(index: number): void {
    if (index + 1 > this.unlocked) {
      this.unlocked = Math.min(CAMPAIGN.length - 1, index + 1);
      try {
        localStorage.setItem('deadlight.progress', JSON.stringify({ unlocked: this.unlocked }));
      } catch {
        // Storage can be unavailable (private mode); progress is then per-session.
      }
    }
  }

  get unlockedChapters(): number {
    return this.unlocked;
  }

  // -------------------------------------------------------------------------
  // Screen management
  // -------------------------------------------------------------------------

  get isOpen(): boolean {
    return this.screen !== 'none';
  }

  get currentScreen(): Screen {
    return this.screen;
  }

  hide(): void {
    this.screen = 'none';
    if (this.screenEl) this.screenEl.remove();
    this.screenEl = null;
    this.root.classList.remove('open');
    this.overlay.classList.remove('interactive');
  }

  private show(screen: Screen, build: () => HTMLElement): void {
    if (this.screenEl) this.screenEl.remove();
    this.screen = screen;
    this.screenEl = build();
    this.root.appendChild(this.screenEl);
    this.root.classList.add('open');
    this.overlay.classList.add('interactive');
    // Animate in on the next frame so the transition always plays.
    requestAnimationFrame(() => this.screenEl?.classList.add('in'));
  }

  private panel(title: string, subtitle?: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'menu-panel';
    const header = document.createElement('header');
    header.innerHTML = `<h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}`;
    el.appendChild(header);
    return el;
  }

  private button(label: string, onClick: () => void, variant: '' | 'primary' | 'danger' = ''): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = `menu-btn ${variant}`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      this.onUiSound?.('click');
      onClick();
    });
    btn.addEventListener('mouseenter', () => this.onUiSound?.('hover'));
    return btn;
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  /**
   * Loading screen: chapter briefing + a progress bar. Generation happens on the
   * main thread between frames, so `updateLoading` is called with coarse steps.
   */
  showLoading(chapter: ChapterDef, tip: string): void {
    this.show('results', () => {
      const el = document.createElement('div');
      el.className = 'menu-panel menu-loading';
      el.innerHTML = `
        <header>
          <h1>CHAPTER ${chapter.index + 1} — ${chapter.name}</h1>
          <p>${chapter.brief}</p>
        </header>
        <div class="bar"><i></i></div>
        <div class="status">Generating…</div>
        <div class="tip"><strong>Tip:</strong> ${tip}</div>`;
      this.loadingBar = el.querySelector('.bar > i');
      this.loadingStatus = el.querySelector('.status');
      return el;
    });
  }

  private loadingBar: HTMLElement | null = null;
  private loadingStatus: HTMLElement | null = null;

  updateLoading(t: number, label: string): void {
    if (this.loadingBar) this.loadingBar.style.width = `${(t * 100).toFixed(1)}%`;
    if (this.loadingStatus && label) this.loadingStatus.textContent = label;
  }

  showMain(): void {
    this.show('main', () => {
      const el = this.panel('DEADLIGHT', 'No cure. No rescue. Just the next safe room.');
      const actions = document.createElement('div');
      actions.className = 'menu-actions';
      actions.appendChild(this.button('PLAY CAMPAIGN', () => this.showChapters(), 'primary'));
      actions.appendChild(this.button('SETTINGS', () => this.showSettings('main')));
      actions.appendChild(this.button('CONTROLS', () => this.showControls()));
      actions.appendChild(this.button('CREDITS & TECH', () => this.showCredits()));
      el.appendChild(actions);

      const footer = document.createElement('footer');
      footer.className = 'menu-footer';
      footer.innerHTML = `<span>5 chapters · single-player with 3 AI survivors</span><span>WebGL2 · Three.js</span>`;
      el.appendChild(footer);
      return el;
    });
  }

  showChapters(): void {
    this.show('chapters', () => {
      const el = this.panel('SELECT CHAPTER', 'Later chapters are unlocked by completing the one before.');
      const grid = document.createElement('div');
      grid.className = 'chapter-grid';
      CAMPAIGN.forEach((chapter, i) => {
        const card = document.createElement('button');
        const locked = i > this.unlocked;
        card.className = `chapter-card${locked ? ' locked' : ''}`;
        card.disabled = locked;
        card.innerHTML = `
          <span class="num">CH ${String(i + 1).padStart(2, '0')}</span>
          <span class="name">${chapter.name}</span>
          <span class="brief">${chapter.brief}</span>
          <span class="meta">${chapter.targetMinutes} min · difficulty ×${chapter.difficultyScale.toFixed(2)}${locked ? ' · LOCKED' : ''}</span>`;
        card.addEventListener('click', () => this.callbacks.onStartCampaign(i));
        grid.appendChild(card);
      });
      el.appendChild(grid);
      const actions = document.createElement('div');
      actions.className = 'menu-actions row';
      actions.appendChild(this.button('BACK', () => this.showMain()));
      el.appendChild(actions);
      return el;
    });
  }

  showSettings(returnTo: Screen = 'main'): void {
    this.settingsReturn = returnTo;
    this.show('settings', () => {
      const el = this.panel('SETTINGS', 'Values are saved locally and apply immediately.');
      const s = this.settings.current;
      const body = document.createElement('div');
      body.className = 'menu-form';

      // --- graphics ---
      body.appendChild(this.groupTitle('Graphics'));
      body.appendChild(
        this.select('Quality preset', (['low', 'medium', 'high', 'ultra'] as QualityTier[]).map((t) => ({ value: t, label: t.toUpperCase() })), s.quality.tier, (v) => {
          this.settings.setQualityTier(v as QualityTier);
          this.callbacks.onSettingsChanged(this.settings.current);
        }),
      );
      body.appendChild(this.toggle('Post-processing (bloom + grade)', s.quality.postProcessing, (v) => {
        this.settings.patchQuality({ postProcessing: v });
        this.callbacks.onSettingsChanged(this.settings.current);
      }));
      body.appendChild(this.toggle('Shadows', s.quality.shadows, (v) => {
        this.settings.patchQuality({ shadows: v });
        this.callbacks.onSettingsChanged(this.settings.current);
      }));
      body.appendChild(this.toggle('God rays', s.quality.godRays, (v) => {
        this.settings.patchQuality({ godRays: v });
        this.callbacks.onSettingsChanged(this.settings.current);
      }));

      // --- game ---
      body.appendChild(this.groupTitle('Game'));
      body.appendChild(
        this.select(
          'Difficulty',
          (Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => ({ value: d, label: DIFFICULTIES[d].label })),
          s.difficulty,
          (v) => {
            this.settings.apply({ difficulty: v as Difficulty });
            this.callbacks.onSettingsChanged(this.settings.current);
          },
        ),
      );
      body.appendChild(this.toggle('Friendly fire (AI teammates can hit you)', s.friendlyFire, (v) => {
        this.settings.apply({ friendlyFire: v });
        this.callbacks.onSettingsChanged(this.settings.current);
      }));
      body.appendChild(this.toggle('Subtitles', s.subtitles, (v) => {
        this.settings.apply({ subtitles: v });
        this.callbacks.onSettingsChanged(this.settings.current);
      }));
      body.appendChild(
        this.select(
          'Gore',
          [
            { value: 'off', label: 'Off' },
            { value: 'reduced', label: 'Reduced' },
            { value: 'full', label: 'Full' },
          ],
          s.goreLevel,
          (v) => {
            this.settings.patchQuality({ goreLevel: v as GameSettings['goreLevel'] });
            this.callbacks.onSettingsChanged(this.settings.current);
          },
        ),
      );

      // --- controls / audio ---
      body.appendChild(this.groupTitle('Controls & audio'));
      body.appendChild(this.slider('Mouse sensitivity', s.mouseSensitivity, 0.2, 4, 0.05, (v) => this.settings.apply({ mouseSensitivity: v })));
      body.appendChild(this.slider('ADS sensitivity multiplier', s.adsSensitivityMultiplier, 0.2, 1.5, 0.05, (v) => this.settings.apply({ adsSensitivityMultiplier: v })));
      body.appendChild(this.toggle('Invert Y axis', s.invertY, (v) => this.settings.apply({ invertY: v })));
      body.appendChild(this.slider('Field of view', s.fov, 65, 105, 1, (v) => {
        this.settings.apply({ fov: v });
        this.callbacks.onSettingsChanged(this.settings.current);
      }));
      body.appendChild(this.slider('Master volume', s.masterVolume, 0, 1, 0.05, (v) => {
        this.settings.apply({ masterVolume: v });
        this.callbacks.onSettingsChanged(this.settings.current);
      }));
      body.appendChild(this.slider('Effects volume', s.sfxVolume, 0, 1, 0.05, (v) => {
        this.settings.apply({ sfxVolume: v });
        this.callbacks.onSettingsChanged(this.settings.current);
      }));
      body.appendChild(this.slider('Music volume', s.musicVolume, 0, 1, 0.05, (v) => {
        this.settings.apply({ musicVolume: v });
        this.callbacks.onSettingsChanged(this.settings.current);
      }));
      body.appendChild(this.slider('Voice volume', s.voiceVolume, 0, 1, 0.05, (v) => {
        this.settings.apply({ voiceVolume: v });
        this.callbacks.onSettingsChanged(this.settings.current);
      }));
      el.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'menu-actions row';
      actions.appendChild(this.button('RESET TO DEFAULTS', () => {
        this.settings.reset();
        this.callbacks.onSettingsChanged(this.settings.current);
        this.showSettings(this.settingsReturn);
      }));
      actions.appendChild(this.button('BACK', () => this.back()));
      el.appendChild(actions);
      return el;
    });
  }

  private back(): void {
    switch (this.settingsReturn) {
      case 'pause':
        this.showPause();
        break;
      case 'main':
      default:
        this.showMain();
        break;
    }
  }

  showControls(): void {
    this.show('controls', () => {
      const el = this.panel('CONTROLS', 'All keys can be rebound in code (see src/core/Input.ts).');
      const list = document.createElement('div');
      list.className = 'menu-keys';
      const rows: [string, string][] = [
        ['W A S D', 'Move'],
        ['SHIFT', 'Sprint'],
        ['CTRL / C', 'Crouch'],
        ['SPACE', 'Jump / climb'],
        ['MOUSE 1', 'Fire'],
        ['MOUSE 2', 'Aim down sights'],
        ['R', 'Reload'],
        ['1 2 3 4', 'Primary / secondary / melee / throwable'],
        ['Q (hold)', 'Charge throwable · release to throw'],
        ['F', 'Melee / shove'],
        ['MOUSE 3 / F', 'Shove a pinned teammate free'],
        ['E', 'Interact · hold to revive'],
        ['H', 'Use medkit / pills / adrenaline'],
        ['L', 'Toggle flashlight'],
        ['TAB', 'Scoreboard'],
        ['ESC', 'Pause menu'],
        ['F3', 'Performance overlay'],
      ];
      for (const [key, what] of rows) {
        const row = document.createElement('div');
        row.innerHTML = `<kbd>${key}</kbd><span>${what}</span>`;
        list.appendChild(row);
      }
      el.appendChild(list);
      const actions = document.createElement('div');
      actions.className = 'menu-actions row';
      actions.appendChild(this.button('BACK', () => this.showMain()));
      el.appendChild(actions);
      return el;
    });
  }

  showCredits(): void {
    this.show('controls', () => {
      const el = this.panel('CREDITS & TECH');
      const body = document.createElement('div');
      body.className = 'menu-text';
      body.innerHTML = `
        <p><strong>Engine</strong> — Three.js (MIT). Rendering, instancing and post-processing only:
        every material, model, texture, sound and level in this game is generated in code at load time.
        There are no downloaded assets, so there is nothing to attribute beyond the libraries.</p>
        <p><strong>Textures</strong> — 256×256 procedural canvases (Value noise + Sobel-derived normal maps)
        generated by <code>src/render/Materials.ts</code> on startup.</p>
        <p><strong>Audio</strong> — Web Audio synthesis. Gunshots, footsteps, moans, ambience and the
        adaptive score are all built from oscillators and filtered noise (<code>src/audio/</code>).</p>
        <p><strong>Geometry</strong> — Levels are generated from a seed (<code>src/world/Generator.ts</code>),
        merged into a handful of draw calls by the geometry batcher. Characters are procedural rigs.</p>
        <p><strong>Inspired by</strong> Left 4 Dead's Director and the four-survivor co-op formula. This is
        an original, unaffiliated homage.</p>
        <p><strong>Fonts</strong> — System UI stack only (no web fonts downloaded).</p>`;
      el.appendChild(body);
      const actions = document.createElement('div');
      actions.className = 'menu-actions row';
      actions.appendChild(this.button('BACK', () => this.showMain()));
      el.appendChild(actions);
      return el;
    });
  }

  showPause(settings?: GameSettings): void {
    const s = settings ?? this.settings.current;
    this.show('pause', () => {
      const el = this.panel('PAUSED', `${s.difficulty} · quality ${s.quality.tier}`);
      const actions = document.createElement('div');
      actions.className = 'menu-actions';
      actions.appendChild(this.button('RESUME', () => this.callbacks.onResume(), 'primary'));
      actions.appendChild(this.button('SETTINGS', () => this.showSettings('pause')));
      actions.appendChild(this.button('CONTROLS', () => this.showControls()));
      actions.appendChild(this.button('RESTART CHAPTER', () => this.callbacks.onRestartChapter()));
      actions.appendChild(this.button('QUIT TO MENU', () => this.callbacks.onQuitToMenu(), 'danger'));
      el.appendChild(actions);
      return el;
    });
  }

  showDeath(cause: string, stats: ChapterStats): void {
    this.show('death', () => {
      const el = this.panel('YOU DIED', cause || 'The infection wins this round.');
      const body = document.createElement('div');
      body.className = 'menu-stats';
      body.innerHTML = statRows(stats, false);
      el.appendChild(body);
      const actions = document.createElement('div');
      actions.className = 'menu-actions';
      actions.appendChild(this.button('RETRY CHAPTER', () => this.callbacks.onRestartChapter(), 'primary'));
      actions.appendChild(this.button('QUIT TO MENU', () => this.callbacks.onQuitToMenu(), 'danger'));
      el.appendChild(actions);
      return el;
    });
  }

  showResults(stats: ChapterStats, isLastChapter: boolean): void {
    this.show('results', () => {
      const el = this.panel(NARRATIVE.endScreenTitles.survived, stats.chapter.outro);
      const body = document.createElement('div');
      body.className = 'menu-stats';
      body.innerHTML = statRows(stats, true);
      el.appendChild(body);
      const actions = document.createElement('div');
      actions.className = 'menu-actions row';
      if (isLastChapter) actions.appendChild(this.button('SEE EPILOGUE', () => this.showEpilogue(stats), 'primary'));
      else actions.appendChild(this.button('NEXT CHAPTER', () => this.callbacks.onNextChapter(), 'primary'));
      actions.appendChild(this.button('QUIT TO MENU', () => this.callbacks.onQuitToMenu()));
      el.appendChild(actions);
      return el;
    });
  }

  showEpilogue(stats: ChapterStats): void {
    this.show('epilogue', () => {
      const el = this.panel('SURVIVED', 'You crossed five chapters and got to the water. Not many did.');
      const body = document.createElement('div');
      body.className = 'menu-stats';
      body.innerHTML = statRows(stats, true);
      const text = document.createElement('p');
      text.className = 'menu-text epilogue';
      text.textContent =
        'Deadlight is over — for this run. The Director keeps a record of how you played: how fast you pushed, how often you healed, which of you it took. Next time it will pace itself differently.';
      el.appendChild(body);
      el.appendChild(text);
      const actions = document.createElement('div');
      actions.className = 'menu-actions row';
      actions.appendChild(this.button('BACK TO MENU', () => this.callbacks.onQuitToMenu(), 'primary'));
      el.appendChild(actions);
      return el;
    });
  }

  // -------------------------------------------------------------------------
  // Form helpers
  // -------------------------------------------------------------------------

  private groupTitle(text: string): HTMLElement {
    const el = document.createElement('h2');
    el.className = 'menu-group';
    el.textContent = text;
    return el;
  }

  private slider(label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLElement {
    const row = document.createElement('label');
    row.className = 'menu-row slider';
    const out = document.createElement('span');
    out.className = 'value';
    out.textContent = formatNumber(value, step);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = formatNumber(v, step);
      onChange(v);
    });
    const name = document.createElement('span');
    name.className = 'label';
    name.textContent = label;
    row.append(name, input, out);
    return row;
  }

  private select(label: string, options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLElement {
    const row = document.createElement('label');
    row.className = 'menu-row select';
    const name = document.createElement('span');
    name.className = 'label';
    name.textContent = label;
    const sel = document.createElement('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    row.append(name, sel);
    return row;
  }

  private toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const row = document.createElement('label');
    row.className = 'menu-row toggle';
    const name = document.createElement('span');
    name.className = 'label';
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    row.append(name, input);
    return row;
  }

  /** Quality presets the settings screen can report for the HUD/debug line. */
  get qualityTier(): QualityTier {
    return this.settings.current.quality.tier;
  }
}

function statRows(stats: ChapterStats, survived: boolean): string {
  const minutes = Math.floor(stats.timeSeconds / 60);
  const seconds = Math.floor(stats.timeSeconds % 60);
  const accuracy = stats.shotsFired > 0 ? (stats.shotsHit / stats.shotsFired) * 100 : 0;
  const headshotRate = stats.kills > 0 ? (stats.headshots / stats.kills) * 100 : 0;
  return `
    <div class="stat"><span>Time</span><strong>${minutes}:${String(seconds).padStart(2, '0')}</strong></div>
    <div class="stat"><span>Infected killed</span><strong>${stats.kills}</strong></div>
    <div class="stat"><span>Headshot rate</span><strong>${headshotRate.toFixed(0)}%</strong></div>
    <div class="stat"><span>Specials killed</span><strong>${stats.specialsKilled}</strong></div>
    <div class="stat"><span>Accuracy</span><strong>${accuracy.toFixed(0)}%</strong></div>
    <div class="stat"><span>Damage dealt</span><strong>${Math.round(stats.damageDealt)}</strong></div>
    <div class="stat"><span>Damage taken</span><strong>${Math.round(stats.damageTaken)}</strong></div>
    <div class="stat"><span>Revives</span><strong>${stats.revives}</strong></div>
    <div class="stat"><span>Times downed</span><strong>${stats.downs}</strong></div>
    <div class="stat"><span>Teammates lost</span><strong>${stats.teammatesLost}</strong></div>
    <div class="stat"><span>Director peak</span><strong>${(stats.peakIntensity * 100).toFixed(0)}%</strong></div>
    <div class="stat"><span>Hordes survived</span><strong>${stats.hordeEvents}</strong></div>
    <div class="stat outcome"><span>Result</span><strong>${survived ? 'SAFE ROOM' : 'DEAD'}</strong></div>`;
}

function formatNumber(v: number, step: number): string {
  return step >= 1 ? String(Math.round(v)) : v.toFixed(2);
}

export type { THREE };
export { QUALITY_PRESETS };
