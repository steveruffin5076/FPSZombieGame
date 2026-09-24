/**
 * WEAPON SYSTEM (player)
 * ======================
 * State machine for the first-person arsenal: inventory, firing, reloading,
 * aiming, melee, throwables, healing, plus the procedural view model and its
 * animation.
 *
 * Two design decisions worth calling out:
 *
 *  1. **Procedural view models.** Weapons are kitbashed from boxes/cylinders at
 *     runtime, tinted per weapon spec, with animated sub-parts (bolt, magazine,
 *     pump, slide). No model files, no licensing, and adding a weapon is data.
 *  2. **Shared ballistics.** Firing calls into `weapons/Ballistics`, the same
 *     function AI teammates and infected use, so friendly fire, falloff and
 *     hit zones can never diverge between systems.
 */
import * as THREE from 'three';
import { bus } from '@/core/Events';
import { Rng, clamp, clamp01, damp, lerp } from '@/core/MathUtil';
import type { Damageable, DamageOptions, RayHit } from '@/core/Types';
import type { CollisionWorld } from '@/physics/Collision';
import { CollisionScratch } from '@/physics/Collision';
import type { MaterialLibrary } from '@/render/Materials';
import type { GameSettings } from '@/core/Settings';
import { difficultyDef } from '@/core/Settings';
import type { Level } from '@/world/Level';
import { HEAL_ITEMS, weaponDef, type HealItemDef, type WeaponDef } from '@/config/weapons';
import { castBullet, coneQuery, effectiveSpread, applySpread, type BulletConfig, type EntityIndex } from '@/weapons/Ballistics';
import type { Effects } from '@/vfx/Effects';
import type { AudioSystem } from '@/audio/Audio';

/** Everything the weapon system needs from its owner (structurally the Player). */
export interface WeaponHost {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly centre: THREE.Vector3;
  readonly camera: THREE.PerspectiveCamera;
  readonly alive: boolean;
  readonly grounded: boolean;
  readonly crouching: boolean;
  readonly id: number;
  isZombie: false;
  isSurvivor: true;
  applyRecoil(pitch: number, yaw: number): void;
  addShake(amount: number): void;
  aimOrigin(out: THREE.Vector3): THREE.Vector3;
  aimDirection(out: THREE.Vector3): THREE.Vector3;
  takeDamage(amount: number, opts: DamageOptions): void;
}

export interface WeaponInventoryItem {
  def: WeaponDef;
  ammo: number;
  reserve: number;
  /** Throwables/melee use `count` instead of ammo. */
  count: number;
}

export interface HealInventory {
  medkit: number;
  pills: number;
  adrenaline: number;
}

export type WeaponSlotName = 'primary' | 'secondary' | 'melee' | 'throwable';

interface ModelParts {
  group: THREE.Group;
  muzzle: THREE.Object3D;
  mag: THREE.Object3D | null;
  bolt: THREE.Object3D | null;
  pump: THREE.Object3D | null;
  slide: THREE.Object3D | null;
  flashSprite: THREE.Mesh;
  flashLight: THREE.PointLight;
  hands: THREE.Group;
}

