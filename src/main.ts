/**
 * MAIN — the browser entry point.
 * ==============================
 * `index.html` loads this file. It does exactly four things:
 *
 *   1. Verifies WebGL2 is available and reports it in plain language.
 *   2. Imports the stylesheets (the HUD and menus are DOM, not canvas).
 *   3. Constructs the {@link Engine}, reports boot/loading progress to the
 *      splash screen, and starts the frame loop.
 *   4. Owns the "click to play" pointer-lock veil and the fatal-error screen.
 *
 * Everything gameplay-related lives in `src/engine/Engine.ts`; keeping this file
 * boring means a broken build fails loudly on the splash screen instead of
 * half-loading the game.
 */

import '@/styles/hud.css';
import '@/styles/menus.css';

import { bus } from '@/core/Events';
import { Engine } from '@/engine/Engine';

// ---------------------------------------------------------------------------
// DOM handles (all optional-with-fallback so a custom shell can drop them)
// ---------------------------------------------------------------------------

const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
const overlay = document.getElementById('ui-overlay') as HTMLElement | null;
const boot = document.getElementById('boot');
const bootBar = document.querySelector<HTMLElement>('#boot-bar > i');
const bootStatus = document.getElementById('boot-status');

function setBoot(t: number, label?: string): void {
  if (bootBar) bootBar.style.width = `${Math.round(Math.max(0, Math.min(1, t)) * 100)}%`;
  if (bootStatus && label) bootStatus.textContent = label;
}

function fail(title: string, detail: string): void {
  if (!boot) return;
  boot.classList.remove('hidden');
  boot.innerHTML = `
    <h1 style="font-size:clamp(1.4rem,4vw,2.4rem)">${title}</h1>
    <div class="tagline" style="letter-spacing:0.12em;text-transform:none;max-width:60ch;text-align:center;line-height:1.6">
      ${detail}
    </div>`;
  bootStatus?.remove();
}

/** Report a fatal error instead of leaving the player on a frozen splash. */
window.addEventListener('error', (ev) => {
  console.error('[deadlight] unhandled error', ev.error ?? ev.message);
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('[deadlight] unhandled rejection', ev.reason);
});

// ---------------------------------------------------------------------------
// Capability check
// ---------------------------------------------------------------------------

function hasWebGL2(): boolean {
  try {
    const test = document.createElement('canvas');
    return !!test.getContext('webgl2');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!canvas || !overlay) {
    fail('SHELL ERROR', 'index.html is missing #viewport or #ui-overlay.');
    return;
  }

  if (!hasWebGL2()) {
    fail(
      'WEBGL2 REQUIRED',
      'DEADLIGHT renders with WebGL2. Enable hardware acceleration in your browser settings (or try a recent Chrome, Edge, Firefox or Safari) and reload.',
    );
    return;
  }

  setBoot(0.05, 'Starting engine…');
  await nextFrame();

  let engine: Engine;
  try {
    engine = new Engine({
      canvas,
      overlay,
      onProgress: (t, label) => setBoot(t, label),
    });
  } catch (err) {
    console.error(err);
    fail('ENGINE FAILED TO START', String((err as Error)?.message ?? err));
    return;
  }

  // Expose for console debugging (and for the docs' troubleshooting section).
  (window as unknown as { deadlight?: Engine }).deadlight = engine;

  try {
    await engine.boot();
  } catch (err) {
    console.error(err);
    fail('BOOT FAILED', String((err as Error)?.message ?? err));
    return;
  }

  setBoot(1, 'Select a chapter to begin');
  engine.loop.start();

  // The splash stays as the menu backdrop until a chapter actually loads.
  const hideBoot = (): void => {
    boot?.classList.add('hidden');
    setTimeout(() => boot?.classList.add('hidden'), 600);
  };
  window.addEventListener('deadlight:ingame', hideBoot, { once: true });
  // `chapter:start` is emitted by the engine before the first frame of play.
  bus.on('chapter:start', () => window.dispatchEvent(new Event('deadlight:ingame')));

  // --- shell plumbing ------------------------------------------------------
  window.addEventListener('resize', () => engine.renderer.resize());

  // Right-click is the ADS button, so the browser menu must stay suppressed.
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // A lost context (driver reset, tab throttling) is recoverable in WebGL2;
  // tell the player instead of freezing silently.
  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    engine.loop.stop();
    fail('GRAPHICS CONTEXT LOST', 'The browser dropped the WebGL context. Reload the page to continue.');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    engine.renderer.resize();
    engine.loop.start();
  });

  // Pause automatically if the player alt-tabs away (the loop already handles
  // visibility, this also covers focus loss without a visibility change).
  window.addEventListener('blur', () => {
    if (engine.state === 'playing') engine.pause();
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

void main();
