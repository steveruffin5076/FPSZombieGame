/**
 * ITEM / PICKUP SYSTEM
 * ====================
 * Consumables and weapon pickups are streamed in from the level's item-spot
 * table as the squad advances, so loot is always "just ahead" of the player —
 * which is what keeps a linear campaign feeling hand-placed.
 *
 * Picking something up is *not* automatic: weapons require an interact press so
 * you never lose your rifle to a stray key, while ammo/health auto-collect when
 * you are missing the resource.
 */
import * as THREE from 'three';
import { bus } from '@/core/Events';
import { Rng } from '@/core/MathUtil';
import type { CollisionWorld } from '@/physics/Collision';
import { weaponDef, HEAL_ITEMS, PRIMARY_IDS, SECONDARY_IDS, THROWABLE_IDS, MELEE_IDS } from '@/config/weapons';
import type { Level } from '@/world/Level';
import type { LevelLayout, ItemSpot, ItemSpotKind } from '@/world/LevelTypes';
import type { MaterialLibrary } from '@/render/Materials';
import type { AudioSystem } from '@/audio/Audio';
import type { WeaponSystem } from '@/weapons/Weapons';
import type { Effects } from '@/vfx/Effects';
import type { Survivor } from '@/entities/Survivor';
import type { TeammateAI } from '@/entities/TeammateAI';

export type PickupKind = 'weapon_primary' | 'weapon_secondary' | 'melee' | 'throwable' | 'ammo' | 'medkit' | 'pills' | 'adrenaline';

export interface Pickup {
  id: number;
  kind: PickupKind;
  /** Weapon id for weapon pickups, ammo type for ammo, heal id for health. */
  data: string;
  position: THREE.Vector3;
  mesh: THREE.Group;
  taken: boolean;
  /** Rotates/bobs for visibility. */
  phase: number;
  /** Ammo crates stack; pickup radius is generous. */
  radius: number;
  /** Distance at which the pickup becomes visible/active. */
  spawnAt: number;
}

export class ItemManager {
  readonly group = new THREE.Group();
  private pickups: Pickup[] = [];
  private nextId = 1;
  private rng = new Rng(0x17e5);
  private spots: ItemSpot[] = [];
  /** Layout the pickups were streamed from (kept for spawn hints). */
  private layout: LevelLayout | null = null;
  private materials: MaterialLibrary;
  private audio: AudioSystem;
  private effects: Effects;
  private world: CollisionWorld;
  private level: Level | null = null;
  /** How far ahead of the squad loot can appear. */
  private streamAhead = 60;
  private streamBehind = 30;

  constructor(world: CollisionWorld, materials: MaterialLibrary, audio: AudioSystem, effects: Effects) {
    this.world = world;
    this.materials = materials;
    this.audio = audio;
    this.effects = effects;
    this.group.name = 'items';
  }

  /** Initialise for a chapter: registers the level's loot table. */
  load(layout: LevelLayout, level: Level): void {
    this.clear();
    this.layout = layout;
    this.level = level;
    this.spots = layout.itemSpots.slice();
    // Safe-room stock is always present (it is the between-chapter resupply).
    for (const spot of this.spots) {
      const isSafeRoom = Math.hypot(spot.x - layout.safeRoom.x, spot.z - layout.safeRoom.z) < 6;
      if (isSafeRoom) this.createAt(spot);
    }
  }

  clear(): void {
    for (const p of this.pickups) {
      this.group.remove(p.mesh);
      disposeGroup(p.mesh);
    }
    this.pickups.length = 0;
    this.spots.length = 0;
  }