/** Procedural first-person weapon model, built from the weapon's `model` spec. */
export function buildWeaponModel(def: WeaponDef, lib: MaterialLibrary): ModelParts {
  const spec = def.model;
  const group = new THREE.Group();
  group.name = `vm_${def.id}`;
  const metal = lib.plain(spec.metalTint, { roughness: 0.42, metalness: 0.82, vertexColors: false });
  const body = lib.plain(spec.bodyTint, { roughness: 0.72, metalness: 0.12, vertexColors: false });
  const dark = lib.plain(0x15171a, { roughness: 0.85, metalness: 0.2, vertexColors: false });
  const skin = lib.plain(0xb07a56, { roughness: 0.78, metalness: 0, vertexColors: false });
  const glove = lib.plain(0x2a2d30, { roughness: 0.85, metalness: 0.05, vertexColors: false });
  const glass = lib.plain(0x8fd0e8, { roughness: 0.1, metalness: 0.5, vertexColors: false, transparent: true, opacity: 0.35 });
  const emissive = lib.plain(0xffd070, { emissive: 0xffa030, emissiveIntensity: 1.4, toneMapped: false, vertexColors: false });

  const addBox = (
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number,
    parent: THREE.Object3D = group,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const addCyl = (
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    parent: THREE.Object3D = group,
    axis: 'x' | 'y' | 'z' = 'z',
    segments = 10,
  ): THREE.Mesh => {
    const geo = new THREE.CylinderGeometry(radius, radius, length, segments, 1, false);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (axis === 'z') m.rotation.x = Math.PI * 0.5;
    else if (axis === 'x') m.rotation.z = Math.PI * 0.5;
    parent.add(m);
    return m;
  };

  const L = spec.length;
  const scale = spec.scale;
  group.scale.setScalar(scale);

  // The model is authored looking down -Z (three.js forward).
  switch (spec.style) {
    case 'rifle':
    case 'sniper':
    case 'smg': {
      const isSmg = spec.style === 'smg';
      const bodyLen = isSmg ? L * 0.5 : L * 0.62;
      // Receiver.
      addBox(body, 0, 0, -bodyLen * 0.5, 0.032, 0.045, bodyLen * 0.5);
      // Upper rail + barrel.
      addBox(metal, 0, 0.042, -bodyLen * 0.55, 0.022, 0.012, bodyLen * 0.55);
      addCyl(metal, 0, 0.028, -L - 0.02, spec.barrelRadius, 0.2, group, 'z');
      addCyl(metal, 0, 0.028, -L + 0.06, spec.barrelRadius * 1.35, 0.09, group, 'z');
      // Handguard.
      addBox(body, 0, 0.012, -bodyLen * 0.95, 0.03, 0.028, 0.09);
      // Pistol grip.
      addBox(dark, 0.004, -0.075, 0.012, 0.021, 0.058, 0.028);
      // Magazine.
      const magY = -0.075 - (spec.magazineSize > 0 ? 0.045 : 0);
      const mag = addBox(dark, 0, magY, -bodyLen * 0.22, 0.022, spec.magazineSize * 0.5 + 0.03, 0.038);
      // Trigger guard.
      addBox(dark, 0, -0.052, -0.02, 0.014, 0.006, 0.03);
      // Stock.
      if (spec.stock) {
        addBox(body, 0, -0.005, 0.075, 0.024, 0.032, 0.075);
        addBox(dark, 0, 0.012, 0.128, 0.02, 0.03, 0.028);
      }
      if (spec.scope) {
        addCyl(metal, 0, 0.078, -0.06, 0.026, 0.26, group, 'z');
        addCyl(glass, 0, 0.078, 0.07, 0.024, 0.012, group, 'z');
        addBox(metal, 0, 0.062, -0.1, 0.008, 0.012, 0.02);
      } else {
        // Iron sights.
        addBox(metal, 0, 0.062, -L * 0.6, 0.006, 0.012, 0.004);
        addBox(metal, 0, 0.06, 0.03, 0.012, 0.01, 0.004);
      }
      // Charging handle / bolt.
      const bolt = addBox(metal, 0.034, 0.03, -bodyLen * 0.35, 0.012, 0.008, 0.03);
      // Sling.
      addBox(dark, 0, -0.03, 0.06, 0.006, 0.004, 0.07);
      // Hands.
      const hands = new THREE.Group();
      const rHand = addBox(glove, 0.004, -0.1, -0.01, 0.026, 0.042, 0.033, hands);
      void rHand;
      addBox(skin, 0.03, -0.145, 0.04, 0.03, 0.045, 0.04, hands);
      const lHand = addBox(glove, 0, -0.045, -bodyLen * 0.92, 0.028, 0.035, 0.045, hands);
      void lHand;
      addBox(skin, -0.02, -0.09, -bodyLen * 0.78, 0.032, 0.04, 0.05, hands);
      group.add(hands);
      // Muzzle marker + flash.
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.028, -L - 0.12);
      group.add(muzzle);
      const flashSprite = makeFlashSprite(muzzle, emissive);
      const flashLight = makeFlashLight(muzzle);
      return { group, muzzle, mag, bolt, pump: null, slide: null, flashSprite, flashLight, hands };
    }

    case 'shotgun': {
      const barrelLen = L;
      addBox(body, 0, 0.01, -L * 0.42, 0.03, 0.038, L * 0.42); // receiver
      addCyl(metal, 0, 0.02, -barrelLen * 0.75, spec.barrelRadius, barrelLen * 0.6, group, 'z');
      // Tube magazine under the barrel.
      addCyl(metal, 0, -0.022, -barrelLen * 0.6, spec.barrelRadius * 0.85, barrelLen * 0.5, group, 'z');
      // Pump / forend (animated).
      const pump = new THREE.Group();
      addBox(body, 0, -0.008, 0, 0.028, 0.028, 0.07, pump);
      pump.position.set(0, 0, -barrelLen * 0.62);
      group.add(pump);
      // Stock + grip.
      addBox(body, 0, -0.02, 0.08, 0.026, 0.036, 0.08);
      addBox(dark, 0.004, -0.07, 0.005, 0.02, 0.05, 0.03);
      addBox(dark, 0, -0.05, -0.04, 0.013, 0.006, 0.028);
      // Bead sight.
      addBox(metal, 0, 0.062, -barrelLen * 0.96, 0.006, 0.008, 0.006);
      // Hands.
      const hands = new THREE.Group();
      addBox(glove, 0.004, -0.095, 0.0, 0.026, 0.04, 0.032, hands);
      addBox(skin, 0.03, -0.14, 0.05, 0.03, 0.045, 0.04, hands);
      addBox(glove, 0, -0.05, -barrelLen * 0.62, 0.03, 0.032, 0.05, hands);
      addBox(skin, -0.02, -0.1, -barrelLen * 0.5, 0.032, 0.04, 0.05, hands);
      group.add(hands);
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.02, -barrelLen - 0.06);
      group.add(muzzle);
      const flashSprite = makeFlashSprite(muzzle, emissive);
      const flashLight = makeFlashLight(muzzle);
      return { group, muzzle, mag: null, bolt: null, pump, slide: null, flashSprite, flashLight, hands };
    }

    case 'pistol': {
      addBox(body, 0, 0.02, -L * 0.45, 0.022, 0.036, L * 0.5); // slide
      const slide = addBox(metal, 0, 0.02, -L * 0.45, 0.023, 0.037, L * 0.5);
      // Frame + grip.
      addBox(dark, 0, -0.012, -L * 0.3, 0.02, 0.014, L * 0.42);
      addBox(dark, 0, -0.075, 0.012, 0.019, 0.052, 0.028);
      addBox(dark, 0, -0.045, -0.03, 0.012, 0.006, 0.024);
      // Barrel tip.
      addCyl(metal, 0, 0.02, -L - 0.02, spec.barrelRadius, 0.05, group, 'z');
      addBox(metal, 0, 0.052, -L * 0.85, 0.005, 0.007, 0.005);
      if (spec.magazineSize > 0) {
        addBox(dark, 0, -0.088, 0.012, 0.018, 0.038, 0.024); // magazine sticking out
      }
      // Hands (two-handed grip).
      const hands = new THREE.Group();
      addBox(glove, 0.004, -0.085, -0.012, 0.03, 0.045, 0.036, hands);
      addBox(glove, -0.026, -0.075, -0.02, 0.024, 0.04, 0.03, hands);
      addBox(skin, 0.035, -0.135, 0.03, 0.032, 0.045, 0.04, hands);
      group.add(hands);
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.02, -L - 0.06);
      group.add(muzzle);
      const flashSprite = makeFlashSprite(muzzle, emissive);
      const flashLight = makeFlashLight(muzzle);
      return { group, muzzle, mag: null, bolt: null, pump: null, slide, flashSprite, flashLight, hands };
    }

    case 'melee': {
      const blade = spec.blade ?? 0.4;
      // Grip + guard.
      addCyl(body, 0, -0.02, 0.02, 0.014, 0.16, group, 'y');
      addBox(metal, 0, 0.06, 0.02, 0.03, 0.008, 0.02);
      // Blade.
      addBox(metal, 0, 0.06 + blade * 0.5, 0.02, 0.006, blade * 0.5, 0.028);
      const hands = new THREE.Group();
      addBox(glove, 0, -0.04, 0.02, 0.03, 0.05, 0.032, hands);
      addBox(skin, 0.02, -0.1, 0.04, 0.034, 0.045, 0.04, hands);
      group.add(hands);
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.06 + blade, 0.02);
      group.add(muzzle);
      const flashSprite = makeFlashSprite(muzzle, emissive);
      flashSprite.visible = false;
      const flashLight = makeFlashLight(muzzle);
      return { group, muzzle, mag: null, bolt: null, pump: null, slide: null, flashSprite, flashLight, hands };
    }

    default: {
      // Throwable: a hand holding an object.
      addCyl(body, 0, 0, -0.02, spec.barrelRadius, spec.length, group, 'z');
      addBox(metal, 0, 0.02, 0, 0.02, 0.02, 0.02);
      const hands = new THREE.Group();
      addBox(glove, 0, -0.02, -0.02, 0.032, 0.05, 0.04, hands);
      addBox(skin, 0.01, -0.1, 0.02, 0.036, 0.05, 0.045, hands);
      group.add(hands);
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0, -0.2);
      group.add(muzzle);
      const flashSprite = makeFlashSprite(muzzle, emissive);
      flashSprite.visible = false;
      const flashLight = makeFlashLight(muzzle);
      return { group, muzzle, mag: null, bolt: null, pump: null, slide: null, flashSprite, flashLight, hands };
    }
  }
}

