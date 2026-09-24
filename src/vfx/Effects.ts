/**
 * EFFECTS (VFX)
 * =============
 * All visual effects run through three GPU-instanced pools so the CPU cost per
 * particle is a handful of float writes and there is exactly one draw call per
 * pool regardless of particle count:
 *
 *  - `SpritePool`  — billboarded soft particles (smoke, blood, sparks, fire, gibs).
 *  - `TracerPool`  — stretched view-aligned quads for bullet tracers and tongue
 *                    whips (a start/end pair per instance, no CPU geometry work).
 *  - `DecalPool`   — world-space quads projected on surfaces (blood pools, bullet
 *                    holes, scorch marks) with a ring buffer.
 *
 * Pools use custom instanced attributes rather than `InstancedMesh` matrices,
 * which halves the per-frame upload cost and, critically, allows per-particle
 * alpha (which `instanceColor` cannot express).
 */
import * as THREE from 'three';
import { Rng, clamp01 } from '@/core/MathUtil';
import type { QualitySettings } from '@/core/Settings';
import type { VfxTextures } from '@/render/Materials';

// ---------------------------------------------------------------------------
// Sprite pool
// ---------------------------------------------------------------------------

const SPRITE_VERT = /* glsl */ `
precision highp float;
attribute vec3 aOffset;
attribute vec4 aColor;
attribute vec2 aSize;   // x = start size, y = end size
attribute float aRot;
varying vec2 vUv;
varying vec4 vColor;
uniform float uTime;
void main() {
  vUv = uv;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
  // Billboard in view space; rotation about the view axis.
  float c = cos(aRot);
  float s = sin(aRot);
  vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  mv.xy += p * aSize.x;
  gl_Position = projectionMatrix * mv;
}
`;

const SPRITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vColor;
uniform sampler2D tMap;
void main() {
  vec4 tex = texture2D(tMap, vUv);
  vec4 c = tex * vColor;
  if (c.a < 0.004) discard;
  gl_FragColor = c;
}
`;

interface SpriteData {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size0: number;
  size1: number;
  life: number;
  maxLife: number;
  color: THREE.Color;
  alpha0: number;
  gravity: number;
  drag: number;
  rot: number;
  rotVel: number;
  /** 0..1 blend toward additive when used for sparks/fire. */
  additive: number;
}

export class SpritePool {
  readonly mesh: THREE.Mesh;
  private data: SpriteData[] = [];
  private capacity: number;
  private geometry: THREE.InstancedBufferGeometry;
  private aOffset: THREE.InstancedBufferAttribute;
  private aColorAttr: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private aRot: THREE.InstancedBufferAttribute;
  /** Free-list of inactive particle slots. */
  private free: number[] = [];
  private activeCount = 0;

  constructor(map: THREE.Texture, capacity: number, additive = false, blend: THREE.Blending = THREE.NormalBlending) {
    this.capacity = capacity;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    geo.instanceCount = capacity;
    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geo.setAttribute('aOffset', this.aOffset);
    geo.setAttribute('aColor', this.aColorAttr);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aRot', this.aRot);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    const mat = new THREE.ShaderMaterial({
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      uniforms: { tMap: { value: map }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: blend,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = `sprites_${additive ? 'add' : 'alpha'}`;

    for (let i = 0; i < capacity; i++) {
      this.data.push({
        x: 0,
        y: -9999,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        size0: 0,
        size1: 0,
        life: 0,
        maxLife: 1,
        color: new THREE.Color(1, 1, 1),
        alpha0: 1,
        gravity: 0,
        drag: 0,
        rot: 0,
        rotVel: 0,
        additive: additive ? 1 : 0,
      });
      this.free.push(i);
      // Hide initially.
      this.aSize.setXY(i, 0, 0);
    }
    void additive;
  }

  get active(): number {
    return this.activeCount;
  }

  get used(): number {
    return this.capacity - this.free.length;
  }

  spawn(s: Partial<SpriteData> & { x: number; y: number; z: number; life: number }): number | null {
    const idx = this.free.pop();
    if (idx === undefined) return null;
    const d = this.data[idx];
    d.x = s.x;
    d.y = s.y;
    d.z = s.z;
    d.vx = s.vx ?? 0;
    d.vy = s.vy ?? 0;
    d.vz = s.vz ?? 0;
    d.size0 = s.size0 ?? 0.3;
    d.size1 = s.size1 ?? 0.05;
    d.life = s.life;
    d.maxLife = s.life;
    d.alpha0 = s.alpha0 ?? 1;
    d.gravity = s.gravity ?? 0;
    d.drag = s.drag ?? 1.5;
    d.rot = s.rot ?? 0;
    d.rotVel = s.rotVel ?? 0;
    if (s.color) d.color.copy(s.color);
    else d.color.setRGB(1, 1, 1);
    this.activeCount++;
    return idx;
  }

  update(dt: number): void {
    const sizeAttr = this.aSize;
    const colorAttr = this.aColorAttr;
    const offAttr = this.aOffset;
    const rotAttr = this.aRot;
    let active = 0;
    for (let i = 0; i < this.capacity; i++) {
      const d = this.data[i];
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) {
        sizeAttr.setXY(i, 0, 0);
        colorAttr.setXYZW(i, 0, 0, 0, 0);
        offAttr.setXYZ(i, 0, -9999, 0);
        this.free.push(i);
        this.activeCount--;
        continue;
      }
      const t = 1 - d.life / d.maxLife;
      if (d.gravity !== 0) d.vy -= d.gravity * dt;
      if (d.drag > 0) {
        const f = Math.exp(-d.drag * dt);
        d.vx *= f;
        d.vy *= f;
        d.vz *= f;
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      d.rot += d.rotVel * dt;
      const size = d.size0 + (d.size1 - d.size0) * t;
      sizeAttr.setXY(i, size, size);
      const alpha = d.alpha0 * (1 - t * t);
      colorAttr.setXYZW(i, d.color.r, d.color.g, d.color.b, alpha);
      offAttr.setXYZ(i, d.x, d.y, d.z);
      rotAttr.setX(i, d.rot);
      active++;
    }
    this.activeCount = active;
    sizeAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    offAttr.needsUpdate = true;
    rotAttr.needsUpdate = true;
  }

  clear(): void {
    this.free.length = 0;
    for (let i = 0; i < this.capacity; i++) {
      this.data[i].life = 0;
      this.aSize.setXY(i, 0, 0);
      this.aOffset.setXYZ(i, 0, -9999, 0);
      this.free.push(i);
    }
    this.activeCount = 0;
    this.aSize.needsUpdate = true;
    this.aOffset.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------
// Tracer pool
// ---------------------------------------------------------------------------

const TRACER_VERT = /* glsl */ `
precision highp float;
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec4 aColor;
attribute float aWidth;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vUv = uv;
  vColor = aColor;
  float along = position.x + 0.5;          // 0..1 along the segment
  vec4 mvA = modelViewMatrix * vec4(aStart, 1.0);
  vec4 mvB = modelViewMatrix * vec4(aEnd, 1.0);
  vec4 mv = mix(mvA, mvB, along);
  mv.y += position.y * aWidth;
  gl_Position = projectionMatrix * mv;
}
`;

const TRACER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vColor;
uniform sampler2D tMap;
void main() {
  vec4 t = texture2D(tMap, vUv);
  vec4 c = t * vColor;
  if (c.a < 0.01) discard;
  gl_FragColor = c;
}
`;

export class TracerPool {
  readonly mesh: THREE.Mesh;
  private capacity: number;
  private life: Float32Array;
  private maxLife: Float32Array;
  private aStart: THREE.InstancedBufferAttribute;
  private aEnd: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private aWidth: THREE.InstancedBufferAttribute;
  private geometry: THREE.InstancedBufferGeometry;
  private cursor = 0;

