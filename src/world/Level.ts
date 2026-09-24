/**
 * LEVEL RUNTIME
 * =============
 * Owns everything between "a generated layout" and "a playable chapter":
 *  - converts batched geometry into a handful of scene meshes,
 *  - instantiates doors, breakables and props with physics + interaction,
 *  - manages the dynamic light budget (quality-scaled),
 *  - bakes the navigation grid,
 *  - runs trigger volumes (alarms, crescendos, safe room)
 *  - and exposes queries used by the Director and HUD (nearest objective, etc).
 */
import * as THREE from 'three';
import { bus } from '@/core/Events';
import { Rng, clamp01, damp } from '@/core/MathUtil';
import type { ChapterDef } from '@/config/campaign';
import type { CollisionWorld } from '@/physics/Collision';
import { CollisionScratch } from '@/physics/Collision';
import { NavGrid, NAV_FLAG } from '@/world/Nav';
import { LevelGenerator, pointOnPolyline, routeProgress } from '@/world/Generator';
import { noise } from '@/world/Noise';
import type { LevelLayout, BreakableDef, DoorDef } from '@/world/LevelTypes';
import type { MaterialLibrary, VfxTextures } from '@/render/Materials';
import type { QualitySettings } from '@/core/Settings';

interface DoorRuntime {
  def: DoorDef;
  group: THREE.Group;
  /** Collider ids owned by this door. */
  colliderIds: number[];
  open: boolean;
  /** 0 = closed, 1 = fully open. */
  amount: number;
  target: number;
  autoCloseTimer: number;
  health: number;
  broken: boolean;
}

interface BreakableRuntime {
  def: BreakableDef;
  mesh: THREE.Mesh | null;
  colliderId: number;
  health: number;
  broken: boolean;
}

interface LightRuntime {
  def: { x: number; y: number; z: number; color: number; intensity: number; distance: number; flicker: boolean; kind: string };
  light: THREE.PointLight | null;
  /** Deterministic flicker phase. */
  phase: number;
  /** Emissive billboard that stays alive even when the light is culled. */
  glow: number;
}

/** Shared scratch for the objective marker (called every frame by the HUD). */
const markerScratch = new THREE.Vector3();

export class Level {
  readonly group = new THREE.Group();
  readonly world: CollisionWorld;
  nav: NavGrid;
  layout!: LevelLayout;
  /** False until a chapter has been generated (guards quality/route helpers). */
  private loaded = false;
  private lastPlayerPos = new THREE.Vector3();
  chapter!: ChapterDef;

  private scratch = new CollisionScratch();
  private rand: Rng;
  private materials: MaterialLibrary;
  private vfxTex: VfxTextures;
  private quality: QualitySettings;

  private doors = new Map<number, DoorRuntime>();
  private breakables: BreakableRuntime[] = [];
  private lights: LightRuntime[] = [];
  private lightPool: THREE.PointLight[] = [];
  private triggerState = new Map<number, boolean>();
  private routePoints: THREE.Vector3[] = [];
  private routeSamplesCache: THREE.Vector3[] = [];
  private propMeshes: THREE.Mesh[] = [];
  private glowMesh: THREE.InstancedMesh | null = null;
  /** True once the level's static decals have been handed to the effects pool. */
  private glowData: { x: number; y: number; z: number; color: THREE.Color; size: number }[] = [];
  private decalHandled = false;
  /** Progress of the squad along the route (0..1) — the Director's pace input. */
  progress = 0;
  private time = 0;

  constructor(world: CollisionWorld, materials: MaterialLibrary, vfxTex: VfxTextures, quality: QualitySettings) {
    this.world = world;
    this.materials = materials;
    this.vfxTex = vfxTex;
    this.quality = quality;
    this.rand = new Rng(1);
    this.nav = new NavGrid(0, 0, 1, 1, 10, 1.0);
    this.group.name = 'level';
  }