function makeFlashSprite(parent: THREE.Object3D, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), mat);
  mesh.position.set(0, 0, -0.03);
  mesh.visible = false;
  mesh.renderOrder = 20;
  parent.add(mesh);
  return mesh;
}

function makeFlashLight(parent: THREE.Object3D): THREE.PointLight {
  const light = new THREE.PointLight(0xffc070, 0, 9, 2);
  light.position.set(0, 0, -0.1);
  parent.add(light);
  return light;
}

/** Runtime state for one carried weapon. */
export class WeaponItem {
  readonly def: WeaponDef;
  ammo: number;
  reserve: number;
  count: number;
  /** Rounds fired since the last spread decay tick (recoil bloom). */
  bloom = 0;

  constructor(def: WeaponDef, ammo?: number, reserve?: number) {
    this.def = def;
    this.ammo = ammo ?? def.magazine;
    this.reserve = reserve ?? def.spawnAmmo;
    this.count = def.slot === 'throwable' ? 1 : 1;
  }

  get isEmpty(): boolean {
    return this.def.slot === 'throwable' ? this.count <= 0 : this.ammo <= 0;
  }
}

export class WeaponSystem {
  readonly viewModel = new THREE.Group();
  readonly inventory = {
    primary: null as WeaponItem | null,
    secondary: null as WeaponItem | null,
    melee: null as WeaponItem | null,
    throwable: null as WeaponItem | null,
  };
  heals: HealInventory = { medkit: 0, pills: 0, adrenaline: 0 };

  current: WeaponSlotName = 'secondary';
  /** 0 = hip fire, 1 = fully aimed. */
  ads = 0;
  private adsTarget = 0;
  private parts: ModelParts | null = null;
  private models = new Map<string, ModelParts>();
  private lastShot = -999;
  /**
   * Statistics for the end-of-chapter screen and the headless harness: trigger
   * pulls, individual projectiles, and the reserve bookkeeping a scoreboard
   * needs (accuracy = landed hits / `pelletsFired`).
   */
  shotsFired = 0;
  pelletsFired = 0;
  private reloadActive = false;
  private reloadEnd = 0;
  private reloadStart = 0;
  private reloadTactical = false;

  private meleeSwing = 0;
  private meleeCooldown = 0;
  private throwCharge = 0;
  private healTimer = 0;
  private healTotal = 0;
  private healItem: HealItemDef | null = null;
  private swapTimer = 0;
  private pendingSlot: WeaponSlotName | null = null;

  // Animation state.
  private kickPos = 0;
  private kickRot = 0;
  private kickVel = 0;
  private sway = new THREE.Vector2();
  private bobPhase = 0;
  private pumpOffset = 0;
  private boltOffset = 0;
  private slideOffset = 0;
  private magDrop = 0;
  private flashTimer = 0;
  private swingPhase = 0;

  private rand = new Rng(0x5eed77);
  private scratchHit: RayHit = new CollisionScratch().hit;
  private entityScratch: Damageable[] = [];
  private coneScratch: Damageable[] = [];
  private aimDir = new THREE.Vector3();
  private aimOrigin = new THREE.Vector3();
  private spreadDir = new THREE.Vector3();

  constructor(
    private host: WeaponHost,
    private world: CollisionWorld,
    private entities: EntityIndex,
    private lib: MaterialLibrary,
    private effects: Effects,
    private audio: AudioSystem,
    private settings: GameSettings,
  ) {
    this.viewModel.name = 'view_model';
    this.equip('secondary', 'pistol_m9', true);
  }

  /**
   * The level owns destructible props (barricades across the route, glass,
   * explosive barrels). Weapons are what break them, so the system needs a
   * handle on it — attached after construction because the level loads lazily.
   */
  setLevel(level: Level): void {
    this.levelRef = level;
  }

  private levelRef: Level | null = null;

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  get active(): WeaponItem | null {
    return this.inventory[this.current];
  }

  /**
   * True while a reload animation is in flight. This must be *state*, not a
   * derived `reloadEnd > now` comparison: the reload block below is gated on
   * this getter and its completion test is `now >= reloadEnd`, so a derived
   * value makes completion unreachable and the weapon dry-fires forever.
   */
  get reloading(): boolean {
    return this.reloadActive;
  }