  constructor(map: THREE.Texture, capacity = 48) {
    this.capacity = capacity;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    geo.instanceCount = capacity;
    this.aStart = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aEnd = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aWidth = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geo.setAttribute('aStart', this.aStart);
    geo.setAttribute('aEnd', this.aEnd);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aWidth', this.aWidth);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);

    const mat = new THREE.ShaderMaterial({
      vertexShader: TRACER_VERT,
      fragmentShader: TRACER_FRAG,
      uniforms: { tMap: { value: map } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.name = 'tracers';
  }

  fire(
    sx: number,
    sy: number,
    sz: number,
    ex: number,
    ey: number,
    ez: number,
    width: number,
    color: THREE.Color,
    seconds: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.aStart.setXYZ(i, sx, sy, sz);
    this.aEnd.setXYZ(i, ex, ey, ez);
    this.aColor.setXYZW(i, color.r, color.g, color.b, 1);
    this.aWidth.setX(i, width);
    this.life[i] = seconds;
    this.maxLife[i] = seconds;
    this.aStart.needsUpdate = true;
    this.aEnd.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aWidth.needsUpdate = true;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const t = clamp01(this.life[i] / this.maxLife[i]);
      this.aColor.setW(i, t);
      dirty = true;
    }
    if (dirty) this.aColor.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    for (let i = 0; i < this.capacity; i++) this.aColor.setW(i, 0);
    this.aColor.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------
// Decal pool
// ---------------------------------------------------------------------------

export class DecalPool {
  readonly mesh: THREE.InstancedMesh;
  private capacity: number;
  private life: Float32Array;
  private cursor = 0;
  private matrix = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private up = new THREE.Vector3();
  private normal = new THREE.Vector3();

  constructor(map: THREE.Texture, capacity: number, opts: { color?: number; opacity?: number } = {}) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      color: opts.color ?? 0xffffff,
      opacity: opts.opacity ?? 0.85,
      toneMapped: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.capacity = capacity;
    this.life = new Float32Array(capacity);
    // Park unused instances far below the level.
    for (let i = 0; i < capacity; i++) {
      this.matrix.makeScale(0.0001, 0.0001, 0.0001);
      this.matrix.setPosition(0, -2000, 0);
      this.mesh.setMatrixAt(i, this.matrix);
      this.mesh.setColorAt(i, new THREE.Color(1, 1, 1));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  add(x: number, y: number, z: number, nx: number, ny: number, nz: number, size: number, color: THREE.Color): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.normal.set(nx, ny, nz).normalize();
    this.pos.set(x, y, z).addScaledVector(this.normal, 0.012);
    this.up.set(0, 0, 1);
    this.quat.setFromUnitVectors(this.up, this.normal);
    // Random roll so repeats do not read as a grid of identical stamps.
    const roll = Math.random() * Math.PI * 2;
    const q2 = new THREE.Quaternion().setFromAxisAngle(this.normal, roll);
    this.quat.premultiply(q2);
    this.scale.set(size, size, 1);
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.mesh.setMatrixAt(i, this.matrix);
    this.mesh.setColorAt(i, color);
    this.life[i] = 1;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    for (let i = 0; i < this.capacity; i++) {
      this.matrix.makeScale(0.0001, 0.0001, 0.0001);
      this.matrix.setPosition(0, -2000, 0);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------
// Effects manager
// ---------------------------------------------------------------------------

/** Fire/acid hazard volumes — visual + damage (queried by AI and the player). */
export interface HazardField {
  kind: 'fire' | 'acid';
  readonly position: THREE.Vector3;
  radius: number;
  /** Seconds remaining. */
  remaining: number;
  damagePerSecond: number;
  owner: 'survivor' | 'infected';
  /** Visual accumulator. */
  emitTimer: number;
}

export class Effects {
  readonly group = new THREE.Group();
  /** Soft alpha-blended particles: smoke, blood, bile, dust. */
  readonly smoke: SpritePool;
  /** Additive particles: sparks, embers, muzzle smoke embers. */
  readonly sparks: SpritePool;
  /** Blood sprays use their own pool so they never starve behind smoke. */
  readonly blood: SpritePool;
  readonly tracers: TracerPool;
  readonly bulletHoles: DecalPool;
  readonly bloodDecals: DecalPool;
  readonly scorchDecals: DecalPool;
  readonly hazards: HazardField[] = [];

  private rand = new Rng(0xc0ffee);
  private fadeLights: { light: THREE.PointLight; life: number; maxLife: number; intensity: number }[] = [];
  private lightPool: THREE.PointLight[] = [];
  private quality: QualitySettings;
  private tex: VfxTextures;
  private time = 0;
  /** Temporary vectors (avoid per-call allocation). */
  private static _v = new THREE.Vector3();
  private static _c = new THREE.Color();

  constructor(tex: VfxTextures, quality: QualitySettings) {
    this.tex = tex;
    this.quality = quality;
    const budget = quality.maxParticles;
    // Split the particle budget; smoke gets the lion's share.
    this.smoke = new SpritePool(tex.smoke, Math.max(64, Math.floor(budget * 0.45)));
    this.sparks = new SpritePool(tex.spark, Math.max(48, Math.floor(budget * 0.3)), true, THREE.AdditiveBlending);
    this.blood = new SpritePool(tex.bloodSplatter, Math.max(48, Math.floor(budget * 0.25)));
    this.tracers = new TracerPool(tex.rainStreak, 64);
    this.bulletHoles = new DecalPool(tex.bulletHole, Math.max(16, Math.floor(quality.maxDecals * 0.5)), { opacity: 0.95 });
    this.bloodDecals = new DecalPool(tex.bloodDecal, Math.max(16, Math.floor(quality.maxDecals * 0.4)));
    this.scorchDecals = new DecalPool(tex.scorch, Math.max(8, Math.floor(quality.maxDecals * 0.2)), { opacity: 0.7 });

    this.group.add(
      this.smoke.mesh,
      this.sparks.mesh,
      this.blood.mesh,
      this.tracers.mesh,
      this.bulletHoles.mesh,
      this.bloodDecals.mesh,
      this.scorchDecals.mesh,
    );
    this.group.name = 'effects';

    // A small pool of transient point lights (muzzle flash, explosions, fire).
    const lightBudget = Math.max(2, Math.min(6, quality.maxDynamicLights));
    for (let i = 0; i < lightBudget; i++) {
      const l = new THREE.PointLight(0xffb060, 0, 12, 2);
      l.visible = false;
      this.group.add(l);
      this.lightPool.push(l);
    }
  }

  applyQuality(q: QualitySettings): void {
    this.quality = q;
  }

  // --- spawn helpers ------------------------------------------------------

  /** Muzzle smoke + embers + a transient light. */
  muzzleFlash(x: number, y: number, z: number, dirX: number, dirY: number, dirZ: number, scale: number, suppressor: boolean): void {
    const n = suppressor ? 2 : Math.round(4 * scale);
    for (let i = 0; i < n; i++) {
      this.smoke.spawn({
        x: x + this.rand.bell() * 0.05,
        y: y + this.rand.bell() * 0.05,
        z: z + this.rand.bell() * 0.05,
        vx: dirX * 1.2 + this.rand.bell() * 0.6,
        vy: dirY * 1.2 + 0.5 + this.rand.bell() * 0.4,
        vz: dirZ * 1.2 + this.rand.bell() * 0.6,
        size0: 0.06 * scale,
        size1: 0.42 * scale,
        life: this.rand.range(0.25, 0.5),
        color: new THREE.Color(0.62, 0.62, 0.6),
        alpha0: 0.3,
        drag: 2.4,
        rotVel: this.rand.bell() * 2,
      });
    }
    if (!suppressor) {
      for (let i = 0; i < Math.round(5 * scale); i++) {
        this.sparks.spawn({
          x,
          y,
          z,
          vx: dirX * this.rand.range(4, 14) + this.rand.bell() * 3,
          vy: dirY * this.rand.range(4, 10) + this.rand.range(0, 3),
          vz: dirZ * this.rand.range(4, 14) + this.rand.bell() * 3,
          size0: 0.09 * scale,
          size1: 0.01,
          life: this.rand.range(0.1, 0.28),
          color: new THREE.Color(1, 0.75, 0.35),
          gravity: 12,
          drag: 3,
        });
      }
    }
    this.flashLight(x, y, z, 0xffc070, suppressor ? 3 : 22 * scale, suppressor ? 4 : 11, suppressor ? 0.05 : 0.075);
  }

  /** Bullet impact: dust, sparks, and a decal. */
  impact(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    surface: string,
    scale = 1,
  ): void {
    const cfg = IMPACT_LOOK[surface] ?? IMPACT_LOOK.concrete;
    const count = Math.max(2, Math.round(cfg.particles * scale * (this.quality.tier === 'low' ? 0.5 : 1)));
    for (let i = 0; i < count; i++) {
      this.smoke.spawn({
        x,
        y,
        z,
        vx: (nx + this.rand.bell() * 1.4) * this.rand.range(0.6, 3),
        vy: (ny + this.rand.bell() * 1.4) * this.rand.range(0.6, 3) + 0.6,
        vz: (nz + this.rand.bell() * 1.4) * this.rand.range(0.6, 3),
        size0: this.rand.range(0.04, 0.1) * scale,
        size1: this.rand.range(0.22, 0.5) * scale,
        life: this.rand.range(0.28, 0.7),
        color: new THREE.Color(cfg.color).multiplyScalar(this.rand.range(0.6, 1.1)),
        alpha0: 0.62,
        drag: 2.6,
        gravity: 1.2,
        rotVel: this.rand.bell() * 3,
      });
    }
    if (cfg.sparks) {
      for (let i = 0; i < Math.round(4 * scale); i++) {
        this.sparks.spawn({
          x,
          y,
          z,
          vx: (nx + this.rand.bell() * 1.1) * this.rand.range(2, 8),
          vy: (ny + this.rand.bell() * 1.1) * this.rand.range(2, 8) + 1.5,
          vz: (nz + this.rand.bell() * 1.1) * this.rand.range(2, 8),
          size0: 0.05,
          size1: 0.005,
          life: this.rand.range(0.12, 0.4),
          color: new THREE.Color(1, 0.82, 0.42),
          gravity: 14,
          drag: 1.6,
        });
      }
    }
    if (this.rand.chance(cfg.decalChance)) {
      this.bulletHoles.add(x, y, z, nx, ny, nz, this.rand.range(0.1, 0.19) * scale, new THREE.Color(cfg.color));
    }
  }

  /** Blood spray + directional gore. Returns nothing; the caller handles damage. */
  bloodSpray(x: number, y: number, z: number, dirX: number, dirY: number, dirZ: number, amount = 1, heavy = false): void {
    if (this.quality.goreLevel === 'off') return;
    const goreMul = this.quality.goreLevel === 'reduced' ? 0.5 : 1;
    const n = Math.round(amount * (heavy ? 16 : 8) * goreMul);
    for (let i = 0; i < n; i++) {
      const spread = heavy ? 2.4 : 1.2;
      this.blood.spawn({
        x,
        y,
        z,
        vx: dirX * this.rand.range(1, 5) + this.rand.bell() * spread * 3,
        vy: dirY * this.rand.range(1, 4) + this.rand.range(0.5, 2.6),
        vz: dirZ * this.rand.range(1, 5) + this.rand.bell() * spread * 3,
        size0: this.rand.range(0.05, 0.12) * amount,
        size1: this.rand.range(0.01, 0.03),
        life: this.rand.range(0.35, 0.9),
        color: new THREE.Color(0.42, 0.045, 0.03),
        gravity: 12,
        drag: 0.6,
        rotVel: this.rand.bell() * 6,
      });
    }
    // Immediate pool on the floor under the impact.
    if (this.rand.chance(heavy ? 0.9 : 0.35)) {
      const floorY = y - 0.9;
      this.bloodDecals.add(x, Math.max(0.02, floorY), z, 0, 1, 0, this.rand.range(0.5, heavy ? 1.7 : 1.0), new THREE.Color(0.5, 0.06, 0.05));
    }
  }

  /** Chunky gib explosion on overkill / explosions. */
  gib(x: number, y: number, z: number, power = 1): void {
    if (this.quality.goreLevel === 'off') return;
    const mul = this.quality.goreLevel === 'reduced' ? 0.5 : 1;
    const n = Math.round(18 * power * mul);
    for (let i = 0; i < n; i++) {
      this.blood.spawn({
        x,
        y,
        z,
        vx: this.rand.bell() * 7 * power,
        vy: this.rand.range(1, 6) * power,
        vz: this.rand.bell() * 7 * power,
        size0: this.rand.range(0.08, 0.2) * power,
        size1: this.rand.range(0.03, 0.08),
        life: this.rand.range(0.6, 1.6),
        color: new THREE.Color(0.36, 0.05, 0.035),
        gravity: 13,
        drag: 0.5,
        rotVel: this.rand.bell() * 8,
      });
    }
  }

  /** Explosion: fireball, smoke column, sparks, light flash, screen chroma. */
  explosion(x: number, y: number, z: number, radius: number, fire = true): void {
    const power = clamp01(radius / 8);
    for (let i = 0; i < Math.round(14 * power + 6); i++) {
      this.sparks.spawn({
        x,
        y,
        z,
        vx: this.rand.bell() * 16 * power,
        vy: this.rand.range(0.5, 9) * power,
        vz: this.rand.bell() * 16 * power,
        size0: this.rand.range(0.15, 0.4) * power,
        size1: 0.02,
        life: this.rand.range(0.2, 0.6),
        color: new THREE.Color(1, this.rand.range(0.5, 0.85), 0.25),
        gravity: 8,
        drag: 1.4,
        rotVel: this.rand.bell() * 4,
      });
    }
    if (fire) {
      for (let i = 0; i < Math.round(10 * power + 4); i++) {
        this.smoke.spawn({
          x: x + this.rand.bell() * radius * 0.25,
          y: y + this.rand.range(0, radius * 0.2),
          z: z + this.rand.bell() * radius * 0.25,
          vx: this.rand.bell() * 2.5,
          vy: this.rand.range(1.2, 4.5),
          vz: this.rand.bell() * 2.5,
          size0: 0.6 * power + 0.3,
          size1: 2.4 * power + 1,
          life: this.rand.range(0.7, 1.8),
          color: new THREE.Color(0.32, 0.28, 0.26),
          alpha0: 0.7,
          drag: 1.1,
          rotVel: this.rand.bell() * 1.5,
        });
      }
      for (let i = 0; i < Math.round(8 * power + 3); i++) {
        this.sparks.spawn({
          x: x + this.rand.bell(),
          y: y + this.rand.range(0, 1),
          z: z + this.rand.bell(),
          vx: this.rand.bell() * 1.5,
          vy: this.rand.range(1, 3.2),
          vz: this.rand.bell() * 1.5,
          size0: 0.5 * power + 0.2,
          size1: 0.05,
          life: this.rand.range(0.25, 0.6),
          color: new THREE.Color(1, 0.55, 0.18),
          drag: 2.2,
          rotVel: 0,
        });
      }
    }
    const floor = Math.max(0.02, y - 1);
    this.scorchDecals.add(x, floor, z, 0, 1, 0, radius * 1.1, new THREE.Color(0.15, 0.14, 0.13));
    this.flashLight(x, y + 0.6, z, 0xff8a30, 60 * power + 12, radius * 3, 0.35);
  }

  /** Fire pool from a molotov: continuous emitter + hazard volume. */
  addFire(x: number, y: number, z: number, radius: number, duration: number, damagePerSecond: number, owner: 'survivor' | 'infected'): HazardField {
    const field: HazardField = {
      kind: 'fire',
      position: new THREE.Vector3(x, y, z),
      radius,
      remaining: duration,
      damagePerSecond,
      owner,
      emitTimer: 0,
    };
    this.hazards.push(field);
    return field;
  }

  addAcid(x: number, y: number, z: number, radius: number, duration: number, damagePerSecond: number, owner: 'survivor' | 'infected'): HazardField {
    const field: HazardField = {
      kind: 'acid',
      position: new THREE.Vector3(x, y, z),
      radius,
      remaining: duration,
      damagePerSecond,
      owner,
      emitTimer: 0,
    };
    this.hazards.push(field);
    this.scorchDecals.add(x, Math.max(0.02, y), z, 0, 1, 0, radius * 1.2, new THREE.Color(0.45, 0.6, 0.12));
    return field;
  }

  /** Bile splat: marks survivors/zombies as "attractive" and adds visual residue. */
  bileSplat(x: number, y: number, z: number, radius: number): void {
    for (let i = 0; i < 26; i++) {
      this.smoke.spawn({
        x: x + this.rand.bell() * radius * 0.5,
        y: y + this.rand.range(-0.4, 0.6),
        z: z + this.rand.bell() * radius * 0.5,
        vx: this.rand.bell() * 2,
        vy: this.rand.range(0.4, 2.4),
        vz: this.rand.bell() * 2,
        size0: 0.16,
        size1: 0.7,
        life: this.rand.range(0.5, 1.3),
        color: new THREE.Color(0.55, 0.7, 0.16),
        alpha0: 0.75,
        gravity: 3,
        drag: 1.6,
        rotVel: this.rand.bell() * 3,
      });
    }
    this.scorchDecals.add(x, Math.max(0.02, y - 1), z, 0, 1, 0, radius * 1.3, new THREE.Color(0.5, 0.62, 0.16));
  }

  /** Impact + dust burst used by Ragdoll and Tank footsteps. */
  dust(x: number, y: number, z: number, size = 1): void {
    for (let i = 0; i < 6; i++) {
      this.smoke.spawn({
        x: x + this.rand.bell() * 0.4 * size,
        y,
        z: z + this.rand.bell() * 0.4 * size,
        vx: this.rand.bell() * 1.4,
        vy: this.rand.range(0.3, 1.4),
        vz: this.rand.bell() * 1.4,
        size0: 0.25 * size,
        size1: 0.9 * size,
        life: this.rand.range(0.4, 1.0),
        color: new THREE.Color(0.55, 0.52, 0.47),
        alpha0: 0.4,
        drag: 1.8,
        rotVel: this.rand.bell() * 1.5,
      });
    }
  }

  /** Squib for zombie hits on surfaces (glass, wood chips). */
  debrisBurst(x: number, y: number, z: number, count: number, color: number): void {
    for (let i = 0; i < count; i++) {
      this.smoke.spawn({
        x,
        y,
        z,
        vx: this.rand.bell() * 4,
        vy: this.rand.range(0.5, 3.5),
        vz: this.rand.bell() * 4,
        size0: this.rand.range(0.04, 0.1),
        size1: 0.02,
        life: this.rand.range(0.4, 1.1),
        color: new THREE.Color(color),
        gravity: 10,
        drag: 0.8,
        rotVel: this.rand.bell() * 6,
      });
    }
  }

  /** Transient point light (muzzle flash, explosion, muzzle-lit walls). */
  flashLight(x: number, y: number, z: number, color: number, intensity: number, distance: number, life: number): void {
    const light = this.lightPool.find((l) => !l.visible) ?? this.lightPool[0];
    light.position.set(x, y, z);
    light.color.setHex(color);
    light.intensity = intensity;
    light.distance = distance;
    light.visible = true;
    this.fadeLights.push({ light, life, maxLife: life, intensity });
  }

  /** Bullet tracer between two points. */
  tracer(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, width = 0.035, color = 0xffd9a0): void {
    this.tracers.fire(sx, sy, sz, ex, ey, ez, width, new THREE.Color(color), 0.09);
  }

  // --- per frame ---------------------------------------------------------

  update(dt: number): void {
    this.time += dt;
    this.smoke.update(dt);
    this.sparks.update(dt);
    this.blood.update(dt);
    this.tracers.update(dt);

    // Hazard emitters.
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.remaining -= dt;
      if (h.remaining <= 0) {
        this.hazards.splice(i, 1);
        continue;
      }
      h.emitTimer -= dt;
      if (h.emitTimer <= 0) {
        h.emitTimer = h.kind === 'fire' ? 0.045 : 0.22;
        if (h.kind === 'fire') {
          const a = this.rand.range(0, Math.PI * 2);
          const r = Math.sqrt(this.rand.next()) * h.radius * 0.85;
          this.sparks.spawn({
            x: h.position.x + Math.cos(a) * r,
            y: h.position.y + 0.1,
            z: h.position.z + Math.sin(a) * r,
            vx: this.rand.bell() * 0.5,
            vy: this.rand.range(1.4, 3.2),
            vz: this.rand.bell() * 0.5,
            size0: this.rand.range(0.25, 0.6),
            size1: 0.03,
            life: this.rand.range(0.35, 0.85),
            color: new THREE.Color(1, this.rand.range(0.45, 0.75), 0.16),
            drag: 2.6,
            rotVel: 0,
          });
          if (this.rand.chance(0.4)) {
            this.smoke.spawn({
              x: h.position.x + Math.cos(a) * r,
              y: h.position.y + 1.1,
              z: h.position.z + Math.sin(a) * r,
              vx: this.rand.bell() * 0.6,
              vy: this.rand.range(1, 2.4),
              vz: this.rand.bell() * 0.6,
              size0: 0.4,
              size1: 1.6,
              life: this.rand.range(0.9, 2.0),
              color: new THREE.Color(0.2, 0.19, 0.18),
              alpha0: 0.36,
              drag: 1.2,
              rotVel: this.rand.bell() * 0.8,
            });
          }
        } else {
          // Acid bubbles.
          this.sparks.spawn({
            x: h.position.x + this.rand.bell() * h.radius * 0.7,
            y: h.position.y + 0.05,
            z: h.position.z + this.rand.bell() * h.radius * 0.7,
            vx: 0,
            vy: this.rand.range(0.3, 1.1),
            vz: 0,
            size0: this.rand.range(0.12, 0.3),
            size1: 0.02,
            life: this.rand.range(0.3, 0.7),
            color: new THREE.Color(0.6, 0.85, 0.2),
            drag: 2,
          });
        }
      }
    }

    // Fade transient lights.
    for (let i = this.fadeLights.length - 1; i >= 0; i--) {
      const f = this.fadeLights[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.light.visible = false;
        f.light.intensity = 0;
        this.fadeLights.splice(i, 1);
        continue;
      }
      const t = f.life / f.maxLife;
      f.light.intensity = f.intensity * t * t;
    }
  }

  /** Damage query for hazards — used by zombies, teammates and the player. */
  hazardDamageAt(x: number, y: number, z: number, target: 'survivor' | 'infected'): number {
    let dmg = 0;
    for (const h of this.hazards) {
      if (h.owner === target) continue;
      const dx = h.position.x - x;
      const dz = h.position.z - z;
      const dy = h.position.y - y;
      if (dx * dx + dz * dz > h.radius * h.radius) continue;
      if (dy > 2.5 || dy < -1.5) continue;
      dmg += h.damagePerSecond;
    }
    return dmg;
  }

  clear(): void {
    this.smoke.clear();
    this.sparks.clear();
    this.blood.clear();
    this.tracers.clear();
    this.bulletHoles.clear();
    this.bloodDecals.clear();
    this.scorchDecals.clear();
    this.hazards.length = 0;
    for (const l of this.lightPool) {
      l.visible = false;
      l.intensity = 0;
    }
    this.fadeLights.length = 0;
  }

  dispose(): void {
    this.smoke.dispose();
    this.sparks.dispose();
    this.blood.dispose();
    this.tracers.dispose();
    this.bulletHoles.dispose();
    this.bloodDecals.dispose();
    this.scorchDecals.dispose();
  }

  /** Exposed for the HUD's perf overlay. */
  get particleCount(): number {
    return this.smoke.active + this.sparks.active + this.blood.active;
  }

  instanceInfo(): { smoke: number; sparks: number; blood: number; tracers: number } {
    return {
      smoke: this.smoke.used,
      sparks: this.sparks.used,
      blood: this.blood.used,
      tracers: 0,
    };
  }

  get texture(): VfxTextures {
    return this.tex;
  }

  get elapsed(): number {
    return this.time;
  }

  static tempVector(): THREE.Vector3 {
    return Effects._v;
  }

  static tempColor(): THREE.Color {
    return Effects._c;
  }
}

const IMPACT_LOOK: Record<string, { color: number; particles: number; sparks: boolean; decalChance: number }> = {
  concrete: { color: 0xb0aaa0, particles: 6, sparks: false, decalChance: 0.5 },
  metal: { color: 0xffd9a0, particles: 5, sparks: true, decalChance: 0.35 },
  wood: { color: 0x8a6038, particles: 5, sparks: false, decalChance: 0.45 },
  glass: { color: 0xcfe8f4, particles: 8, sparks: false, decalChance: 0.1 },
  flesh: { color: 0x7a1a14, particles: 7, sparks: false, decalChance: 0.3 },
  dirt: { color: 0x6b5a42, particles: 5, sparks: false, decalChance: 0.3 },
  water: { color: 0x9fc2d0, particles: 7, sparks: false, decalChance: 0 },
  foliage: { color: 0x4a6b34, particles: 4, sparks: false, decalChance: 0.1 },
};
