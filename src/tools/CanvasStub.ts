/**
 * CANVAS STUB (development only)
 * ==============================
 * The procedural texture code (`src/render/Materials.ts`) needs a 2D canvas.
 * Browsers have one; Node does not. This stub implements the small slice of the
 * CanvasRenderingContext2D API the texture generators actually use, which lets
 * the level generator, the navigation baker and the Director run headless.
 *
 * It is imported by `src/tools/HeadlessLevels.ts` and never by game code, so it
 * contributes nothing to the shipped bundle.
 */

type Ctx2D = CanvasRenderingContext2D;

interface StubImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace: string;
}

function makeImageData(width: number, height: number): StubImageData {
  return {
    data: new Uint8ClampedArray(Math.max(1, width * height * 4)),
    width,
    height,
    colorSpace: 'srgb',
  };
}

function makeContext(canvas: StubCanvas): Ctx2D {
  const noop = (): void => undefined;
  const gradient = { addColorStop: noop } as unknown as CanvasGradient;
  const ctx: Record<string, unknown> = {
    canvas,
    // state
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    filter: 'none',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    shadowBlur: 0,
    shadowColor: 'rgba(0,0,0,0)',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    // drawing
    save: noop,
    restore: noop,
    scale: noop,
    rotate: noop,
    translate: noop,
    transform: noop,
    setTransform: noop,
    resetTransform: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    arcTo: noop,
    ellipse: noop,
    rect: noop,
    roundRect: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    strokeText: noop,
    setLineDash: noop,
    getLineDash: () => [],
    drawImage: noop,
    measureText: () => ({ width: 8 }) as TextMetrics,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => null,
    createImageData: (w: number, h: number) => makeImageData(w, h),
    getImageData: (_x: number, _y: number, w: number, h: number) => makeImageData(w, h),
    putImageData: noop,
  };
  return ctx as unknown as Ctx2D;
}

interface StubCanvas {
  width: number;
  height: number;
  style: Record<string, unknown>;
  getContext(kind: string): Ctx2D | null;
  toDataURL(): string;
  addEventListener?: () => void;
  removeEventListener?: () => void;
}

function makeCanvas(width = 300, height = 150): StubCanvas {
  const canvas: StubCanvas = {
    width,
    height,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? makeContext(canvas) : null),
    toDataURL: () => 'data:image/png;base64,',
  };
  return canvas;
}

/**
 * Install the stub as `document`/`window`/`ImageBitmap` if they are missing.
 * Safe to call more than once and a no-op in the browser.
 */
export function installCanvasStub(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const doc = (g.document ?? {}) as Record<string, unknown>;
  doc.createElement = (tag: string): unknown => {
    if (tag === 'canvas') return makeCanvas();
    if (tag === 'img') return { width: 0, height: 0, src: '' };
    // HUD/menu elements are never built headlessly, but a stub keeps any
    // accidental access from throwing a confusing error during the check.
    return {
      style: {},
      classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined, contains: () => false },
      appendChild: () => undefined,
      remove: () => undefined,
      addEventListener: () => undefined,
      querySelector: () => null,
      innerHTML: '',
      textContent: '',
    };
  };
  doc.createElementNS = (_ns: string, tag: string) => (doc.createElement as (t: string) => unknown)(tag);
  doc.body = { appendChild: () => undefined, removeChild: () => undefined, style: {} };
  doc.documentElement = { style: {} };
  doc.addEventListener = () => undefined;
  doc.removeEventListener = () => undefined;
  doc.querySelector = () => null;
  doc.getElementById = () => null;
  g.document = doc;

  const win = (g.window ?? {}) as Record<string, unknown>;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.devicePixelRatio = 1;
  win.innerWidth = 1280;
  win.innerHeight = 720;
  win.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 0);
  win.cancelAnimationFrame = (id: number) => clearTimeout(id);
  win.performance = performance;
  // No AudioContext in Node: the audio system must degrade to a silent no-op.
  delete win.AudioContext;
  g.window = win;

  g.requestAnimationFrame = win.requestAnimationFrame;
  g.cancelAnimationFrame = win.cancelAnimationFrame;
  // Some globals (navigator, localStorage) are getter-only in modern Node, so
  // only define them when they are genuinely absent and writable.
  const defineIfMissing = (key: string, value: unknown): void => {
    if (g[key] !== undefined) return;
    try {
      Object.defineProperty(g, key, { value, writable: true, configurable: true });
    } catch {
      /* read-only host global — ignore */
    }
  };
  defineIfMissing('navigator', { userAgent: 'node' });
  defineIfMissing('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
  defineIfMissing('devicePixelRatio', 1);
  defineIfMissing('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
}