  /** Stream loot in/out based on squad progress along the route. */
  update(playerPos: THREE.Vector3, routeProgress: number): void {
    if (!this.layout) return;
    // Spawn spots that have just entered the player's "ahead" window.
    const routePoint = this.level?.routePoint(Math.min(1, routeProgress + 0.02));
    if (routePoint) {
      for (const spot of this.spots) {
        if (spot.used) continue;
        const d = Math.hypot(spot.x - routePoint.x, spot.z - routePoint.z);
        const dToPlayer = Math.hypot(spot.x - playerPos.x, spot.z - playerPos.z);
        if (d < this.streamAhead || dToPlayer < 25) {
          spot.used = true;
          this.createAt(spot);
        }
      }
    }
    // Remove pickups far behind the player (keeps the scene lean).
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (p.taken) continue;
      const d = Math.hypot(p.position.x - playerPos.x, p.position.z - playerPos.z);
      if (d > this.streamAhead + this.streamBehind + 40) {
        this.group.remove(p.mesh);
        disposeGroup(p.mesh);
        this.pickups.splice(i, 1);
      }
    }
  }

  private createAt(spot: ItemSpot): void {
    const kind = this.resolveKind(spot.kind, spot.tier);
    const data = this.resolveData(kind, spot.tier);
    // Drop the pickup onto the actual floor: the generator places spots from
    // room definitions, and a slab/step there may be a few centimetres higher.
    const floor = this.world.groundAt(spot.x, spot.z, spot.y + 1.2, 1.4);
    const y = (Number.isFinite(floor) ? floor : spot.y) + 0.12;
    const mesh = this.buildMesh(kind, data);
    mesh.position.set(spot.x, y, spot.z);
    this.group.add(mesh);
    this.pickups.push({
      id: this.nextId++,
      kind,
      data,
      position: new THREE.Vector3(spot.x, y, spot.z),
      mesh,
      taken: false,
      phase: this.rng.range(0, Math.PI * 2),
      radius: kind === 'ammo' || kind === 'medkit' || kind === 'pills' || kind === 'adrenaline' ? 1.5 : 1.3,
      spawnAt: 0,
    });
  }

  private resolveKind(kind: ItemSpotKind, tier: number): PickupKind {
    if (kind === 'weapon') return this.rng.chance(0.25 + tier * 0.1) ? 'weapon_secondary' : 'weapon_primary';
    if (kind === 'health') {
      return this.rng.weighted<PickupKind>([
        ['medkit', 3],
        ['pills', 2.4],
        ['adrenaline', 1],
      ]);
    }
    if (kind === 'throwable') return 'throwable';
    if (kind === 'ammo') return 'ammo';
    return 'ammo';
  }

  private resolveData(kind: PickupKind, tier: number): string {
    switch (kind) {
      case 'weapon_primary':
        return tier >= 2 ? this.rng.pick(['rifle_scoped', 'shotgun_auto', 'ar_ak']) : this.rng.pick(PRIMARY_IDS);
      case 'weapon_secondary':
        return this.rng.pick(SECONDARY_IDS);
      case 'melee':
        return this.rng.pick(MELEE_IDS);
      case 'throwable':
        return this.rng.pick(THROWABLE_IDS);
      case 'ammo':
        return this.rng.pick(['rifle', 'smg', 'shells', 'sniper', 'pistol']);
      case 'medkit':
      case 'pills':
      case 'adrenaline':
        return kind;
      default:
        return 'rifle';
    }
  }

  /** Small, readable pickup meshes with an emissive glow so they read in the dark. */
  private buildMesh(kind: PickupKind, data: string): THREE.Group {
    const g = new THREE.Group();
    const accentColor =
      kind === 'medkit'
        ? 0xd94f3d
        : kind === 'pills'
          ? 0xe8e2d2
          : kind === 'adrenaline'
            ? 0xe07a2a
            : kind === 'ammo'
              ? 0xd9b25a
              : kind === 'throwable'
                ? 0x7a9a3a
                : 0x9aa4a8;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.26, 0.3),
      this.materials.plain(0x3a3f42, { roughness: 0.7, metalness: 0.3, vertexColors: false }),
    );
    body.castShadow = false;
    g.add(body);
    // Colour band so the type is identifiable at a glance.
    const bandMat = new THREE.MeshBasicMaterial({ color: accentColor, toneMapped: false });
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.06, 0.32), bandMat);
    band.position.y = 0.16;
    g.add(band);
    // Weapon pickups show a simplified silhouette.
    if (kind === 'weapon_primary' || kind === 'weapon_secondary') {
      const def = weaponDef(data);
      const len = Math.min(0.9, def.model.length);
      const gun = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.1, len),
        this.materials.plain(def.model.metalTint, { roughness: 0.4, metalness: 0.8, vertexColors: false }),
      );
      gun.position.set(0, 0.26, 0);
      gun.rotation.y = 0.3;
      g.add(gun);
      const mag = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.16, 0.09),
        this.materials.plain(def.model.bodyTint, { roughness: 0.7, vertexColors: false }),
      );
      mag.position.set(0, 0.14, 0.1);
      g.add(mag);
    }
    if (kind === 'medkit') {
      const cross = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.08), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      cross.position.set(0, 0.15, 0.16);
      g.add(cross);
      const cross2 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.24), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      cross2.position.set(0, 0.15, 0.16);
      g.add(cross2);
    }
    // A dim glow sprite makes loot findable in dark chapters.
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.1),
      new THREE.MeshBasicMaterial({
        color: accentColor,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.12;
    g.add(glow);
    return g;
  }

  /** All pickups within interact range, nearest first. */
  query(x: number, y: number, z: number, radius = 1.6): Pickup | null {
    let best: Pickup | null = null;
    let bestD = radius * radius;
    for (const p of this.pickups) {
      if (p.taken) continue;
      const dx = p.position.x - x;
      const dz = p.position.z - z;
      const dy = p.position.y - y;
      if (Math.abs(dy) > 2.2) continue;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /**
   * Attempt a pickup. Weapons require `interact = true`; consumables are taken
   * automatically when they would help.
   */
  tryPickup(p: Pickup, weapons: WeaponSystem, survivor: Survivor, interact: boolean): boolean {
    if (p.taken) return false;
    switch (p.kind) {
      case 'weapon_primary': {
        if (!interact) return false;
        const def = weaponDef(p.data);
        const current = weapons.inventory.primary;
        if (current && current.def.id === def.id) {
          // Same weapon: treat it as an ammo cache.
          const added = weapons.addAmmo(def.ammoType, def.reservePickup);
          if (added <= 0) return false;
        } else {
          weapons.give(def.id, def.magazine, Math.max(def.spawnAmmo, def.reservePickup * 0.6));
          weapons.equip('primary');
          this.audio.play('pickup_weapon', { position: p.position });
          bus.emit('survivor:pickup', { id: survivor.id, item: def.name });
        }
        break;
      }
      case 'weapon_secondary':
      case 'melee': {
        if (!interact) return false;
        const def = weaponDef(p.data);
        weapons.give(def.id, def.magazine, def.spawnAmmo);
        weapons.equip(def.slot);
        this.audio.play('pickup_weapon', { position: p.position });
        bus.emit('survivor:pickup', { id: survivor.id, item: def.name });
        break;
      }
      case 'throwable': {
        if (!interact) return false;
        const def = weaponDef(p.data);
        const current = weapons.inventory.throwable;
        if (current && current.def.id === def.id) current.count = Math.min(def.reserveMax, current.count + 1);
        else {
          weapons.give(def.id, 1, 0);
          weapons.inventory.throwable!.count = 1;
        }
        this.audio.play('pickup_item', { position: p.position });
        break;
      }
      case 'ammo': {
        if (!interact) return false;
        const amount = 60;
        const added = weapons.addAmmo(p.data, amount);
        if (added <= 0) {
          // Nothing to feed: still heal nothing, refuse the pickup.
          return false;
        }
        this.audio.play('pickup_item', { position: p.position });
        break;
      }
      case 'medkit':
      case 'pills':
      case 'adrenaline': {
        if (!interact) return false;
        // Refuse when already full to avoid wasting a medkit.
        if (p.kind === 'medkit' && survivor.health >= survivor.maxHealth - 1) return false;
        if (p.kind !== 'medkit' && survivor.tempHealth >= 40) return false;
        weapons.giveHeal(p.kind as 'medkit' | 'pills' | 'adrenaline', 1);
        this.audio.play('pickup_item', { position: p.position });
        bus.emit('survivor:pickup', { id: survivor.id, item: HEAL_ITEMS[p.kind].name });
        break;
      }
    }
    p.taken = true;
    this.group.remove(p.mesh);
    disposeGroup(p.mesh);
    const idx = this.pickups.indexOf(p);
    if (idx >= 0) this.pickups.splice(idx, 1);
    this.effects.dust(p.position.x, p.position.y, p.position.z, 0.5);
    return true;
  }

  /**
   * Let an AI teammate take useful loot (they walk over ammo/health when hurt).
   * Teammates never steal the player's weapon upgrades.
   */
  tryPickupForAI(p: Pickup, ai: TeammateAI): boolean {
    if (p.taken) return false;
    if (p.kind === 'ammo') {
      ai.addAmmo(70);
      this.audio.play('pickup_item', { position: p.position, volume: 0.4 });
    } else if (p.kind === 'throwable') {
      ai.giveThrowable(1);
    } else if (p.kind === 'weapon_primary' && ai.health < 60) {
      ai.giveWeapon(p.data);
    } else if (p.kind === 'medkit' || p.kind === 'pills' || p.kind === 'adrenaline') {
      if (ai.health > 65 && ai.tempHealth > 20) return false;
      if (p.kind === 'medkit') ai.heal(HEAL_ITEMS.medkit.heal);
      else ai.giveTempHealth(HEAL_ITEMS[p.kind].tempHealth, HEAL_ITEMS[p.kind].tempDecayPerSec, HEAL_ITEMS[p.kind].tempDecayDelay);
    } else {
      return false;
    }
    p.taken = true;
    this.group.remove(p.mesh);
    disposeGroup(p.mesh);
    const idx = this.pickups.indexOf(p);
    if (idx >= 0) this.pickups.splice(idx, 1);
    return true;
  }

  /** Safe-room resupply: restock the squad when the chapter door opens. */
  restock(player: WeaponSystem, teammates: TeammateAI[]): void {
    for (const ammoType of ['rifle', 'smg', 'shells', 'sniper', 'pistol'] as const) {
      player.addAmmo(ammoType, 200);
    }
    // Always hand out at least something to throw.
    if (!player.inventory.throwable) {
      const id = this.rng.pick(THROWABLE_IDS);
      player.give(id, 1, 0);
      player.inventory.throwable!.count = 2;
    } else {
      player.inventory.throwable.count = Math.min(3, player.inventory.throwable.count + 1);
    }
    if (!player.inventory.melee) {
      player.give(this.rng.pick(MELEE_IDS), 0, 0);
    }
    for (const t of teammates) {
      t.addAmmo(300);
      t.giveThrowable(1);
    }
  }

  /** Line-of-sight aware prompt text for the HUD. */
  promptFor(p: Pickup): string {
    switch (p.kind) {
      case 'weapon_primary':
      case 'weapon_secondary': {
        const def = weaponDef(p.data);
        return `[E] Take ${def.name}`;
      }
      case 'melee':
        return `[E] Take ${weaponDef(p.data).name}`;
      case 'throwable':
        return `[E] Take ${weaponDef(p.data).name}`;
      case 'ammo':
        return `[E] Take ${p.data.toUpperCase()} ammo`;
      case 'medkit':
        return '[E] Take First Aid Kit';
      case 'pills':
        return '[E] Take Pain Pills';
      case 'adrenaline':
        return '[E] Take Adrenaline';
      default:
        return '[E] Pick up';
    }
  }

  get list(): readonly Pickup[] {
    return this.pickups;
  }

  /** Animate: bob, and make loot glow brighter when the level is dark. */
  updateVisuals(dt: number, time: number): void {
    for (const p of this.pickups) {
      if (p.taken) continue;
      p.mesh.rotation.y += dt * 0.6;
      p.mesh.position.y = p.position.y + Math.sin(time * 2 + p.phase) * 0.04;
    }
  }

  /** Convenience for the Director: drop a specific item at a location. */
  spawnAt(kind: PickupKind, data: string, x: number, y: number, z: number): Pickup {
    const mesh = this.buildMesh(kind, data);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    const pickup: Pickup = {
      id: this.nextId++,
      kind,
      data,
      position: new THREE.Vector3(x, y, z),
      mesh,
      taken: false,
      phase: this.rng.range(0, Math.PI * 2),
      radius: 1.5,
      spawnAt: 0,
    };
    this.pickups.push(pickup);
    return pickup;
  }

  get itemCount(): number {
    return this.pickups.length;
  }
}

function disposeGroup(g: THREE.Group): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}
