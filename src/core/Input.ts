/**
 * INPUT
 * =====
 * Keyboard + mouse (with pointer lock) and optional gamepad, normalised into a
 * single frame-sampled state object. The player controller never touches DOM
 * events directly, which keeps it testable and makes replays possible.
 *
 * Uses `code` (physical key) rather than `key` so WASD works on AZERTY layouts.
 */
import { settingsStore } from '@/core/Settings';

/** Mouse buttons mapped onto action names. */
const MOUSE_ACTIONS: Partial<Record<ActionName, number>> = {
  fire: 0,
  ads: 2,
  melee: 1,
};

export type ActionName =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'crouch'
  | 'sprint'
  | 'reload'
  | 'use'
  /** Mouse 0. Held = automatic fire, pressed = semi-auto tap. */
  | 'fire'
  /** Mouse 2. Aim down sights. */
  | 'ads'
  | 'melee'
  | 'shove'
  | 'throw'
  | 'heal'
  | 'flashlight'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  | 'prevWeapon'
  | 'nextWeapon'
  | 'drop'
  | 'voice'
  | 'scoreboard'
  | 'pause';

const DEFAULT_BINDINGS: Record<string, ActionName> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  KeyR: 'reload',
  KeyE: 'use',
  KeyF: 'melee',
  KeyQ: 'throw',
  KeyH: 'heal',
  Digit1: 'slot1',
  Digit2: 'slot2',
  Digit3: 'slot3',
  Digit4: 'slot4',
  KeyX: 'prevWeapon',
  KeyZ: 'nextWeapon',
  KeyG: 'drop',
  KeyV: 'voice',
  Tab: 'scoreboard',
  Escape: 'pause',
  KeyL: 'flashlight',
};

export class Input {
  private keysDown = new Set<string>();
  private keysPressed = new Set<string>();
  private keysReleased = new Set<string>();
  private bindings: Record<string, ActionName> = { ...DEFAULT_BINDINGS };

  /** Accumulated raw mouse delta for this frame (pixels). */
  readonly mouseDelta = { x: 0, y: 0 };
  /** Unfiltered wheel delta for this frame (positive = scroll down). */
  wheel = 0;
  mouseButtons = new Set<number>();
  mousePressed = new Set<number>();
  mouseReleased = new Set<number>();

  locked = false;
  /** Set while the pointer is unlocked but gameplay should ignore look input. */
  enabled = true;
  /** Screen-space mouse position (0..1) for menus. */
  pointer = { x: 0.5, y: 0.5 };

  /** True when the browser/OS reports a coarse pointer (touch device). */
  readonly isTouch = matchMedia('(pointer: coarse)').matches;

