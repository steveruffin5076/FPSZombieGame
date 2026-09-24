/**
 * GAME LOOP
 * =========
 * A fixed-step simulation with an interpolated render, wrapped in the browser's
 * animation frame callback.
 *
 * Why fixed step?
 * ---------------
 * Everything gameplay-facing in Deadlight assumes a stable `dt`: the character
 * controller integrates acceleration and friction, the Director earns and spends
 * budget per second, zombie AI runs on staggered timers. If a frame hitch
 * doubled `dt`, a zombie would teleport through a doorway and the Director would
 * spawn two extra waves at once. A fixed 60 Hz step makes those systems
 * deterministic and, more importantly, testable: the same input produces the
 * same result regardless of machine speed.
 *
 * Rendering stays uncoupled: we always render, as often as the display allows.
 *
 * Spiral-of-death protection
 * --------------------------
 * `maxSteps` caps how many simulation steps a single frame may run. If the
 * machine cannot keep up, the game slows down rather than locking up, and
 * `droppedTime` lets the Director/audio know time was skipped.
 */

import { PerfMonitor } from '@/core/MathUtil';

export interface LoopHooks {
  /** Advance the simulation by exactly `dt` seconds. */
  step: (dt: number) => void;
  /** Draw a frame. `alpha` is the 0..1 blend between the last two steps. */
  render: (dt: number, alpha: number) => void;
  /** Called when the loop is paused (tab hidden) or resumed. */
  onVisibility?: (visible: boolean) => void;
}

export interface LoopOptions {
  /** Simulation step in seconds. 1/60 keeps aiming and physics crisp. */
  fixedStep?: number;
  /** Maximum simulation steps per frame (spiral-of-death guard). */
  maxSteps?: number;
  /** Clamp for the wall-clock frame time, in seconds. */
  maxFrameTime?: number;
}

export class GameLoop {
  readonly perf = new PerfMonitor();

  private fixedStep: number;
  private maxSteps: number;
  private maxFrameTime: number;
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;
  private paused = false;

  /** Simulation steps executed in the last frame (diagnostics + adaptation). */
  stepsLastFrame = 0;
  /** Wall-clock time skipped because the machine could not keep up. */
  droppedTime = 0;
  /** Total simulated seconds. */
  elapsed = 0;
  /** Render frames per second, smoothed. */
  fps = 0;

  constructor(
    private hooks: LoopHooks,
    opts: LoopOptions = {},
  ) {
    this.fixedStep = opts.fixedStep ?? 1 / 60;
    this.maxSteps = opts.maxSteps ?? 5;
    this.maxFrameTime = opts.maxFrameTime ?? 0.25;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get stepSeconds(): number {
    return this.fixedStep;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now() / 1000;
    this.accumulator = 0;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Pause simulation without stopping rendering (menus still animate). */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      // Never integrate the time spent in a menu.
      this.lastTime = performance.now() / 1000;
      this.accumulator = 0;
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private onVisibilityChange = (): void => {
    const visible = document.visibilityState === 'visible';
    if (visible) {
      this.lastTime = performance.now() / 1000;
      this.accumulator = 0;
    }
    this.hooks.onVisibility?.(visible);
  };

  private frame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    const now = nowMs / 1000;
    let frameTime = now - this.lastTime;
    this.lastTime = now;
    if (frameTime < 0) frameTime = 0;

    // A long stall (tab switch, shader compile) is truncated rather than
    // replayed: simulating 3 seconds of gameplay in one frame would be worse
    // than losing it.
    if (frameTime > this.maxFrameTime) {
      this.droppedTime += frameTime - this.maxFrameTime;
      frameTime = this.maxFrameTime;
    }

    this.perf.push(frameTime * 1000);
    this.fps = this.perf.fps;

    if (!this.paused) {
      this.accumulator += frameTime;
      let steps = 0;
      while (this.accumulator >= this.fixedStep && steps < this.maxSteps) {
        this.hooks.step(this.fixedStep);
        this.accumulator -= this.fixedStep;
        steps++;
        this.elapsed += this.fixedStep;
      }
      if (steps === this.maxSteps && this.accumulator >= this.fixedStep) {
        // Saturated: drop the backlog so the game does not drift into slow
        // motion permanently.
        this.droppedTime += this.accumulator;
        this.accumulator = 0;
      }
      this.stepsLastFrame = steps;
    }

    const alpha = this.paused ? 0 : this.accumulator / this.fixedStep;
    this.hooks.render(frameTime, alpha);
  };
}
