/**
 * RENDER PIPELINE
 * ===============
 * WebGL2 renderer + a compact hand-written post-processing chain:
 *
 *   scene ─▶ HDR sceneRT ─┬─▶ bright-pass (½ res) ─▶ 2× separable gaussian ─▶ bloom
 *                         └──────────────────────────────────────┬─────────┐
 *                       view model (own camera, cleared depth) ──┘         │
 *   composite (tonemap + grade + bloom + vignette + grain + damage FX) ◀────┘
 *
 * Three.js is asked to render into a render target, which means it skips tone
 * mapping and colour-space conversion (both are only applied when drawing to the
 * canvas) — so the composite pass owns the entire look: ACES filmic tone mapping,
 * sRGB encode, colour grading, vignette, film grain and the damage/low-health
 * screen effects all live in one shader.
 *
 * The view model is drawn with a *separate* camera (narrower FOV, tighter near
 * plane) after clearing depth, so weapons never clip through walls and always
 * read at the intended size — the standard FPS two-camera trick.
 */
import * as THREE from 'three';
import type { QualitySettings } from '@/core/Settings';
import type { LevelTheme } from '@/config/campaign';

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uSoftKnee;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float knee = max(0.0, l - uThreshold) / max(1e-4, uSoftKnee);
  float w = clamp(knee, 0.0, 1.0);
  gl_FragColor = vec4(c * w, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uDirection;   // texel-sized step
void main() {
  // 9-tap gaussian (sigma ~2.2) — cheap and stable at half res.
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;
  sum += texture2D(tDiffuse, vUv + uDirection * 1.3846153846).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv - uDirection * 1.3846153846).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv + uDirection * 3.2307692308).rgb * 0.0702702703;
  sum += texture2D(tDiffuse, vUv - uDirection * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uResolution;
uniform float uTime;
uniform float uExposure;
uniform float uBloom;
uniform float uVignette;
uniform float uGrain;
uniform float uChroma;
uniform float uDamage;      // red flash 0..1
uniform float uHurt;        // dark vignette pulse 0..1
uniform float uLowHealth;   // desaturation + pulse 0..1
uniform float uAdrenaline;  // warm push 0..1
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uGamma;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uTint;
uniform float uFlashlightOn; // bool-ish

// ACES filmic approximation (Narkowicz) — cheap and contrasty.
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = vUv;
  // Barrel-ish chromatic aberration that grows toward the frame edges.
  vec2 centred = uv - 0.5;
  float r2 = dot(centred, centred);
  vec2 offset = centred * (0.0016 + uChroma * 0.006 + uDamage * 0.004) * (0.35 + r2 * 2.2);
  vec3 col;
  col.r = texture2D(tScene, uv + offset).r;
  col.g = texture2D(tScene, uv).g;
  col.b = texture2D(tScene, uv - offset).b;

  // Bloom.
  vec3 bloom = texture2D(tBloom, uv).rgb;
  col += bloom * uBloom;

  // Exposure + tone map.
  col *= uExposure;
  col = aces(col);

  // --- colour grade -------------------------------------------------------
  // Lift / gain operate in the display-referred domain, then gamma.
  col = col * (1.0 - uLift) + uLift;
  col *= uGain;
  col = pow(max(col, vec3(0.0)), vec3(1.0 / uGamma));
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
  col = (col - 0.5) * uContrast + 0.5;
  col *= uTint;

  // --- screen effects -----------------------------------------------------
  // Low health: desaturate and pulse red at the edges.
  float pulse = 0.5 + 0.5 * sin(uTime * 4.0);
  col = mix(col, vec3(luma * 0.85), uLowHealth * 0.55);
  col = mix(col, vec3(0.55, 0.05, 0.04), uLowHealth * 0.16 * pulse);

  // Adrenaline: warm, saturated, slightly brighter.
  col = mix(col, col * vec3(1.12, 1.02, 0.9) + vec3(0.03, 0.012, 0.0), uAdrenaline);

  // Damage flash: a fast full-frame red veil.
  col = mix(col, vec3(0.62, 0.05, 0.04), uDamage * 0.42);

  // Hurt / low-health vignette.
  float vig = smoothstep(0.85, 0.15, length(centred) * 1.35);
  col *= mix(1.0, vig, uVignette);
  col = mix(col, vec3(0.02, 0.0, 0.0), (1.0 - vig) * uHurt * 0.75);

  // Slight cool edge darkening when the flashlight is on (keeps the middle hot).
  col *= 1.0 - uFlashlightOn * (1.0 - vig) * 0.18;

  // Film grain, less visible in highlights.
  float g = hash(uv * uResolution + fract(uTime) * 137.0) - 0.5;
  col += g * uGrain * (1.0 - luma * 0.6);

  // sRGB encode (three expects the final pass to do this when rendering to the
  // canvas from a linear HDR buffer).
  col = max(col, vec3(0.0));
  vec3 srgb = (col <= vec3(0.0031308)) ? col * 12.92 : 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055;

  gl_FragColor = vec4(srgb, 1.0);
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vWorld = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vWorld;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uHaze;
void main() {
  vec3 dir = normalize(vWorld);
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(h, 0.75));
  // Sun disc + forward scattering glow.
  float sd = max(0.0, dot(dir, normalize(uSunDir)));
  col += uSunColor * pow(sd, 220.0) * uSunIntensity * 12.0;
  col += uSunColor * pow(sd, 6.0) * uSunIntensity * 0.35 * uHaze;
  // Ground haze near the horizon.
  col = mix(col, uHorizon * 0.9, smoothstep(0.5, 0.42, h) * 0.5);
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface RenderDebugInfo {
  drawCalls: number;
  triangles: number;
  programs: number;
  textures: number;
  geometries: number;
}

/** Reusable colour for uniform uploads (avoid per-call allocation). */
const TINT_SCRATCH = new THREE.Color();

export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly viewScene = new THREE.Scene();
  readonly viewCamera: THREE.PerspectiveCamera;
  readonly sky: THREE.Mesh;

  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private brightRT: THREE.WebGLRenderTarget | null = null;
  private blurRT: THREE.WebGLRenderTarget | null = null;
  private blurRT2: THREE.WebGLRenderTarget | null = null;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;

  private quality: QualitySettings;
  private theme: LevelTheme | null = null;
  private sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  private time = 0;

  // Screen-effect state (all smoothed toward targets).
  private fx = {
    damage: 0,
    damageTarget: 0,
    hurt: 0,
    hurtTarget: 0,
    lowHealth: 0,
    lowHealthTarget: 0,
    adrenaline: 0,
    adrenalineTarget: 0,
    chroma: 0,
    chromaTarget: 0,
    exposure: 1,
    exposureTarget: 1,
  };

  private width = 1;
  private height = 1;
  /** Set by the engine when the player uses a flashlight. */
  flashlight = 0;

  constructor(readonly canvas: HTMLCanvasElement, quality: QualitySettings) {
    this.quality = quality;

    this.webgl = new THREE.WebGLRenderer({
      canvas,
      antialias: quality.msaa > 0 && !quality.postProcessing,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.webgl.setClearColor(0x05070a, 1);
    this.webgl.autoClear = true;
    this.webgl.shadowMap.enabled = quality.shadows;
    this.webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.NoToneMapping;
    this.webgl.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(85, 16 / 9, 0.04, 900);
    this.viewCamera = new THREE.PerspectiveCamera(72, 16 / 9, 0.005, 4);

    // Sky dome (drawn first, unaffected by fog).
    const skyGeo = new THREE.SphereGeometry(600, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uHorizon: { value: new THREE.Color(0x8a8f92) },
        uZenith: { value: new THREE.Color(0x3a4a58) },
        uSunDir: { value: this.sunDir.clone() },
        uSunColor: { value: new THREE.Color(0xfff0d8) },
        uSunIntensity: { value: 1 },
        uHaze: { value: 1 },
      },
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.scene.add(this.sky);

    // Full-screen quad used by every post pass.
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: BRIGHT_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 1.05 }, uSoftKnee: { value: 0.55 } },
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: { tDiffuse: { value: null }, uDirection: { value: new THREE.Vector2() } },
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uResolution: { value: new THREE.Vector2(1920, 1080) },
        uTime: { value: 0 },
        uExposure: { value: 1 },
        uBloom: { value: quality.bloom },
        uVignette: { value: 0.4 },
        uGrain: { value: 0.035 },
        uChroma: { value: 0 },
        uDamage: { value: 0 },
        uHurt: { value: 0 },
        uLowHealth: { value: 0 },
        uAdrenaline: { value: 0 },
        uLift: { value: new THREE.Vector3(0.008, 0.008, 0.01) },
        uGain: { value: new THREE.Vector3(1.02, 1.02, 1.02) },
        uGamma: { value: 1 },
        uSaturation: { value: 0.95 },
        uContrast: { value: 1.04 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uFlashlightOn: { value: 0 },
      },
    });

    this.resize();
  }

  // -------------------------------------------------------------------------
  // Quality / theme
  // -------------------------------------------------------------------------

  applyQuality(q: QualitySettings): void {
    this.quality = q;
    this.webgl.shadowMap.enabled = q.shadows;
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.compositeMat.uniforms.uBloom.value = q.bloom;
    this.compositeMat.uniforms.uGrain.value = q.postProcessing ? 0.035 : 0;
    // Atmosphere costs fill rate: on low quality the fog is pushed back so the
    // scene stays readable instead of turning into a grey wall.
    if (this.theme && this.scene.fog instanceof THREE.FogExp2) {
      const fogScale = Math.min(1.5, Math.max(0.45, q.fogDistance / 90));
      this.scene.fog.density = this.theme.fogDensity * fogScale;
    }
    // When post is off we let three do tone mapping + colour space conversion.
    this.webgl.toneMapping = q.postProcessing ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.disposeTargets();
    this.resize();
  }

  /** Configure fog, sky and the sun from the chapter theme. */
  applyTheme(theme: LevelTheme): void {
    this.theme = theme;
    const fog = new THREE.FogExp2(theme.fogColor, theme.fogDensity);
    this.scene.fog = fog;
    this.scene.background = new THREE.Color(theme.fogColor);

    // Sun direction from azimuth/elevation (degrees).
    const el = (theme.sunElevation * Math.PI) / 180;
    const az = (theme.sunAzimuth * Math.PI) / 180;
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();

    const u = (this.sky.material as THREE.ShaderMaterial).uniforms;
    (u.uHorizon.value as THREE.Color).setHex(theme.fogColor);
    (u.uZenith.value as THREE.Color).setHex(theme.skyColor);
    (u.uSunDir.value as THREE.Vector3).copy(this.sunDir);
    (u.uSunColor.value as THREE.Color).setHex(theme.sunColor);
    u.uSunIntensity.value = theme.sunIntensity;
    u.uHaze.value = theme.haze;

    this.compositeMat.uniforms.uLift.value.setScalar(theme.grade.lift);
    this.compositeMat.uniforms.uGain.value.setScalar(theme.grade.gain);
    this.compositeMat.uniforms.uGamma.value = theme.grade.gamma;
    this.compositeMat.uniforms.uSaturation.value = theme.grade.saturation;
    this.compositeMat.uniforms.uContrast.value = theme.grade.contrast;
    TINT_SCRATCH.setHex(theme.grade.tint);
    (this.compositeMat.uniforms.uTint.value as THREE.Vector3).set(TINT_SCRATCH.r, TINT_SCRATCH.g, TINT_SCRATCH.b);
    this.compositeMat.uniforms.uVignette.value = theme.vignette;
    this.compositeMat.uniforms.uExposure.value = 1;
    this.fx.exposure = 1;
  }

  get sunDirection(): THREE.Vector3 {
    return this.sunDir;
  }

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------

  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.width = w;
    this.height = h;
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio);
    this.webgl.setPixelRatio(pr);
    this.webgl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    this.compositeMat.uniforms.uResolution.value.set(w * pr, h * pr);
    this.disposeTargets();
    if (this.quality.postProcessing) this.createTargets();
  }

  private createTargets(): void {
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio);
    const w = Math.max(2, Math.floor(this.width * pr));
    const h = Math.max(2, Math.floor(this.height * pr));
    const halfW = Math.max(2, Math.floor(w * 0.5));
    const halfH = Math.max(2, Math.floor(h * 0.5));
    const hdr = { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace, depthBuffer: true, stencilBuffer: false };
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, { ...hdr, samples: this.quality.msaa });
    this.brightRT = new THREE.WebGLRenderTarget(halfW, halfH, { ...hdr, depthBuffer: false });
    this.blurRT = new THREE.WebGLRenderTarget(halfW, halfH, { ...hdr, depthBuffer: false });
    this.blurRT2 = new THREE.WebGLRenderTarget(halfW, halfH, { ...hdr, depthBuffer: false });
    for (const rt of [this.sceneRT, this.brightRT, this.blurRT, this.blurRT2]) {
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.generateMipmaps = false;
    }
  }

  private disposeTargets(): void {
    for (const rt of [this.sceneRT, this.brightRT, this.blurRT, this.blurRT2]) rt?.dispose();
    this.sceneRT = this.brightRT = this.blurRT = this.blurRT2 = null;
  }

  // -------------------------------------------------------------------------
  // Screen effects API
  // -------------------------------------------------------------------------

  /** Red flash when the player takes damage (0..1). */
  flashDamage(amount: number): void {
    this.fx.damageTarget = Math.min(1, this.fx.damageTarget + amount);
    this.fx.damage = Math.min(1, this.fx.damage + amount * 0.9);
  }

  /** Directional hurt vignette (used while being attacked). */
  pulseHurt(amount: number): void {
    this.fx.hurtTarget = Math.min(1, this.fx.hurtTarget + amount);
  }

  /** Sets the persistent low-health look (0 = healthy, 1 = near death). */
  setLowHealth(t: number): void {
    this.fx.lowHealthTarget = Math.max(0, Math.min(1, t));
  }

  setAdrenaline(t: number): void {
    this.fx.adrenalineTarget = Math.max(0, Math.min(1, t));
  }

  /** Chromatic aberration bump (explosions, tank footsteps). */
  setChroma(t: number): void {
    this.fx.chromaTarget = Math.max(0, Math.min(1, t));
  }

  setFlashlight(on: boolean): void {
    this.flashlight = on ? 1 : 0;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * Render one frame.
   * @param viewModelGroup optional first-person model group (drawn with its own camera)
   */
  render(dt: number, viewModelGroup: THREE.Object3D | null): void {
    this.time += dt;
    // Smooth the effects.
    const k = 1 - Math.exp(-14 * dt);
    this.fx.damage += (this.fx.damageTarget - this.fx.damage) * k;
    this.fx.hurt += (this.fx.hurtTarget - this.fx.hurt) * (1 - Math.exp(-5 * dt));
    this.fx.lowHealth += (this.fx.lowHealthTarget - this.fx.lowHealth) * (1 - Math.exp(-4 * dt));
    this.fx.adrenaline += (this.fx.adrenalineTarget - this.fx.adrenaline) * (1 - Math.exp(-3 * dt));
    this.fx.chroma += (this.fx.chromaTarget - this.fx.chroma) * (1 - Math.exp(-6 * dt));
    // Decay the transient targets.
    this.fx.damageTarget = Math.max(0, this.fx.damageTarget - dt * 2.6);
    this.fx.hurtTarget = Math.max(0, this.fx.hurtTarget - dt * 1.1);
    this.fx.chromaTarget = Math.max(0, this.fx.chromaTarget - dt * 1.8);

    // Sky follows the camera so it never clips.
    this.sky.position.copy(this.camera.position);

    if (!this.quality.postProcessing || !this.sceneRT) {
      // Direct path: three handles tone mapping + sRGB.
      this.webgl.info.reset();
      this.webgl.setRenderTarget(null);
      this.webgl.autoClear = true;
      this.webgl.render(this.scene, this.camera);
      if (viewModelGroup) {
        this.webgl.autoClear = false;
        this.webgl.clearDepth();
        this.webgl.render(this.viewScene, this.viewCamera);
      }
      this.webgl.autoClear = true;
      return;
    }

    // --- 1. scene into HDR target -----------------------------------------
    this.webgl.info.reset();
    this.webgl.setRenderTarget(this.sceneRT);
    this.webgl.autoClear = true;
    this.webgl.render(this.scene, this.camera);

    // --- 2. view model into the same target, depth cleared -----------------
    if (viewModelGroup) {
      this.webgl.autoClear = false;
      this.webgl.clearDepth();
      this.webgl.render(this.viewScene, this.viewCamera);
      this.webgl.autoClear = true;
    }

    // --- 3. bright pass ---------------------------------------------------
    this.quad.material = this.brightMat;
    this.brightMat.uniforms.tDiffuse.value = this.sceneRT.texture;
    this.brightMat.uniforms.uThreshold.value = 0.95;
    this.webgl.setRenderTarget(this.brightRT);
    this.webgl.render(this.quadScene, this.quadCamera);

    // --- 4. separable blur (two ping-pong iterations) ----------------------
    this.quad.material = this.blurMat;
    const texelX = 1 / Math.max(1, this.brightRT!.width);
    const texelY = 1 / Math.max(1, this.brightRT!.height);
    const iterations = this.quality.tier === 'low' ? 1 : 2;
    let input = this.brightRT!;
    for (let i = 0; i < iterations; i++) {
      const scale = 1 + i * 1.5;
      // horizontal
      this.blurMat.uniforms.tDiffuse.value = input.texture;
      this.blurMat.uniforms.uDirection.value.set(texelX * scale, 0);
      this.webgl.setRenderTarget(this.blurRT);
      this.webgl.render(this.quadScene, this.quadCamera);
      // vertical
      this.blurMat.uniforms.tDiffuse.value = this.blurRT!.texture;
      this.blurMat.uniforms.uDirection.value.set(0, texelY * scale);
      this.webgl.setRenderTarget(this.blurRT2);
      this.webgl.render(this.quadScene, this.quadCamera);
      // Accumulate for a wider, softer bloom.
      input = this.blurRT2!;
      if (i > 0) {
        this.blurMat.uniforms.tDiffuse.value = this.blurRT2!.texture;
      }
    }

    // --- 5. composite -----------------------------------------------------
    const u = this.compositeMat.uniforms;
    u.tScene.value = this.sceneRT.texture;
    u.tBloom.value = this.blurRT2!.texture;
    u.uTime.value = this.time;
    u.uDamage.value = this.fx.damage;
    u.uHurt.value = this.fx.hurt;
    u.uLowHealth.value = this.fx.lowHealth;
    u.uAdrenaline.value = this.fx.adrenaline;
    u.uChroma.value = this.fx.chroma;
    u.uFlashlightOn.value = this.flashlight;
    u.uGrain.value = this.quality.postProcessing ? 0.03 : 0;
    this.quad.material = this.compositeMat;
    this.webgl.setRenderTarget(null);
    this.webgl.render(this.quadScene, this.quadCamera);
  }

  get debugInfo(): RenderDebugInfo {
    const info = this.webgl.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
    };
  }

  dispose(): void {
    this.disposeTargets();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.quad.geometry.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.webgl.dispose();
  }
}
