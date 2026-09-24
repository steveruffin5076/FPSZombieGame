/**
 * GEOMETRY BATCHER
 * ================
 * The level is assembled from thousands of boxes. Merging them into one buffer
 * per material keeps the frame cheap: a whole city block is a single draw call.
 *
 * Key details
 * -----------
 *  - **World-projected UVs.** Each face derives its UVs from its own dominant
 *    axes scaled by `uvScale`, so a 40 m wall and a 0.4 m crate have the same
 *    texel density. This is what makes a merged mesh look authored instead of
 *    stretched.
 *  - **Baked contact ambient occlusion.** A coarse voxel grid records which
 *    cells are solid; each vertex samples its neighbourhood and darkens where
 *    geometry is surrounded. Combined with a height-based grime gradient, this
 *    gives interiors corner shadows without any extra rendering passes.
 *  - **Vertex colour tinting.** Per-instance colour variation (concrete slabs
 *    are not all the same grey) is carried in the colour attribute, so one
 *    material can render a whole district.
 */
import * as THREE from 'three';

export interface BatcherOptions {
  /** Colour multiply (0xffffff = no change). */
  color?: number;
  /** Texture tiles per metre for the world-projected UVs. */
  uvScale?: number;
  /** Per-face colour multipliers, order: +X, -X, +Y, -Y, +Z, -Z. */
  faceTint?: [number, number, number, number, number, number];
  /** Skip specific faces (e.g. the bottom of a floor slab). */
  skipFaces?: boolean[];
  /** Yaw in degrees. */
  yaw?: number;
  /** Disable AO baking (faster for tiny props). */
  ao?: boolean;
  /** Legacy alias for `ao` (the batcher bakes AO globally now). */
  bakeAo?: boolean;
  /** Darken the top face (grime on roofs/floors). */
  grime?: number;
}

const FACES: { normal: [number, number, number]; verts: [number, number, number][]; axes: [number, number] }[] = [
  // +X
  { normal: [1, 0, 0], verts: [[1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]], axes: [2, 1] },
  // -X
  { normal: [-1, 0, 0], verts: [[-1, -1, 1], [-1, -1, -1], [-1, 1, -1], [-1, 1, 1]], axes: [2, 1] },
  // +Y
  { normal: [0, 1, 0], verts: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]], axes: [0, 2] },
  // -Y
  { normal: [0, -1, 0], verts: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]], axes: [0, 2] },
  // +Z
  { normal: [0, 0, 1], verts: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], axes: [0, 1] },
  // -Z
  { normal: [0, 0, -1], verts: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], axes: [0, 1] },
];

/** Accumulates box/quads and produces a single merged BufferGeometry. */
export class GeometryBatcher {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private colors: number[] = [];
  private indices: number[] = [];
  private vertexCount = 0;
  /** Coarse voxel grid for contact AO. */
  private voxelSize = 1.2;
  private vminX = 0;
  private vminY = 0;
  private vminZ = 0;
  private vw = 0;
  private vh = 0;
  private vd = 0;
  private voxels: Uint8Array | null = null;
  private colorScratch = new THREE.Color();

  constructor(opts: { voxelSize?: number } = {}) {
    if (opts.voxelSize) this.voxelSize = opts.voxelSize;
  }

  get triangles(): number {
    return this.indices.length / 3;
  }

  get triangleEstimate(): number {
    return this.indices.length / 3;
  }

  get isEmpty(): boolean {
    return this.vertexCount === 0;
  }