  private now = 0;
  private timeSeconds = 0;

  /** Give a weapon (replaces the item in its slot). */
  give(weaponId: string, ammo?: number, reserve?: number): WeaponItem {
    const def = weaponDef(weaponId);
    const item = new WeaponItem(def, ammo, reserve);
    const slot = def.slot;
    this.inventory[slot] = item;
    return item;
  }

  giveHeal(kind: 'medkit' | 'pills' | 'adrenaline', count = 1): void {
    this.heals[kind] = Math.min(3, this.heals[kind] + count);
  }

  /** Switch weapons with a short raise/lower animation. */
  equip(slot: WeaponSlotName, weaponId?: string, instant = false): boolean {
    if (weaponId) this.give(weaponId, undefined, undefined);
    const item = this.inventory[slot];
    if (!item) return false;
    if (this.reloading) this.cancelReload();
    if (slot === this.current && this.parts && !instant) return false;
    if (instant) {
      this.current = slot;
      this.attachModel(item.def);
      this.swapTimer = 0;
      bus.emit('weapon:switch', { weaponId: item.def.id, slot });
      return true;
    }
    // Start the lower/raise cycle.
    this.swapTimer = 0.42;
    this.pendingSlot = slot;
    return true;
  }

  cycleWeapon(dir: 1 | -1): void {
    const order: WeaponSlotName[] = ['primary', 'secondary', 'melee'];
    const available = order.filter((s) => this.inventory[s]);
    if (available.length < 2) return;
    const idx = available.indexOf(this.current);
    const next = available[(idx + dir + available.length) % available.length];
    this.equip(next);
  }