  /** Generate, bake and instantiate a chapter. */
  load(chapter: ChapterDef, onProgress?: (t: number, label: string) => void): LevelLayout {
    this.chapter = chapter;
    this.clear();
    this.rand = new Rng(chapter.seed ^ 0x1234);

    const gen = new LevelGenerator(chapter, this.world);
    const layout = gen.generate(onProgress);
    this.layout = layout;

    // --- navigation bake ---------------------------------------------------
    onProgress?.(0.9, 'Baking navigation');
    const b = layout.bounds;
    this.nav = new NavGrid(b.minX, b.minZ, b.maxX, b.maxZ, Math.max(b.maxY, 12), 1.0);
    this.nav.bake(this.world, (t) => onProgress?.(0.9 + t * 0.08, 'Baking navigation'));
    this.routePoints = layout.route;
    this.routeSamplesCache.length = 0;
    this.markRoute();

    // --- scene meshes ------------------------------------------------------
    onProgress?.(0.98, 'Uploading geometry');
    for (const [matKey, geo] of layout.batches) {
      const material = this.materials.surface(matKey, 1);
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `level_${matKey}`;
      mesh.castShadow = this.quality.shadows && matKey !== 'foliage';
      mesh.receiveShadow = this.quality.shadows;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
    }

    this.buildDoors(layout.doors);
    this.buildBreakables(layout.breakables);
    this.buildLights(layout.lights);
    this.buildDecals();

    // Everything a live chapter needs now exists: `update()` (doors, hazards,
    // triggers), `applyQuality()` and `objectiveMarker()` all gate on this flag,
    // so forgetting it silently disables the objective compass and the door
    // animation rather than failing loudly.
    this.loaded = true;

    bus.emit('chapter:start', { chapterIndex: chapter.index, name: chapter.name });
    return layout;
  }

  /**
   * Re-flag the navigation grid along the route. `load()` calls this, and the
   * engine calls it again once its own nav instance is baked (the grid created
   * inside `load` is the one the level keeps, so this is mostly a safety net for
   * a chapter reload).
   */
  markRouteOnNav(): void {
    this.markRoute();
  }