  /** Gamepad state (basic support: left stick move, right stick look, triggers fire/aim). */
  pad = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, fire: false, aim: false, reloadPressed: false, meleePressed: false, swapPressed: false };

  private listeners: (() => void)[] = [];
  /** Fired when the user asks for the pointer lock (a click on the canvas). */
  onRequestLock: (() => void) | null = null;

  constructor(private readonly element: HTMLElement) {
    this.attach();
  }

  attach(): void {
    /** Bind a DOM listener and remember it for teardown. */
    const add = <K extends keyof DocumentEventMap>(
      target: EventTarget,
      type: K,
      fn: (ev: DocumentEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, fn as EventListener, opts);
      this.listeners.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    const addWindow = <K extends keyof WindowEventMap>(type: K, fn: (ev: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      window.addEventListener(type, fn as EventListener, opts);
      this.listeners.push(() => window.removeEventListener(type, fn as EventListener, opts));
    };

    add(document, 'keydown', (ev) => {
      if (ev.repeat) return;
      this.keysDown.add(ev.code);
      this.keysPressed.add(ev.code);
      // Keep browser shortcuts from hijacking gameplay keys.
      if (['Space', 'Tab', 'KeyR', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Slash'].includes(ev.code)) ev.preventDefault();
      if (ev.code === 'Tab') ev.preventDefault();
    });
    add(document, 'keyup', (ev) => {
      this.keysDown.delete(ev.code);
      this.keysReleased.add(ev.code);
    });
    addWindow('blur', () => {
      this.keysDown.clear();
      this.mouseButtons.clear();
      this.pad.moveX = this.pad.lookX = 0;
    });

    add(document, 'mousemove', (ev) => {
      if (!this.locked || !this.enabled) {
        this.pointer.x = ev.clientX / window.innerWidth;
        this.pointer.y = ev.clientY / window.innerHeight;
        return;
      }
      this.mouseDelta.x += ev.movementX;
      this.mouseDelta.y += ev.movementY;
    });

    add(document, 'mousedown', (ev) => {
      if (!this.locked) {
        this.onRequestLock?.();
        return;
      }
      this.mouseButtons.add(ev.button);
      this.mousePressed.add(ev.button);
      ev.preventDefault();
    });
    add(document, 'mouseup', (ev) => {
      this.mouseButtons.delete(ev.button);
      this.mouseReleased.add(ev.button);
    });
    add(document, 'contextmenu', (ev) => ev.preventDefault());
    add(
      document,
      'wheel',
      (ev) => {
        if (this.locked) {
          this.wheel += Math.sign(ev.deltaY);
          ev.preventDefault();
        }
      },
      { passive: false },
    );

    add(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked) {
        this.keysDown.clear();
        this.mouseButtons.clear();
      }
    });
    add(document, 'pointerlockerror', () => {
      console.warn('[Input] pointer lock was rejected by the browser.');
      this.locked = false;
    });
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
  }

  requestLock(): void {
    if (this.locked) return;
    const el = this.element as HTMLElement & { requestPointerLock: (o?: PointerLockOptions) => Promise<void> | void };
    try {
      const res = el.requestPointerLock({ unadjustedMovement: true } as PointerLockOptions);
      if (res && typeof (res as Promise<void>).catch === 'function') {
        (res as Promise<void>).catch(() => {
          // Some platforms reject unadjustedMovement — retry without it.
          el.requestPointerLock();
        });
      }
    } catch {
      el.requestPointerLock();
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // -------------------------------------------------------------------------
  // Sampling API
  // -------------------------------------------------------------------------

  /** Call once per frame AFTER gameplay systems have read the state. */
  endFrame(): void {
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
    this.wheel = 0;
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
  }

  /** Poll gamepads — call at the start of each frame. */
  pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = pads.find((p): p is Gamepad => !!p);
    if (!gp) {
      this.pad.moveX = this.pad.moveY = this.pad.lookX = this.pad.lookY = 0;
      this.pad.fire = this.pad.aim = false;
      return;
    }
    const dead = (v: number): number => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
    this.pad.moveX = dead(gp.axes[0] ?? 0);
    this.pad.moveY = dead(gp.axes[1] ?? 0);
    this.pad.lookX = dead(gp.axes[2] ?? 0);
    this.pad.lookY = dead(gp.axes[3] ?? 0);
    const lt = gp.buttons[7]?.value ?? 0;
    const rt = gp.buttons[6]?.value ?? 0;
    this.pad.fire = rt > 0.4;
    this.pad.aim = lt > 0.4;
    this.pad.reloadPressed = !!gp.buttons[2]?.pressed;
    this.pad.meleePressed = !!gp.buttons[1]?.pressed;
    this.pad.swapPressed = !!gp.buttons[3]?.pressed;
  }

  down(code: string): boolean {
    return this.keysDown.has(code);
  }

  pressed(code: string): boolean {
    return this.keysPressed.has(code);
  }

  action(name: ActionName): boolean {
    if (this.mouseAction(name, false)) return true;
    for (const code in this.bindings) {
      if (this.bindings[code] === name && this.keysDown.has(code)) return true;
    }
    return false;
  }

  actionPressed(name: ActionName): boolean {
    if (this.mouseAction(name, true)) return true;
    for (const code in this.bindings) {
      if (this.bindings[code] === name && this.keysPressed.has(code)) return true;
    }
    return false;
  }

  /**
   * Mouse buttons are part of the action vocabulary (LMB fires, RMB aims), so
   * they are resolved against the same names the keyboard uses rather than
   * leaking button numbers into the gameplay code.
   */
  private mouseAction(name: ActionName, pressed: boolean): boolean {
    const button = MOUSE_ACTIONS[name];
    if (button === undefined) return false;
    return pressed ? this.mousePressed.has(button) : this.mouseButtons.has(button);
  }

  /** Remap a key (used by the settings menu). */
  rebind(code: string, action: ActionName | null): void {
    if (action === null) delete this.bindings[code];
    else this.bindings[code] = action;
  }

  get bindingsSnapshot(): Readonly<Record<string, ActionName>> {
    return this.bindings;
  }

  // --- convenience accessors used by the player controller -----------------
  get moveX(): number {
    let x = 0;
    if (this.action('right')) x += 1;
    if (this.action('left')) x -= 1;
    return x + this.pad.moveX;
  }

  get moveY(): number {
    let y = 0;
    if (this.action('forward')) y += 1;
    if (this.action('back')) y -= 1;
    return y - this.pad.moveY;
  }

  /** Look delta in degrees for this frame, already scaled by sensitivity. */
  lookDelta(out: { x: number; y: number }, sensitivityMultiplier = 1): void {
    const s = settingsStore.current;
    const sens = 0.0022 * s.mouseSensitivity * sensitivityMultiplier;
    const invert = s.invertY ? -1 : 1;
    out.x = this.mouseDelta.x * sens;
    out.y = this.mouseDelta.y * sens * invert;
    // Gamepad look: rate-based rather than delta-based.
    if (Math.abs(this.pad.lookX) > 0 || Math.abs(this.pad.lookY) > 0) {
      const dt = this.lastDelta || 1 / 60;
      const stickScale = 2.6 * s.mouseSensitivity * sensitivityMultiplier * dt;
      out.x += this.pad.lookX * stickScale * 0.35;
      out.y += this.pad.lookY * stickScale * 0.35 * invert;
    }
  }

  /** Frame delta stashed by `pollGamepad` callers so look can be rate-based. */
  lastDelta = 1 / 60;
}