  private attachModel(def: WeaponDef): void {
    if (this.parts) {
      this.viewModel.remove(this.parts.group);
    }
    let parts = this.models.get(def.id);
    if (!parts) {
      parts = buildWeaponModel(def, this.lib);
      this.models.set(def.id, parts);
    }
    this.parts = parts;
    this.viewModel.add(parts.group);
    parts.group.visible = true;
    // Reset animation offsets.
    this.magDrop = 0;
    this.pumpOffset = 0;
    this.boltOffset = 0;
    this.slideOffset = 0;
    (parts.flashSprite.material as THREE.MeshBasicMaterial).color.setHex(0xfff0c0);
    (parts.flashSprite.material as THREE.MeshBasicMaterial).map = this.effects.texture.flash;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  canFire(): boolean {
    if (!this.host.alive) return false;
    if (this.reloading || this.swapTimer > 0 || this.healTimer > 0 || this.meleeSwing > 0) return false;
    const item = this.active;
    if (!item) return false;
    if (item.def.slot === 'throwable') return false;
    if (item.def.class === 'melee') return false;
    return this.now - this.lastShot >= item.def.cycleMs / 1000;
  }

  /** Pull the trigger. `held` distinguishes automatic fire from taps. */
  tryFire(held: boolean): boolean {
    const item = this.active;
    if (!item || item.def.class === 'melee' || item.def.slot === 'throwable') return false;
    if (!this.canFire()) return false;
    if (!item.def.automatic && held && this.now - this.lastShot > 0.08) return false;
    if (item.ammo <= 0) {
      if (this.now - this.lastShot > 0.35) {
        bus.emit('weapon:dry', { weaponId: item.def.id });
        this.audio.play(`dry_${item.def.sfx.dry}` as never, { position: this.aimOrigin });
        this.lastShot = this.now;
        if (this.settings.autoReload) this.startReload();
      }
      return false;
    }
    this.fire(item);
    return true;
  }

  private fire(item: WeaponItem): void {
    const def = item.def;
    this.lastShot = this.now;
    item.ammo--;
    this.shotsFired++;
    this.pelletsFired += def.pellets;
    const shotIndex = item.ammo;
    this.host.aimOrigin(this.aimOrigin);
    this.host.aimDirection(this.aimDir);

    const spread = effectiveSpread(
      def,
      this.ads,
      this.host.velocity.length(),
      !this.host.grounded,
      this.host.crouching,
      item.bloom,
    );
    item.bloom = Math.min(def.spreadMax, item.bloom + def.spreadPerShot);

    const diff = difficultyDef(this.settings.difficulty);
    const pellets = Math.max(1, def.pellets);
    const muzzleWorld = this.muzzleWorldPosition();

    for (let p = 0; p < pellets; p++) {
      applySpread(this.aimDir, spread, this.rand, this.spreadDir);
      const cfg: BulletConfig = {
        origin: this.aimOrigin,
        dir: this.spreadDir.clone(),
        def,
        attacker: this.host as unknown as Damageable,
        world: this.world,
        entities: this.entities,
        rand: this.rand,
        friendlyFire: this.settings.friendlyFire ? 1 : 0,
        // A weapon fired from inside its owner's capsule would otherwise hit them.
        filterEntity: (e) => e !== (this.host as unknown as Damageable),
        damageMul: diff.survivorDamage,
        onEntityHit: (hit) => {
          const dmgOpts: DamageOptions = {
            source: this.host.position,
            attacker: this.host as unknown as Damageable,
            kind: 'bullet',
            hitZone: hit.zone,
            impulse: def.damage * 0.02,
          };
          const wasAlive = hit.entity.alive;
          hit.entity.takeDamage(hit.damage, dmgOpts);
          const headshot = hit.zone === 'head';
          this.effects.bloodSpray(hit.point.x, hit.point.y, hit.point.z, this.spreadDir.x, this.spreadDir.y, this.spreadDir.z, headshot ? 1.4 : 1, headshot);
          this.audio.impactFlesh(hit.point, headshot);
          bus.emit('zombie:hit', { variant: 'unknown', damage: hit.damage, headshot });
          if (wasAlive && !hit.entity.alive) {
            this.audio.play('zombie_die', { position: hit.point, pitch: 0.9 + this.rand.next() * 0.3 });
          }
          this.audio.hitmarker(headshot);
        },
        onSurfaceHit: (surfaceHit) => {
          this.effects.impact(
            surfaceHit.point.x,
            surfaceHit.point.y,
            surfaceHit.point.z,
            surfaceHit.normal.x,
            surfaceHit.normal.y,
            surfaceHit.normal.z,
            surfaceHit.surface,
          );
          this.audio.impactSurface(surfaceHit.surface, surfaceHit.point);
          bus.emit('impact', { surface: surfaceHit.surface, position: [surfaceHit.point.x, surfaceHit.point.y, surfaceHit.point.z], loudness: 1 });
        },
      };
      const result = castBullet(cfg, this.scratchHit, this.entityScratch);
      if (p === 0 || pellets <= 3) {
        this.effects.tracer(muzzleWorld.x, muzzleWorld.y, muzzleWorld.z, result.end.x, result.end.y, result.end.z, 0.028, def.class === 'sniper' ? 0xfff2d0 : 0xffd9a0);
      }
    }

    // Presentation.
    this.effects.muzzleFlash(
      muzzleWorld.x,
      muzzleWorld.y,
      muzzleWorld.z,
      this.aimDir.x,
      this.aimDir.y,
      this.aimDir.z,
      def.flashScale,
      def.sfx.loudness < 0.5,
    );
    this.flashTimer = 0.055;
    this.kickVel += 8 * def.kickback * 6;
    this.kickRot += def.recoilPitch * 0.022;
    this.host.applyRecoil(def.recoilPitch * (1 - this.ads * 0.25), (this.rand.next() - 0.5) * 2 * def.recoilYaw);
    this.host.addShake(def.kickback * 1.6);

    // Audio + noise (noise attracts infected).
    this.audio.gunshot(def, muzzleWorld);
    bus.emit('weapon:fire', { weaponId: def.id, position: [muzzleWorld.x, muzzleWorld.y, muzzleWorld.z], suppressor: def.sfx.loudness < 0.5 });
    this.audio.emitNoise(muzzleWorld, def.sfx.loudness * 34);

    // Bolt/pump/slide animation.
    if (def.model.style === 'shotgun') this.pumpOffset = 1;
    else if (def.model.style === 'sniper') this.boltOffset = 1;
    else if (def.model.style === 'pistol') this.slideOffset = 1;

    if (shotIndex === 0) {
      if (this.settings.autoReload) this.startReload();
    }
  }

  startReload(): void {
    const item = this.active;
    if (!item || item.def.class === 'melee' || item.def.slot === 'throwable') return;
    if (this.reloading) return;
    if (item.ammo >= item.def.magazine) return;
    if (item.reserve <= 0) return;
    const empty = item.ammo <= 0;
    // A def without a reload duration (or a typo'd one) would make `reloadEnd`
    // NaN. `reloading` is `reloadEnd > now`, so NaN reads as "not reloading",
    // the auto-reload re-triggers every frame and the weapon dry-fires forever.
    const raw = empty ? item.def.reloadTimeMs : item.def.reloadTimeTacticalMs;
    const duration = Number.isFinite(raw) && raw > 0 ? raw / 1000 : 2.0;
    this.reloadStart = this.now;
    this.reloadEnd = this.now + duration;
    this.reloadActive = true;
    this.reloadTactical = !empty;
    this.magDrop = 1;
    bus.emit('weapon:reloadStart', { weaponId: item.def.id, duration, empty, tactical: this.reloadTactical });
    this.audio.play(item.def.sfx.reload as never, { position: this.host.position, duration });
  }

  private cancelReload(): void {
    if (!this.reloadActive) return;
    this.reloadActive = false;
    this.reloadEnd = 0;
    const item = this.active;
    if (item) bus.emit('weapon:reloadEnd', { weaponId: item.def.id });
  }

  private finishReload(): void {
    this.reloadActive = false;
    const item = this.active;
    if (!item) return;
    const needed = item.def.magazine - item.ammo;
    const take = Math.min(needed, item.reserve);
    item.ammo += take;
    item.reserve -= take;
    this.magDrop = 0;
    bus.emit('weapon:reloadEnd', { weaponId: item.def.id });
  }

  /** Melee attack with the equipped melee weapon, or a shove. */
  meleeAttack(): boolean {
    const item = this.active;
    const meleeDef = item && item.def.class === 'melee' ? item.def : null;
    const def = meleeDef ?? weaponDef('melee_shove');
    if (this.now < this.meleeCooldown) return false;
    if (this.healTimer > 0 || this.reloading) return false;
    this.meleeCooldown = this.now + def.melee!.swingMs / 1000;
    this.meleeSwing = 1;
    this.swingPhase = 0;
    this.host.addShake(0.35);
    this.audio.play('melee_swing', { position: this.host.position });
    return true;
  }

  private resolveMelee(): void {
    const item = this.active;
    const meleeDef = item && item.def.class === 'melee' ? item.def : null;
    const def = meleeDef ?? weaponDef('melee_shove');
    const m = def.melee!;
    if (!this.host.aimDirection(this.aimDir)) return;
    const origin = this.host.position;
    this.coneScratch = coneQuery(
      this.entities,
      new THREE.Vector3(origin.x, origin.y + 1.2, origin.z),
      this.aimDir,
      m.range,
      m.arc,
      m.targets,
      this.coneScratch,
      (e) => e.alive && (!e.isSurvivor || this.settings.friendlyFire),
    );
    const diff = difficultyDef(this.settings.difficulty);
    // Level props are colliders, not entities, so the cone query above never
    // sees them: a swing has to sweep the destructible list separately or the
    // "MELEE TO SMASH" prompt is a lie.
    this.damageBreakables(m.range, m.arc, m.damage);
    if (this.coneScratch.length === 0) {
      // Whiff sound for shove.
      return;
    }
    for (const target of this.coneScratch) {
      const zombie = target as Damageable & { canBeInstakilled?: boolean; stagger?: (t: number) => void };
      const isCommon = target.isZombie && (zombie.canBeInstakilled ?? false);
      const instakill = !m.shove && isCommon && this.rand.next() < m.instakillChance;
      const dmg = (instakill ? 9999 : m.damage) * diff.survivorDamage * (target.isZombie ? 1 : 0.4);
      target.takeDamage(dmg, {
        source: origin,
        attacker: this.host as unknown as Damageable,
        kind: 'melee',
        hitZone: 'torso',
        impulse: m.shove ? 260 : 120,
      });
      const p = target.position;
      const dx = this.aimDir.x;
      const dz = this.aimDir.z;
      this.effects.bloodSpray(p.x, p.y + 1.2, p.z, dx, 0.2, dz, instakill ? 2 : 0.7, instakill);
      this.audio.impactFlesh(new THREE.Vector3(p.x, p.y + 1.2, p.z), instakill);
      // The shove always staggers.
      if (m.shove) zombie.stagger?.(0.9);
      else if (dmg >= 40 && zombie.stagger) zombie.stagger?.(0.45);
      if (instakill) this.effects.gib(p.x, p.y + 1.4, p.z, 0.7);
    }
    this.audio.play(m.shove ? 'melee_shove_hit' : 'melee_hit_flesh', { position: origin });
    this.audio.emitNoise(origin, m.shove ? 8 : 14);
  }

  /** Throw the equipped throwable (charge affects distance). */
  throwStart(): void {
    this.throwCharge = 0;
  }

  throwRelease(charge: number): boolean {
    const item = this.inventory.throwable;
    if (!item || item.count <= 0) return false;
    const spec = item.def.throwable!;
    if (!this.host.aimOrigin(this.aimOrigin) || !this.host.aimDirection(this.aimDir)) return false;
    // Lob upward slightly so it arcs over short obstacles.
    const speed = spec.throwSpeed * (0.55 + 0.45 * clamp01(charge));
    const dir = this.aimDir.clone().multiplyScalar(speed);
    dir.y += 2.4 + charge * 1.2;
    item.count--;
    bus.emit('weapon:throw', { kind: spec.kind });
    this.audio.play('throw', { position: this.host.position });
    this.audio.emitNoise(this.host.position, 6);
    this.pendingThrow = { def: item.def, origin: this.aimOrigin.clone(), velocity: dir };
    this.throwCharge = 0;
    if (item.count <= 0) {
      this.inventory.throwable = null;
      if (this.current === 'throwable') this.equip(this.inventory.primary ? 'primary' : 'secondary');
    }
    return true;
  }

  /** Set by the engine each frame: consume this to spawn a projectile entity. */
  pendingThrow: { def: WeaponDef; origin: THREE.Vector3; velocity: THREE.Vector3 } | null = null;

  useHeal(): boolean {
    if (this.healTimer > 0 || this.reloading) return false;
    // Prefer pills/adrenaline when healthy (they grant temp health), medkit when hurt.
    const order: ('adrenaline' | 'pills' | 'medkit')[] = this.host.alive ? ['adrenaline', 'pills', 'medkit'] : [];
    for (const kind of order) {
      if (this.heals[kind] > 0) {
        const def = HEAL_ITEMS[kind];
        this.heals[kind]--;
        this.healItem = def;
        this.healTotal = def.useTimeMs / 1000;
        this.healTimer = this.healTotal;
        this.audio.play('heal_use', { position: this.host.position });
        return true;
      }
    }
    return false;
  }

  /** Called by the engine when the heal timer completes. */
  onHealComplete: ((def: HealItemDef) => void) | null = null;

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  update(dt: number, opts: { fire: boolean; firePressed: boolean; ads: boolean; reload: boolean; use: boolean; lean: THREE.Vector2 }): void {
    this.timeSeconds += dt;
    this.now += dt;
    const item = this.active;

    // --- weapon swapping ---------------------------------------------------
    if (this.swapTimer > 0) {
      this.swapTimer -= dt;
      if (this.swapTimer <= 0 && this.pendingSlot) {
        this.current = this.pendingSlot;
        this.pendingSlot = null;
        const next = this.active;
        if (next) {
          this.attachModel(next.def);
          bus.emit('weapon:switch', { weaponId: next.def.id, slot: this.current });
        }
      }
    }

    // --- reload ------------------------------------------------------------
    if (this.reloadActive) {
      const t = 1 - (this.reloadEnd - this.now) / Math.max(0.001, this.reloadEnd - this.reloadStart);
      // Magazine drops out then a new one slides in, around the midpoint.
      this.magDrop = t < 0.45 ? 1 - t / 0.45 : t > 0.75 ? (t - 0.75) / 0.25 : 0.0;
      if (this.now >= this.reloadEnd) {
        this.finishReload();
        this.reloadEnd = 0;
      }
    }

    // --- melee swing -------------------------------------------------------
    if (this.meleeSwing > 0) {
      const def = item?.def.class === 'melee' ? item.def : weaponDef('melee_shove');
      const dur = def.melee!.swingMs / 1000;
      this.swingPhase += dt / dur;
      if (!this.meleeResolved && this.swingPhase >= def.melee!.hitAt) {
        this.meleeResolved = true;
        this.resolveMelee();
      }
      if (this.swingPhase >= 1) {
        this.meleeSwing = 0;
        this.meleeResolved = false;
        this.swingPhase = 0;
      }
    }

    // --- healing -----------------------------------------------------------
    if (this.healTimer > 0) {
      this.healTimer -= dt;
      if (this.healTimer <= 0 && this.healItem) {
        this.onHealComplete?.(this.healItem);
        this.audio.play('heal_done', { position: this.host.position });
        this.healItem = null;
      }
    }

    // --- spread bloom decay ------------------------------------------------
    if (item) item.bloom = Math.max(0, item.bloom - item.def.spreadDecay * dt);

    // --- ADS ---------------------------------------------------------------
    const canAds = !!item && item.def.class !== 'melee' && item.def.slot !== 'throwable' && this.healTimer <= 0;
    this.adsTarget = opts.ads && canAds ? 1 : 0;
    this.ads = damp(this.ads, this.adsTarget, 12, dt);

    // --- fire --------------------------------------------------------------
    if (opts.fire && item && item.def.automatic) {
      this.tryFire(true);
    }
    if (opts.firePressed && item && !item.def.automatic) {
      this.tryFire(false);
    }

    // --- throw charge ------------------------------------------------------
    if (this.current === 'throwable' && opts.fire) {
      this.throwCharge = Math.min(1, this.throwCharge + dt * 1.6);
    }

    // --- view model animation ---------------------------------------------
    this.animateViewModel(dt, opts.lean);

    // --- HUD-ish events ----------------------------------------------------
    if (item && item.ammo === 0 && !this.reloading && this.now - this.lastShot > 0.4 && this.settings.autoReload && item.reserve > 0) {
      this.startReload();
    }
  }

  /**
   * Melee is the game's answer to "MELEE TO SMASH [F]": a swing that lands on a
   * destructible prop closes the gap the `coneQuery` above cannot see, because
   * level props are colliders rather than `Damageable` entities.
   */
  private damageBreakables(range: number, arc: number, damage: number): void {
    const level = this.levelRef;
    if (!level) return;
    if (!this.host.aimDirection(this.aimDir)) return;
    const ox = this.host.position.x;
    const oy = this.host.position.y + 1.2;
    const oz = this.host.position.z;
    const cosArc = Math.cos(Math.max(0.1, arc) * 0.5);
    for (const b of level.breakableList) {
      if (b.broken) continue;
      const d = b.def;
      const dx = d.x - ox;
      const dy = d.y - oy;
      const dz = d.z - oz;
      const len = Math.hypot(dx, dy, dz);
      // Use the prop's half-extents as a crude radius so wide barricades are
      // hittable from their ends too.
      const reach = range + Math.max(d.hx, d.hz) * 0.75;
      if (len > reach) continue;
      const inv = 1 / Math.max(0.001, len);
      if (dx * inv * this.aimDir.x + dy * inv * this.aimDir.y + dz * inv * this.aimDir.z < cosArc) continue;
      const surface = d.material === 'metal' || d.material === 'glass' ? d.material : 'wood';
      const result = level.damageBreakable(b, damage);
      this.effects.impact(result.position.x, result.position.y, result.position.z, 0, 1, 0, surface);
      if (result.destroyed) this.audio.play('door_break', { position: result.position, pitch: 1.15 + this.rand.next() * 0.2 });
      else this.audio.impactSurface(surface, result.position);
    }
  }

  private meleeResolved = false;

  /** World position of the muzzle (used for tracers, flash lights, audio). */
  muzzleWorldPosition(): THREE.Vector3 {
    if (!this.parts) return this.host.centre.clone();
    this.parts.muzzle.getWorldPosition(VM_TMP);
    // The view model lives in view space; convert through the camera matrix.
    return this.host.camera.localToWorld(VM_TMP2.copy(VM_TMP).sub(VIEW_OFFSET));
  }

  /**
   * Pose + animate the view model. Everything here is procedural: a recoil
   * spring, ADS blending between a hip pose and a sighted pose, sway from mouse
   * movement, walk bob, and per-mechanism animation (pump, bolt, slide, mag).
   */
  private animateViewModel(dt: number, lean: THREE.Vector2): void {
    const parts = this.parts;
    if (!parts || !this.host.alive) {
      this.viewModel.visible = false;
      return;
    }
    const def = this.active?.def;
    if (!def) {
      this.viewModel.visible = false;
      return;
    }
    this.viewModel.visible = true;
    const isMelee = def.class === 'melee';
    const isThrowable = def.slot === 'throwable';

    // --- springs ----------------------------------------------------------
    // Recoil: critically damped spring pulling back to rest.
    const stiffness = 120;
    const damping = 16;
    const accel = -stiffness * this.kickPos - damping * this.kickVel;
    this.kickVel += accel * dt;
    this.kickPos += this.kickVel * dt;
    this.kickRot = damp(this.kickRot, 0, 9, dt);
    this.slideOffset = damp(this.slideOffset, 0, 14, dt);
    this.boltOffset = damp(this.boltOffset, 0, 9, dt);
    this.pumpOffset = damp(this.pumpOffset, 0, 7, dt);

    // --- sway from look input ---------------------------------------------
    this.sway.x = damp(this.sway.x, clamp(-lean.x * 2.4, -0.06, 0.06), 6, dt);
    this.sway.y = damp(this.sway.y, clamp(-lean.y * 2.4, -0.05, 0.05), 6, dt);

    // --- walk bob ---------------------------------------------------------
    const speed = Math.hypot(this.host.velocity.x, this.host.velocity.z);
    const bobAmount = clamp(speed / 6, 0, 1) * (1 - this.ads * 0.7) * this.settings.viewBob;
    this.bobPhase += dt * (4 + speed * 1.6);
    const bobX = Math.sin(this.bobPhase) * 0.014 * bobAmount;
    const bobY = Math.abs(Math.cos(this.bobPhase)) * 0.012 * bobAmount - 0.006 * bobAmount;
    const bobRoll = Math.sin(this.bobPhase) * 0.035 * bobAmount;

    // --- healing pose -----------------------------------------------------
    const healT = this.healTimer > 0 ? 1 - this.healTimer / Math.max(0.001, this.healTotal) : 0;
    const healDip = this.healTimer > 0 ? Math.sin(clamp01(healT) * Math.PI) : 0;

    // --- poses -------------------------------------------------------------
    // Hip pose (right side, slightly down), ADS pose (centred, sight height).
    const hip = { x: 0.16, y: -0.16, z: -0.34, rx: 0.02, ry: -0.06, rz: 0.03 };
    const ads = { x: 0, y: -0.089, z: -0.24, rx: 0, ry: 0, rz: 0 };
    const a = this.ads;
    let px = lerp(hip.x, ads.x, a);
    let py = lerp(hip.y, ads.y, a);
    let pz = lerp(hip.z, ads.z, a);
    let rx = lerp(hip.rx, ads.rx, a) + this.kickRot * 1.4;
    let ry = lerp(hip.ry, ads.ry, a);
    let rz = lerp(hip.rz, ads.rz, a) + bobRoll;

    // Reload: dip down and rotate out of view.
    const reloadT = this.reloading
      ? 1 - (this.reloadEnd - this.now) / Math.max(0.001, this.reloadEnd - this.reloadStart)
      : 0;
    if (this.reloading) {
      const dip = Math.sin(clamp01(reloadT) * Math.PI);
      py -= dip * 0.1;
      pz += dip * 0.05;
      rx += dip * 0.5;
      rz += dip * 0.35;
    }

    // Melee swing arc.
    if (this.meleeSwing > 0) {
      const s = this.swingPhase;
      const arc = Math.sin(s * Math.PI);
      px += arc * (s < 0.5 ? 0.16 : -0.1);
      pz += arc * 0.12;
      rx -= arc * 0.75;
      rz += arc * 0.9;
    }
    // Throw wind-up.
    if (isThrowable && this.throwCharge > 0) {
      pz += this.throwCharge * 0.08;
      rx += this.throwCharge * 0.4;
      py += this.throwCharge * 0.06;
    }

    parts.group.position.set(px + this.sway.x + bobX, py + this.sway.y + bobY - this.kickPos * 0.02 - healDip * 0.06, pz - this.kickPos * 0.045);
    parts.group.rotation.set(rx, ry + this.sway.x * 1.2, rz);

    // --- mechanism animation ----------------------------------------------
    if (parts.pump) parts.pump.position.z = -def.model.length * 0.62 + this.pumpOffset * 0.07;
    if (parts.bolt) parts.bolt.position.z = -def.model.length * 0.22 + this.boltOffset * 0.05;
    if (parts.slide) parts.slide.position.z = -def.model.length * 0.45 + this.slideOffset * 0.028;
    if (parts.mag) {
      parts.mag.position.y = -0.075 - (def.model.magazineSize > 0 ? 0.045 : 0) - this.magDrop * 0.22;
      parts.mag.rotation.z = this.magDrop * 0.5;
    }
    // Hands tuck in while aiming.
    parts.hands.visible = !isMelee || true;
    void isMelee;

    // --- muzzle flash presentation ----------------------------------------
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const scale = def.flashScale * (0.85 + this.rand.next() * 0.3);
      parts.flashSprite.visible = true;
      parts.flashSprite.scale.set(scale, scale, scale);
      parts.flashSprite.rotation.z = this.rand.next() * Math.PI * 2;
      parts.flashLight.visible = true;
      parts.flashLight.intensity = 14 * def.flashScale;
      parts.flashLight.distance = 12;
    } else {
      parts.flashSprite.visible = false;
      parts.flashLight.visible = false;
    }

    // Hide the model entirely at high scope magnification.
    const scoped = def.model.scope && this.ads > 0.82;
    parts.group.visible = !scoped;
    this.scoped = scoped;
  }