  /** Performance/quality change: shadows and light budget follow the preset. */
  applyQuality(q: QualitySettings): void {
    this.quality = q;
    if (!this.loaded) return;
    for (const mesh of this.propMeshes) {
      mesh.castShadow = q.shadows;
      mesh.receiveShadow = q.shadows;
    }
    for (const [, door] of this.doors) {
      door.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.castShadow = q.shadows;
      });
    }
    this.updateLightBudget(this.lastPlayerPos);
  }

  /**
   * A scripted alarm: every infected within earshot turns toward the sound and
   * the Director gets a burst of credit. Used by car alarms and generator rooms.
   */
  triggerAlarm(x: number, z: number): void {
    const y = this.floorAt(x, z);
    noise.emit(new THREE.Vector3(x, y + 1, z), 120, 'alarm', 0);
    for (const light of this.lights) {
      if (Math.hypot(light.def.x - x, light.def.z - z) < 14) {
        light.def.color = 0xff5a3a;
        light.def.flicker = true;
      }
    }
    bus.emit('director:event', { kind: 'alarm', description: 'Alarm triggered — they heard that' });
  }

  private markRoute(): void {
    const pts = this.routePoints;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const steps = Math.ceil(a.distanceTo(b) / 4);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        // Mark a corridor either side of the route centre-line.
        for (let dx = -4; dx <= 4; dx++) {
          for (let dz = -4; dz <= 4; dz++) {
            this.nav.setCellFlag(x + dx * 2, z + dz * 2, NAV_FLAG.ON_ROUTE);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Doors
  // -------------------------------------------------------------------------

  private buildDoors(defs: DoorDef[]): void {
    const panelMat = this.materials.plain(0x6a7a86, { roughness: 0.6, metalness: 0.5 });
    const woodMat = this.materials.plain(0x6a4a2a, { roughness: 0.85, metalness: 0.05 });
    const safeMat = this.materials.plain(0x8a9aa4, { roughness: 0.35, metalness: 0.85 });

    for (const def of defs) {
      const group = new THREE.Group();
      // Hinge at the edge of the opening.
      const halfW = def.width * 0.5;
      group.position.set(def.x - Math.cos(def.yaw) * halfW, def.y, def.z + Math.sin(def.yaw) * halfW);
      group.rotation.y = def.yaw;
      const thickness = def.kind === 'safe' ? 0.14 : 0.08;
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(def.width, def.height, thickness),
        def.kind === 'safe' ? safeMat : def.kind === 'metal' ? panelMat : woodMat,
      );
      panel.position.set(halfW, def.height * 0.5, 0);
      panel.castShadow = true;
      panel.receiveShadow = true;
      group.add(panel);
      // Handle.
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.06), panelMat);
      handle.position.set(def.width - 0.22, 1.05, thickness * 0.5 + 0.03);
      group.add(handle);
      this.group.add(group);

      // The blocking collider (disabled while the door is open).
      const col = this.world.addBox(
        group.position.x + Math.cos(def.yaw) * halfW,
        def.y + def.height * 0.5,
        group.position.z - Math.sin(def.yaw) * halfW,
        halfW,
        def.height * 0.5,
        thickness * 0.5 + 0.02,
        def.kind === 'safe' ? 'metal' : 'wood',
        { doorId: def.id, yaw: def.yaw },
      );

      this.doors.set(def.id, {
        def,
        group,
        colliderIds: [col.id],
        open: false,
        amount: 0,
        target: 0,
        autoCloseTimer: 0,
        health: def.health,
        broken: false,
      });
    }
  }

  doorAt(id: number): DoorDef | null {
    const d = this.doors.get(id);
    return d ? d.def : null;
  }

  get doorList(): DoorDef[] {
    return [...this.doors.values()].map((d) => d.def);
  }

  /** Open/close a door. Returns false when locked or broken. */
  setDoorOpen(id: number, open: boolean, source = 'player'): boolean {
    const d = this.doors.get(id);
    if (!d || d.broken) return false;
    if (d.def.locked && open) {
      bus.emit('door:locked', { id, message: `${d.def.label} is locked` });
      return false;
    }
    d.target = open ? 1 : 0;
    d.open = open;
    if (open) {
      d.autoCloseTimer = d.def.autoClose;
      bus.emit('door:open', { id });
      void source;
    }
    return true;
  }

  /** Damage a door; breakable doors fall apart when destroyed. */
  damageDoor(id: number, amount: number): void {
    const d = this.doors.get(id);
    if (!d || d.broken || d.def.health <= 0) return;
    d.health -= amount;
    if (d.health <= 0) {
      d.broken = true;
      d.group.visible = false;
      for (const cid of d.colliderIds) {
        const box = this.world.boxes.find((bx) => bx.id === cid);
        if (box) box.enabled = false;
      }
      this.world.version++;
      bus.emit('breakable:broken', { position: [d.def.x, d.def.y + 1, d.def.z] });
    }
  }

  /** Unlock the safe-room door (called when the squad is ready to leave). */
  unlockDoor(id: number): void {
    const d = this.doors.get(id);
    if (d) {
      d.def.locked = false;
      bus.emit('door:locked', { id, message: `${d.def.label} unlocked` });
    }
  }

  /**
   * Nearest door within `radius` (used by the interaction prompt). Doors are
   * few, so a linear scan beats maintaining a spatial index for them.
   */
  nearestDoor(x: number, y: number, z: number, radius = 2.6): { id: number; open: boolean; locked: boolean; broken: boolean; distance: number } | null {
    let best: { id: number; open: boolean; locked: boolean; broken: boolean; distance: number } | null = null;
    for (const [id, door] of this.doors) {
      const d = Math.hypot(door.def.x - x, door.def.z - z) + Math.abs(door.def.y - y) * 0.25;
      if (d > radius) continue;
      if (!best || d < best.distance) {
        best = { id, open: door.open, locked: !!door.def.locked, broken: door.broken, distance: d };
      }
    }
    return best;
  }

  doorIsOpenAt(x: number, z: number): boolean {
    for (const d of this.doors.values()) {
      if (d.broken || d.target > 0.5) continue;
      if (Math.hypot(d.def.x - x, d.def.z - z) < 1.6) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Breakables
  // -------------------------------------------------------------------------

  private buildBreakables(defs: BreakableDef[]): void {
    // Only the closest N breakables get real meshes; the rest are baked into the
    // static batches already, so we just track their colliders for damage.
    const MAX_MESHES = this.quality.tier === 'low' ? 12 : 40;
    for (const def of defs) {
      let mesh: THREE.Mesh | null = null;
      if (this.propMeshes.length < MAX_MESHES) {
        const mat = this.materials.surface(def.material, 0.5, {
          transparent: def.kind === 'glass_pane',
          opacity: def.kind === 'glass_pane' ? 0.42 : 1,
        });
        const geo = new THREE.BoxGeometry(def.hx * 2, def.hy * 2, def.hz * 2);
        mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(def.x, def.y, def.z);
        mesh.rotation.y = def.yaw;
        mesh.castShadow = this.quality.shadows;
        mesh.receiveShadow = this.quality.shadows;
        this.group.add(mesh);
        this.propMeshes.push(mesh);
      }
      const col = this.world.addBox(def.x, def.y, def.z, def.hx, def.hy, def.hz, def.material === 'glass' ? 'glass' : 'wood', {
        solid: def.kind !== 'glass_pane',
        blocksBullets: true,
        yaw: def.yaw,
      });
      this.breakables.push({ def, mesh, colliderId: col.id, health: def.health, broken: false });
    }
  }

  /** Nearest breakable whose volume contains the point (used by bullets/melee). */
  breakableAt(x: number, y: number, z: number, radius = 0.4): BreakableRuntime | null {
    for (const b of this.breakables) {
      if (b.broken) continue;
      const d = b.def;
      if (Math.abs(y - d.y) > d.hy + radius) continue;
      const dx = x - d.x;
      const dz = z - d.z;
      const c = Math.cos(-d.yaw);
      const s = Math.sin(-d.yaw);
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (Math.abs(lx) <= d.hx + radius && Math.abs(lz) <= d.hz + radius) return b;
    }
    return null;
  }

  /** Damage any breakable overlapping a point; returns what was destroyed. */
  damageBreakable(b: BreakableRuntime, amount: number): { destroyed: boolean; explosive: boolean; position: THREE.Vector3 } {
    b.health -= amount;
    const pos = new THREE.Vector3(b.def.x, b.def.y, b.def.z);
    if (b.health > 0) return { destroyed: false, explosive: false, position: pos };
    b.broken = true;
    if (b.mesh) {
      this.group.remove(b.mesh);
      b.mesh.geometry.dispose();
      const idx = this.propMeshes.indexOf(b.mesh);
      if (idx >= 0) this.propMeshes.splice(idx, 1);
      b.mesh = null;
    }
    const box = this.world.boxes.find((bx) => bx.id === b.colliderId);
    if (box) box.enabled = false;
    this.world.version++;
    bus.emit('breakable:broken', { position: [pos.x, pos.y, pos.z] });
    return { destroyed: true, explosive: b.def.explosive, position: pos };
  }

  get breakableList(): BreakableRuntime[] {
    return this.breakables;
  }

  // -------------------------------------------------------------------------
  // Lights
  // -------------------------------------------------------------------------

  private buildLights(defs: LevelLayout['lights']): void {
    // Which lights get a real point light? Nearest to the route first, capped by
    // the quality tier. Everything still gets an emissive glow billboard.
    const budget = this.quality.maxDynamicLights;
    const scored = defs
      .map((def, i) => ({ def, i, score: this.routeDistanceTo(def.x, def.z) - (def.kind === 'safe' ? 40 : 0) }))
      .sort((a, b) => a.score - b.score);

    for (const { def } of scored) {
      this.lights.push({ def, light: null, phase: this.rand.range(0, 100), glow: this.glowData.length });
      // Lamps always emit a visible bulb.
      this.glowData.push({ x: def.x, y: def.y, z: def.z, color: new THREE.Color(def.color), size: def.kind === 'safe' ? 1.6 : 0.9 });
    }

    let used = 0;
    for (const entry of this.lights) {
      if (used >= budget) break;
      const def = entry.def;
      // Skip low-value lights once we are near the budget.
      if (used >= budget - 1 && def.kind === 'interior' && def.intensity < 0.6) continue;
      const light = new THREE.PointLight(def.color, def.intensity, def.distance, 1.6);
      light.position.set(def.x, def.y, def.z);
      light.castShadow = false;
      this.group.add(light);
      entry.light = light;
      this.lightPool.push(light);
      used++;
    }

    this.buildGlowMesh();
  }

  private buildGlowMesh(): void {
    if (this.glowData.length === 0) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: this.vfxTex.flash,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      color: 0xffffff,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    const inst = new THREE.InstancedMesh(geo, mat, this.glowData.length);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.glowData.length; i++) {
      const g = this.glowData[i];
      m.makeScale(g.size, g.size, 1);
      m.setPosition(g.x, g.y, g.z);
      inst.setMatrixAt(i, m);
      inst.setColorAt(i, g.color);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.frustumCulled = false;
    this.glowMesh = inst;
    this.group.add(inst);
  }

  /** Re-assign the dynamic light pool to the lights nearest the player. */
  private updateLightBudget(playerPos: THREE.Vector3): void {
    if (this.lightPool.length === 0 || this.lights.length === 0) return;
    // Every 0.5 s, find the N nearest light definitions and move the pool there.
    const sorted = this.lights
      .map((l) => {
        const dx = l.def.x - playerPos.x;
        const dy = l.def.y - playerPos.y;
        const dz = l.def.z - playerPos.z;
        return { l, d: dx * dx + dy * dy + dz * dz };
      })
      .sort((a, b) => a.d - b.d);
    const n = Math.min(this.lightPool.length, sorted.length);
    for (let i = 0; i < this.lightPool.length; i++) {
      const light = this.lightPool[i];
      if (i < n) {
        const def = sorted[i].l.def;
        if (light.parent !== this.group) this.group.add(light);
        light.visible = true;
        light.position.set(def.x, def.y, def.z);
        light.color.setHex(def.color);
        light.intensity = def.intensity;
        light.distance = def.distance;
        sorted[i].l.light = light;
      } else {
        light.visible = false;
      }
    }
  }

  private routeDistanceTo(x: number, z: number): number {
    let best = Infinity;
    const pts = this.routePoints;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (d < best) best = d;
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Decals
  // -------------------------------------------------------------------------

  private buildDecals(): void {
    if (this.decalHandled) return;
    const defs = this.layout.decals.slice(0, this.quality.maxDecals);
    if (defs.length === 0) return;
    const build = (kind: 'blood' | 'scorch' | 'bile', tex: THREE.Texture): THREE.InstancedMesh | null => {
      const list = defs.filter((d) => d.kind === kind);
      if (list.length === 0) return null;
      const geo = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        toneMapped: true,
        opacity: kind === 'blood' ? 0.9 : 0.6,
      });
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        p.set(d.x, d.y, d.z);
        // Lay the quad flat on the surface, oriented by its normal.
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(d.nx, d.ny, d.nz).normalize());
        s.set(d.size, d.size, 1);
        m.compose(p, q, s);
        inst.setMatrixAt(i, m);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      inst.renderOrder = 1;
      this.group.add(inst);
      return inst;
    };
    build('blood', this.vfxTex.bloodDecal);
    build('scorch', this.vfxTex.scorch);
    build('bile', this.vfxTex.bileSplat);
    this.decalHandled = true;
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  update(dt: number, playerPos: THREE.Vector3, playerAlive: boolean): void {
    this.time += dt;
    // Doors.
    for (const d of this.doors.values()) {
      if (d.broken) continue;
      if (d.autoCloseTimer > 0) {
        d.autoCloseTimer -= dt;
        if (d.autoCloseTimer <= 0) {
          d.target = 0;
          d.open = false;
        }
      }
      if (Math.abs(d.amount - d.target) > 0.001) {
        d.amount = damp(d.amount, d.target, 9, dt);
        d.group.rotation.y = d.def.yaw + d.amount * 1.55;
        // Collision follows the visual state coarsely (open = walk-through).
        for (const cid of d.colliderIds) {
          const box = this.world.boxes.find((bx) => bx.id === cid);
          if (!box) continue;
          const shouldBlock = d.amount < 0.35;
          if (box.enabled !== shouldBlock) {
            box.enabled = shouldBlock;
            this.world.version++;
          }
        }
      }
    }

    // Light flicker + budget.
    for (const l of this.lights) {
      if (!l.light || !l.light.visible) continue;
      if (l.def.flicker) {
        const n = Math.sin(this.time * 11 + l.phase) * Math.sin(this.time * 3.3 + l.phase * 2.1);
        l.light.intensity = l.def.intensity * (0.55 + 0.45 * (n > -0.3 ? 1 : 0.15));
      } else {
        l.light.intensity = l.def.intensity;
      }
    }
    this.lightBudgetTimer -= dt;
    if (this.lightBudgetTimer <= 0) {
      this.lightBudgetTimer = 0.45;
      this.updateLightBudget(playerPos);
    }

    // Route progress (used by the Director).
    const prev = this.progress;
    this.progress = routeProgress(this.routePoints, playerPos.x, playerPos.z);
    if (this.progress - prev > 0.02) {
      // Progress is monotonic; sudden jumps mean the player found a shortcut.
    }
    void playerAlive;
  }

  private lightBudgetTimer = 0;

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Point at normalised progress along the chapter route. */
  /** Route polyline, coarsely sampled (minimap, debug overlays). */
  get routeSamples(): THREE.Vector3[] {
    if (this.routeSamplesCache.length) return this.routeSamplesCache;
    const pts = this.routePoints;
    // ~2.5 m spacing: enough for a smooth minimap line, few enough to draw.
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = this.routeSamplesCache[this.routeSamplesCache.length - 1];
      if (!prev || Math.hypot(p.x - prev.x, p.z - prev.z) > 2.5 || i === pts.length - 1) {
        this.routeSamplesCache.push(p);
      }
    }
    return this.routeSamplesCache;
  }

  routePoint(t: number): THREE.Vector3 {
    return pointOnPolyline(this.routePoints, t);
  }

  /** Closest route point to a world position (for waypoint markers + spawns). */
  nearestRoutePoint(x: number, z: number): THREE.Vector3 {
    let best = this.routePoints[0] ?? new THREE.Vector3();
    let bestD = Infinity;
    const pts = this.routePoints;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestD) {
        bestD = d;
        best = new THREE.Vector3(px, 0, pz);
      }
    }
    return best;
  }

  /** Ground height under a point (for spawning and navigation queries). */
  floorAt(x: number, z: number, fromY = 40): number {
    return this.world.groundAt(x, z, fromY, 0.7, this.scratch.indices);
  }

  /** Trigger volumes: returns newly armed triggers this frame. */
  checkTriggers(playerPos: THREE.Vector3): LevelLayout['triggers'] {
    const out: LevelLayout['triggers'] = [];
    for (const t of this.layout.triggers) {
      if (this.triggerState.get(t.id)) continue;
      const dx = t.x - playerPos.x;
      const dz = t.z - playerPos.z;
      if (dx * dx + dz * dz > t.radius * t.radius) continue;
      this.triggerState.set(t.id, true);
      out.push(t);
      if (t.kind === 'crescendo') bus.emit('trigger:crescendo', { name: t.name });
    }
    return out;
  }

  /** Objective marker position and label for the HUD compass. */
  /**
   * Where the squad should be heading right now: the next *marked* script event
   * if one is still ahead of them (the alarm car, the bridge, the finale), and
   * otherwise the safe room. The HUD and the minimap draw it, the teammates
   * steer by it, and the debug instrumentation measures progress against it.
   */
  objectiveMarker(): { position: THREE.Vector3; label: string; distance: number } | null {
    if (!this.loaded) return null;
    let best: { x: number; y: number; z: number; label: string } | null = null;
    let bestDist = Infinity;
    for (const t of this.layout.triggers) {
      if (!t.marker) continue;
      if (this.triggerState.get(t.id)) continue;
      const d = Math.hypot(t.x - this.lastPlayerPos.x, t.z - this.lastPlayerPos.z);
      if (d < bestDist) {
        bestDist = d;
        best = { x: t.x, y: t.y, z: t.z, label: t.name };
      }
    }
    if (!best) {
      const sr = this.layout.safeRoom;
      best = { x: sr.gatherX, y: sr.gatherY, z: sr.gatherZ, label: sr.label };
      bestDist = Math.hypot(sr.gatherX - this.lastPlayerPos.x, sr.gatherZ - this.lastPlayerPos.z);
    }
    return {
      position: markerScratch.set(best.x, best.y, best.z),
      label: best.label,
      distance: bestDist,
    };
  }

  /** How much of the level has been cleared (0..1) — feeds pacing analytics. */
  get completion(): number {
    return clamp01(this.progress);
  }

  private clear(): void {
    // The glow billboards are instanced per light set; drop the old batch with
    // the rest of the level so a chapter change cannot leak a stale instance.
    if (this.glowMesh) {
      this.glowMesh.geometry.dispose();
      (this.glowMesh.material as THREE.Material).dispose();
      this.glowMesh = null;
    }
    this.group.clear();
    this.doors.clear();
    this.breakables.length = 0;
    this.lights.length = 0;
    this.lightPool.length = 0;
    this.triggerState.clear();
    this.propMeshes.length = 0;
    this.glowData.length = 0;
    this.glowMesh = null;
    this.progress = 0;
    this.decalHandled = false;
    this.loaded = false;
    // Note: geometry/materials are owned by the MaterialLibrary and the layout,
    // so disposing them here would break a restart. The Engine calls
    // `disposeLayout()` when a chapter is fully replaced.
  }

  /** Release GPU memory for a layout that will never be used again. */
  disposeLayout(): void {
    if (!this.layout) return;
    for (const geo of this.layout.batches.values()) geo.dispose();
    this.layout.batches.clear();
  }
}