  /**
   * Rasterise the whole set of boxes into the AO voxel grid. Call this once
   * after every box has been added *and* before `build()`.
   */
  bakeAO(bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }, boxes: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw?: number; blocksMovement?: boolean }[]): void {
    this.vminX = bounds.minX - 2;
    this.vminY = bounds.minY - 2;
    this.vminZ = bounds.minZ - 2;
    this.vw = Math.ceil((bounds.maxX - bounds.minX + 4) / this.voxelSize);
    this.vh = Math.ceil((bounds.maxY - bounds.minY + 4) / this.voxelSize);
    this.vd = Math.ceil((bounds.maxZ - bounds.minZ + 4) / this.voxelSize);
    const total = this.vw * this.vh * this.vd;
    // Guard against absurd allocations from a bad bounds report.
    if (total > 12_000_000) {
      this.voxels = null;
      return;
    }
    const grid = new Uint8Array(total);
    for (const b of boxes) {
      if (b.blocksMovement === false) continue;
      // Approximate rotated boxes with their bounding box (AO only).
      const ext = b.yaw ? Math.max(b.hx, b.hz) * 1.42 : 0;
      const x0 = this.voxelIndexX(b.x - b.hx - ext);
      const x1 = this.voxelIndexX(b.x + b.hx + ext);
      const y0 = this.voxelIndexY(b.y - b.hy);
      const y1 = this.voxelIndexY(b.y + b.hy);
      const z0 = this.voxelIndexZ(b.z - b.hz - ext);
      const z1 = this.voxelIndexZ(b.z + b.hz + ext);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            grid[(y * this.vd + z) * this.vw + x] = 1;
          }
        }
      }
    }
    this.voxels = grid;
  }

  private voxelIndexX(x: number): number {
    return Math.max(0, Math.min(this.vw - 1, Math.floor((x - this.vminX) / this.voxelSize)));
  }
  private voxelIndexY(y: number): number {
    return Math.max(0, Math.min(this.vh - 1, Math.floor((y - this.vminY) / this.voxelSize)));
  }
  private voxelIndexZ(z: number): number {
    return Math.max(0, Math.min(this.vd - 1, Math.floor((z - this.vminZ) / this.voxelSize)));
  }

  /** How enclosed is this point? 0 = open sky, 1 = deeply inside geometry. */
  private occlusion(x: number, y: number, z: number, radius = 2): number {
    if (!this.voxels) return 0;
    const vx = this.voxelIndexX(x);
    const vy = this.voxelIndexY(y);
    const vz = this.voxelIndexZ(z);
    let solid = 0;
    let total = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const sx = vx + dx;
          const sy = vy + dy;
          const sz = vz + dz;
          total++;
          if (sx < 0 || sy < 0 || sz < 0 || sx >= this.vw || sy >= this.vh || sz >= this.vd) continue;
          if (this.voxels[(sy * this.vd + sz) * this.vw + sx]) {
            // Nearer cells occlude more.
            solid += 1 / (1 + Math.abs(dx) + Math.abs(dy) + Math.abs(dz));
          }
        }
      }
    }
    return Math.min(1, solid / Math.max(1, total * 0.09));
  }

  /**
   * Add an axis-aligned (or yaw-rotated) box.
   * `hx/hy/hz` are half extents; the box is centred on (cx,cy,cz).
   */
  addBox(
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    optsOrWorld?: BatcherOptions | { boxes?: unknown },
    maybeOpts?: BatcherOptions,
  ): void {
    // The generator passes the collision world as the 7th argument (it was once
    // used to query neighbouring geometry for AO). AO is now voxel-baked in a
    // single pass, so the world argument is accepted and ignored.
    const opts: BatcherOptions =
      maybeOpts ?? (optsOrWorld && typeof (optsOrWorld as BatcherOptions).color === 'object' ? {} : (optsOrWorld as BatcherOptions) ?? {});
    const yaw = ((opts.yaw ?? 0) * Math.PI) / 180;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const uvScale = opts.uvScale ?? 0.25; // tiles per metre
    const base = this.colorScratch.setHex(opts.color ?? 0xffffff);
    const faceTint = opts.faceTint;
    const skip = opts.skipFaces;

    for (let f = 0; f < 6; f++) {
      if (skip && skip[f]) continue;
      const face = FACES[f];
      const tint = faceTint ? faceTint[f] : 1;
      // Face normal in world space.
      const nx = face.normal[0] * cos - face.normal[2] * sin;
      const nz = face.normal[0] * sin + face.normal[2] * cos;
      const ny = face.normal[1];
      const uAxis = face.axes[0];
      const vAxis = face.axes[1];
      const startIndex = this.vertexCount;
      for (let v = 0; v < 4; v++) {
        const [ox, oy, oz] = face.verts[v];
        const lx = ox * hx;
        const ly = oy * hy;
        const lz = oz * hz;
        const wx = cx + lx * cos - lz * sin;
        const wy = cy + ly;
        const wz = cz + lx * sin + lz * cos;
        this.positions.push(wx, wy, wz);
        this.normals.push(nx, ny, nz);
        // World-projected UVs from the face's dominant axes.
        const extents: [number, number, number] = [hx, hy, hz];
        const u = (v === 0 || v === 3 ? -1 : 1) * extents[uAxis];
        const vv = (v < 2 ? -1 : 1) * extents[vAxis];
        this.uvs.push(u * uvScale, vv * uvScale);
        // Contact AO + height grime in the vertex colour.
        let ao = 1;
        if (opts.ao !== false) {
          // Sample slightly outside the surface so the face itself is not counted.
          const ox2 = wx + nx * 0.12;
          const oy2 = wy + ny * 0.12;
          const oz2 = wz + nz * 0.12;
          ao = 1 - this.occlusion(ox2, oy2, oz2) * 0.72;
        }
        // Ground-level grime and top-of-surface soot.
        const grime = opts.grime ?? 0;
        if (ny > 0.5) ao *= 1 - grime * 0.35;
        if (ny < -0.5) ao *= 0.72;
        this.colorScratch.copy(base).multiplyScalar(ao * tint);
        // Vertex colours are authored in linear space (three.js will not convert).
        this.colors.push(this.colorScratch.r, this.colorScratch.g, this.colorScratch.b);
      }
      this.indices.push(startIndex, startIndex + 1, startIndex + 2, startIndex, startIndex + 2, startIndex + 3);
      this.vertexCount += 4;
    }
  }

  /**
   * Add a quad. Accepts either four `Vector3`s or twelve numbers
   * (x0,y0,z0, x1,y1,z1, ...) — the numeric form is how the level generator
   * emits road ribbons and lane markings, where allocating vectors per quad
   * would dominate the build time.
   */
  addQuad(
    a: THREE.Vector3 | number,
    b: THREE.Vector3 | number,
    c: THREE.Vector3 | number,
    d: THREE.Vector3 | number,
    color: number,
    uvScale = 0.25,
    doubleSided: boolean | number = false,
    ay?: number,
    az?: number,
    bx?: number,
    by?: number,
    bz?: number,
    cx?: number,
    cy?: number,
    cz?: number,
    dx?: number,
    dy?: number,
    dz?: number,
  ): void {
    const numeric = typeof a === 'number';
    const p0: THREE.Vector3 = numeric ? QUAD_A.set(a as number, b as number, c as number) : (a as THREE.Vector3);
    const p1: THREE.Vector3 = numeric ? QUAD_B.set(d as number, ay!, az!) : (b as THREE.Vector3);
    const p2: THREE.Vector3 = numeric ? QUAD_C.set(bx!, by!, bz!) : (c as THREE.Vector3);
    const p3: THREE.Vector3 = numeric ? QUAD_D.set(cx!, cy!, cz!) : (d as THREE.Vector3);
    this.addQuadVectors(p0, p1, p2, p3, color, uvScale, doubleSided === true || doubleSided === 1);
    void dx;
    void dy;
    void dz;
  }

  /** Add a quad from four world-space points (counter-clockwise). */
  addQuadVectors(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    color: number,
    uvScale = 0.25,
    doubleSided = false,
  ): void {
    const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const len = Math.hypot(nx, ny, nz) || 1;
    const startIndex = this.vertexCount;
    const c0 = this.colorScratch.setHex(color);
    const r = c0.r;
    const g = c0.g;
    const bl = c0.b;
    const pts = [a, b, c, d];
    const uvs: [number, number][] = [
      [0, 0],
      [a.distanceTo(b) * uvScale, 0],
      [a.distanceTo(b) * uvScale, b.distanceTo(c) * uvScale],
      [0, b.distanceTo(c) * uvScale],
    ];
    for (let i = 0; i < 4; i++) {
      const p = pts[i];
      this.positions.push(p.x, p.y, p.z);
      this.normals.push(nx / len, ny / len, nz / len);
      this.uvs.push(uvs[i][0], uvs[i][1]);
      this.colors.push(r, g, bl);
    }
    this.indices.push(startIndex, startIndex + 1, startIndex + 2, startIndex, startIndex + 2, startIndex + 3);
    if (doubleSided) {
      this.indices.push(startIndex, startIndex + 2, startIndex + 1, startIndex, startIndex + 3, startIndex + 2);
    }
    this.vertexCount += 4;
  }

  /** Vertical cylinder (true axis-aligned, so props can share one batch). */
  addCylinderY(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    height: number,
    segments = 8,
    color = 0xffffff,
    uvScale = 0.25,
  ): void {
    const base = this.colorScratch.setHex(color);
    const r = base.r;
    const g = base.g;
    const b = base.b;
    const halfH = height * 0.5;
    const start = this.vertexCount;
    // Side wall.
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      const px = cx + nx * radius;
      const pz = cz + nz * radius;
      const u = (i / segments) * Math.PI * 2 * radius * uvScale;
      const vBot = height * uvScale;
      this.positions.push(px, cy - halfH, pz);
      this.normals.push(nx, 0, nz);
      this.uvs.push(u, vBot);
      this.colors.push(r, g, b);
      this.positions.push(px, cy + halfH, pz);
      this.normals.push(nx, 0, nz);
      this.uvs.push(u, 0);
      this.colors.push(r * 1.06, g * 1.06, b * 1.06);
      this.vertexCount += 2;
    }
    for (let i = 0; i < segments; i++) {
      const i0 = start + i * 2;
      this.indices.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2);
    }
    // Cap.
    const capCenter = this.vertexCount;
    this.positions.push(cx, cy + halfH, cz);
    this.normals.push(0, 1, 0);
    this.uvs.push(cx * uvScale, cz * uvScale);
    this.colors.push(r * 1.08, g * 1.08, b * 1.08);
    this.vertexCount++;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      this.positions.push(cx + nx * radius, cy + halfH, cz + nz * radius);
      this.normals.push(0, 1, 0);
      this.uvs.push(cx * uvScale + nx * radius * uvScale, cz * uvScale + nz * radius * uvScale);
      this.colors.push(r * 1.08, g * 1.08, b * 1.08);
      this.vertexCount++;
    }
    for (let i = 0; i < segments; i++) {
      this.indices.push(capCenter, capCenter + 1 + i, capCenter + 2 + i);
    }
  }

  /** Low-poly sphere (tree canopies, debris, lamps). */
  addSphere(cx: number, cy: number, cz: number, radius: number, segU = 8, segV = 6, color = 0xffffff): void {
    const base = this.colorScratch.setHex(color);
    const start = this.vertexCount;
    for (let v = 0; v <= segV; v++) {
      const phi = (v / segV) * Math.PI;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      // Slight vertical squash reads as a canopy rather than a ball.
      for (let u = 0; u <= segU; u++) {
        const theta = (u / segU) * Math.PI * 2;
        const nx = sp * Math.cos(theta);
        const ny = cp;
        const nz = sp * Math.sin(theta);
        // Hemisphere AO: undersides are darker.
        const shade = 0.72 + 0.28 * Math.max(0, ny);
        this.positions.push(cx + nx * radius, cy + ny * radius * 0.85, cz + nz * radius);
        this.normals.push(nx, ny, nz);
        this.uvs.push(u / segU, v / segV);
        this.colors.push(base.r * shade, base.g * shade, base.b * shade);
        this.vertexCount++;
      }
    }
    for (let v = 0; v < segV; v++) {
      for (let u = 0; u < segU; u++) {
        const a = start + v * (segU + 1) + u;
        const b = a + segU + 1;
        this.indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  /** Convenience for floors/ceilings described by a rect. */
  addSlab(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y: number,
    thickness = 0.25,
    color = 0xffffff,
    uvScale = 0.25,
    noBottom = true,
  ): void {
    this.addBox((x0 + x1) / 2, y - thickness / 2, (z0 + z1) / 2, Math.abs(x1 - x0) / 2, thickness / 2, Math.abs(z1 - z0) / 2, {
      color,
      uvScale,
      skipFaces: noBottom ? [false, false, false, true, false, false] : undefined,
      ao: false,
    });
  }

  /** Build a merged geometry. Returns null when nothing was added. */
  build(name?: string): THREE.BufferGeometry | null {
    if (this.vertexCount === 0) return null;
    const geo = new THREE.BufferGeometry();
    if (name) geo.name = name;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geo.setIndex(this.indices);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }

  /** Free the CPU-side arrays after the geometry has been uploaded. */
  reset(): void {
    this.positions.length = 0;
    this.normals.length = 0;
    this.uvs.length = 0;
    this.colors.length = 0;
    this.indices.length = 0;
    this.vertexCount = 0;
    this.voxels = null;
  }

  get stats(): { vertices: number; triangles: number; hasAO: boolean } {
    return { vertices: this.vertexCount, triangles: this.indices.length / 3, hasAO: this.voxels !== null };
  }
}

/**
 * Per-instance colour jitter, so repeated props do not look cloned.
 * Accepts either an `Rng`-like object or a plain `() => number` source.
 */
export function jitterColor(base: number, rng: { next(): number } | (() => number), amount = 0.08): number {
  const next = typeof rng === 'function' ? rng : () => rng.next();
  const c = new THREE.Color(base);
  const f = 1 + (next() * 2 - 1) * amount;
  const h = { h: 0, s: 0, l: 0 };
  c.getHSL(h);
  c.setHSL(h.h, Math.min(1, h.s * (1 + (next() * 2 - 1) * amount * 0.4)), Math.min(1, h.l * f));
  return c.getHex();
}

/** Scratch vectors for the numeric quad overload. */
const QUAD_A = new THREE.Vector3();
const QUAD_B = new THREE.Vector3();
const QUAD_C = new THREE.Vector3();
const QUAD_D = new THREE.Vector3();