  /** True when the player is looking through a scope (HUD draws the overlay). */
  scoped = false;

  /** Spread cone size in degrees for the crosshair. */
  get currentSpread(): number {
    const item = this.active;
    if (!item) return 4;
    return effectiveSpread(item.def, this.ads, this.host.velocity.length(), !this.host.grounded, this.host.crouching, item.bloom);
  }

  /** Ammo readout for the HUD. */
  get ammoInfo(): { mag: number; magMax: number; reserve: number; name: string; abbr: string; count: number } {
    const item = this.active;
    if (!item) return { mag: 0, magMax: 0, reserve: 0, name: '', abbr: '', count: 0 };
    return {
      mag: item.def.slot === 'throwable' ? item.count : item.ammo,
      magMax: item.def.slot === 'throwable' ? item.def.reserveMax : item.def.magazine,
      reserve: item.reserve,
      name: item.def.name,
      abbr: item.def.abbr,
      count: item.count,
    };
  }

  /** Ammo for one type across the inventory (L4D shares pools per ammo type). */
  reserveFor(ammoType: string): number {
    let total = 0;
    for (const slot of ['primary', 'secondary'] as const) {
      const it = this.inventory[slot];
      if (it && it.def.ammoType === ammoType) total += it.reserve;
    }
    return total;
  }

  addAmmo(ammoType: string, amount: number): number {
    let added = 0;
    for (const slot of ['primary', 'secondary'] as const) {
      const it = this.inventory[slot];
      if (!it || it.def.ammoType !== ammoType) continue;
      const before = it.reserve;
      it.reserve = Math.min(it.def.reserveMax, it.reserve + amount);
      added += it.reserve - before;
    }
    return added;
  }

  /**
   * Late binding for quality/difficulty changes: the system re-reads the
   * settings on every shot anyway, but the view-model FOV and sensitivity are
   * baked into the camera transform, so they need a push.
   */
  applySettings(settings: GameSettings): void {
    this.settings = settings;
  }

  /**
   * Safe-room resupply: top up every magazine in the inventory, refill reserves
   * and hand back one of each healing item. This is the mechanical reward for
   * surviving a chapter.
   */
  restock(): void {
    for (const key of ['primary', 'secondary', 'melee', 'throwable'] as WeaponSlotName[]) {
      const item = this.inventory[key];
      if (!item) continue;
      if (item.def.ammoType === 'none') continue;
      item.ammo = item.def.magazine;
      item.reserve = item.def.reserveMax;
      item.count = Math.max(item.count, 1);
    }
    this.heals.medkit = Math.max(this.heals.medkit, 1);
    this.heals.pills = Math.max(this.heals.pills, 1);
    const throwable = this.inventory.throwable;
    if (throwable) throwable.count = Math.max(throwable.count, 1);
  }

  dispose(): void {
    for (const parts of this.models.values()) {
      parts.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    }
    this.models.clear();
    this.parts = null;
  }
}

const VM_TMP = new THREE.Vector3();
const VM_TMP2 = new THREE.Vector3();
/** The view camera sits at the origin looking down -Z, so the offset is zero. */
const VIEW_OFFSET = new THREE.Vector3(0, 0, 0);
