/**
 * PROCEDURAL CHARACTER RENDERING
 * ==============================
 * There are no character models in this project — every survivor and every
 * infected is built from primitives at runtime and animated procedurally:
 *
 *   - **Rigs** are a shallow hierarchy (hips -> torso -> head, plus 4 limbs), so
 *     posing is a handful of rotations per character per frame instead of a
 *     skinned-mesh evaluation.
 *   - **Animation** is driven straight from the simulation: `Character.stepPhase`
 *     swings the legs, a state machine drives the attack/recovery/stagger/death
 *     poses, and `facing` turns the whole rig. Because the pose is a pure
 *     function of simulation state, animation stays in sync with movement at any
 *     framerate and there is nothing to blend or interpolate.
 *   - **Cost control**: rigs are pooled, animated only within
 *     `quality.animationDistance`, and beyond `quality.zombieLodDistance` they
 *     are replaced by a cheap silhouette (or hidden entirely on Low).
 *
 * The zombie variants differ by proportion, hunch, palette and detail level, so
 * a horde reads as a crowd of different bodies rather than clones of one mesh.
 */

import * as THREE from 'three';
import { clamp, clamp01, lerp } from '@/core/MathUtil';
import type { QualitySettings } from '@/core/Settings';
import type { MaterialLibrary } from '@/render/Materials';
import { ZOMBIES, type ZombieVariant } from '@/config/zombies';
import type { Zombie } from '@/entities/Zombie';
import type { Survivor } from '@/entities/Survivor';

/** Shared box geometry: every limb is a scaled copy of this. */
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1);
const SPHERE = new THREE.SphereGeometry(0.5, 10, 7);

function box(mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(BOX, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  return m;
}

function limb(mat: THREE.Material, sx: number, sy: number, sz: number): THREE.Group {
  // Limbs pivot at their top: the mesh hangs below the group origin, which is
  // what makes a single rotation look like a knee/elbow.
  const g = new THREE.Group();
  const m = box(mat, sx, sy, sz, 0, -sy / 2, 0);
  g.add(m);
  return g;
}

/** One animated body. Owns its Object3D hierarchy and current pose state. */
export class CharacterRig {
  readonly root = new THREE.Group();
  readonly hips = new THREE.Group();
  readonly torso = new THREE.Group();
  readonly neck = new THREE.Group();
  readonly head: THREE.Object3D;
  readonly armL: THREE.Group;
  readonly armR: THREE.Group;
  readonly legL: THREE.Group;
  readonly legR: THREE.Group;
  /** Extra objects that only exist on detailed rigs (jaw, backpack, hair). */
  readonly extras: THREE.Object3D[] = [];

  private materials: THREE.Material[] = [];

  constructor(
    lib: MaterialLibrary,
    opts: {
      skin: number;
      shirt: number;
      pants: number;
      hair?: number;
      accent?: number;
      height: number;
      build?: number;
      hunch?: number;
      detail?: boolean;
      zombie?: boolean;
    },
  ) {
    const height = opts.height;
    const build = opts.build ?? 1;
    const skinMat = lib.plain(opts.skin, { roughness: 0.72 });
    const shirtMat = lib.plain(opts.shirt, { roughness: 0.86 });
    const pantsMat = lib.plain(opts.pants, { roughness: 0.9 });
    const hairMat = lib.plain(opts.hair ?? 0x2a2016, { roughness: 0.95 });
    const accentMat = lib.plain(opts.accent ?? 0x50565c, { roughness: 0.75, metalness: 0.15 });
    this.materials = [skinMat, shirtMat, pantsMat, hairMat, accentMat];

    // Proportions: an L4D body is roughly 7.5 heads tall; the infected are
    // hunched and longer-armed, which is what makes them read as "wrong".
    const headR = height * 0.072;
    const legLen = height * 0.46;
    const torsoH = height * 0.3;
    const torsoW = height * 0.19 * build;
    const torsoD = height * 0.115 * build;
    const armLen = height * 0.34 * (opts.zombie ? 1.08 : 1);

    this.hips.position.y = legLen;
    this.root.add(this.hips);

    // --- legs --------------------------------------------------------------
    const legW = height * 0.075 * build;
    this.legL = limb(pantsMat, legW, legLen, legW);
    this.legL.position.set(-torsoW * 0.28, 0, 0);
    this.legR = limb(pantsMat, legW, legLen, legW);
    this.legR.position.set(torsoW * 0.28, 0, 0);
    this.hips.add(this.legL, this.legR);

    // --- torso -------------------------------------------------------------
    this.torso.position.y = 0;
    this.hips.add(this.torso);
    const chest = box(shirtMat, torsoW * 2, torsoH, torsoD * 2, 0, torsoH * 0.5, 0);
    this.torso.add(chest);
    if (opts.detail) {
      // A jacket/vest layer and a belt: two boxes buy a lot of silhouette.
      const vest = box(accentMat, torsoW * 2.08, torsoH * 0.62, torsoD * 2.1, 0, torsoH * 0.55, 0);
      this.torso.add(vest);
      this.extras.push(vest);
    }

    // --- arms --------------------------------------------------------------
    const armW = height * 0.055 * build;
    this.armL = limb(shirtMat, armW, armLen, armW);
    this.armL.position.set(-torsoW * 1.08, torsoH * 0.94, 0);
    this.armR = limb(shirtMat, armW, armLen, armW);
    this.armR.position.set(torsoW * 1.08, torsoH * 0.94, 0);
    this.torso.add(this.armL, this.armR);
    // Hands.
    for (const [arm, side] of [
      [this.armL, -1],
      [this.armR, 1],
    ] as const) {
      const hand = new THREE.Mesh(SPHERE, skinMat);
      hand.scale.setScalar(armW * 1.1);
      hand.position.set(0, -armLen - armW * 0.4, 0);
      arm.add(hand);
      void side;
    }

    // --- head --------------------------------------------------------------
    this.neck.position.y = torsoH * 1.02;
    this.torso.add(this.neck);
    const neckMesh = new THREE.Mesh(CYL, skinMat);
    neckMesh.scale.set(headR * 0.7, headR * 0.8, headR * 0.7);
    neckMesh.position.y = headR * 0.3;
    this.neck.add(neckMesh);

    const headGroup = new THREE.Group();
    headGroup.position.y = headR * 1.5;
    this.neck.add(headGroup);
    const skull = box(skinMat, headR * 1.7, headR * 2.1, headR * 1.8, 0, headR * 0.2, 0);
    headGroup.add(skull);
    if (opts.detail) {
      const hair = box(hairMat, headR * 1.78, headR * 0.9, headR * 1.86, 0, headR * 0.9, 0);
      headGroup.add(hair);
      this.extras.push(hair);
    }
    // Jaw: animated for screams and death slack.
    const jaw = new THREE.Group();
    jaw.position.set(0, -headR * 0.55, headR * 0.25);
    const jawMesh = box(skinMat, headR * 1.25, headR * 0.55, headR * 1.2, 0, -headR * 0.2, 0);
    jaw.add(jawMesh);
    headGroup.add(jaw);
    this.head = headGroup;

    this.hunch = opts.hunch ?? 0;
    if (this.hunch > 0) {
      // Infected stand folded forward with the head jutting out.
      this.neck.position.z += headR * 1.1 * this.hunch;
      this.neck.position.y -= headR * 0.5 * this.hunch;
      this.torso.rotation.x += this.hunch * 0.35;
      this.armL.rotation.x -= this.hunch * 0.35;
      this.armR.rotation.x -= this.hunch * 0.35;
    }
    // Jaw animation is handled by the owner through `setJaw`.
    void jaw;
    void headR;
  }

  private readonly hunch: number;

  /** Release materials created for this rig (they are per-rig, not cached). */
  dispose(): void {
    for (const m of this.materials) m.dispose();
    this.materials = [];
  }
}

/**
 * Where a rig is in its animation. Kept separate from zombie AI state so the
 * same animator can drive teammates and the death poses of both.
 */
type PoseState = 'idle' | 'walk' | 'run' | 'attack' | 'stagger' | 'death' | 'pinned' | 'crouch';

interface RigSlot {
  rig: CharacterRig | null;
  /** Simple silhouette used past the LOD distance. */
  lod: THREE.Mesh | null;
  variant: ZombieVariant | 'survivor';
  posePhase: number;
  deathT: number;
  deathDir: number;
  active: boolean;
}

export interface RigSpec {
  height: number;
  build: number;
  hunch: number;
  skin: number;
  shirt: number;
  pants: number;
  hair?: number;
  accent?: number;
  zombie: boolean;
}

/** Palette table so a horde still shows variety without extra geometry. */
const ZOMBIE_LOOKS: Record<ZombieVariant, RigSpec> = {
  common: { height: 1.78, build: 1, hunch: 0.18, skin: 0x9a8d76, shirt: 0x4a4a48, pants: 0x33363a, zombie: true },
  common_fast: { height: 1.72, build: 0.86, hunch: 0.34, skin: 0x8d8272, shirt: 0x6b3b34, pants: 0x2e3234, zombie: true },
  common_armoured: { height: 1.84, build: 1.16, hunch: 0.1, skin: 0x8f867a, shirt: 0x3f4a3c, pants: 0x2b2f33, accent: 0x6d6f66, zombie: true },
  hunter: { height: 1.76, build: 0.9, hunch: 0.42, skin: 0xbfa98c, shirt: 0x585048, pants: 0x3a3b3e, zombie: true },
  boomer: { height: 1.7, build: 2.1, hunch: 0.3, skin: 0x8fa06a, shirt: 0x6a6a52, pants: 0x44483a, zombie: true },
  smoker: { height: 1.9, build: 0.78, hunch: 0.5, skin: 0x8a8f6e, shirt: 0x4b4d43, pants: 0x35382f, zombie: true },
  spitter: { height: 1.74, build: 1.05, hunch: 0.36, skin: 0xa89a72, shirt: 0x5c5340, pants: 0x3d3a30, zombie: true },
  jockey: { height: 1.12, build: 0.8, hunch: 0.55, skin: 0xa89478, shirt: 0x6a5a44, pants: 0x3a342c, zombie: true },
  charger: { height: 2.0, build: 1.5, hunch: 0.24, skin: 0xb09a7c, shirt: 0x5a4a3a, pants: 0x2f2a26, zombie: true },
  tank: { height: 2.6, build: 2.8, hunch: 0.2, skin: 0x8c7a63, shirt: 0x6a5240, pants: 0x3c332a, zombie: true },
  witch: { height: 1.68, build: 0.82, hunch: 0.62, skin: 0xd8c8bc, shirt: 0x7a2a32, pants: 0x3a2a2e, hair: 0x241a1a, zombie: true },
};

const SURVIVOR_STYLE: RigSpec = {
  height: 1.8,
  build: 1,
  hunch: 0,
  skin: 0xc09070,
  shirt: 0x4a5a6a,
  pants: 0x2e333a,
  hair: 0x2a2016,
  accent: 0x8a7a58,
  zombie: false,
};

/**
 * Renders and animates every zombie in the EntityManager.
 *
 * The renderer owns the rig pool; the manager owns the simulation. Nothing in
 * here feeds back into gameplay, which keeps the AI deterministic.
 */
export class ZombieRenderer {
  readonly group = new THREE.Group();

  private slots = new Map<number, RigSlot>();
  private free: RigSlot[] = [];
  private quality: QualitySettings;
  private lodMaterial: THREE.MeshStandardMaterial;

  constructor(
    private lib: MaterialLibrary,
    quality: QualitySettings,
  ) {
    this.quality = quality;
    this.group.name = 'zombies';
    this.lodMaterial = lib.plain(0x5c5f57, { roughness: 1 });
  }

  applyQuality(q: QualitySettings): void {
    this.quality = q;
  }

  /** Drop every rig (chapter change). */
  clear(): void {
    for (const [, slot] of this.slots) this.release(slot);
    this.slots.clear();
    this.free.length = 0;
    this.group.clear();
  }

  private release(slot: RigSlot): void {
    if (slot.rig) {
      this.group.remove(slot.rig.root);
      // Rigs are pooled and cheap; the geometry is shared, the materials are
      // per-rig, so keep the rig alive for reuse instead of disposing it.
      slot.rig.root.visible = false;
      this.free.push(slot);
    }
    if (slot.lod) {
      this.group.remove(slot.lod);
      slot.lod.visible = false;
      if (!slot.rig) this.free.push(slot);
    }
  }

  private acquire(variant: ZombieVariant): RigSlot {
    const reused = this.free.pop();
    const spec = ZOMBIE_LOOKS[variant];
    if (reused) {
      if (reused.variant !== variant && reused.rig) {
        // Different body: rebuild rather than hide the mismatch.
        this.group.remove(reused.rig.root);
        reused.rig.dispose();
        reused.rig = null;
      }
      if (!reused.rig) {
        reused.rig = new CharacterRig(this.lib, this.specToOpts(spec));
        this.group.add(reused.rig.root);
      }
      reused.variant = variant;
      reused.rig.root.visible = true;
      return reused;
    }
    const slot: RigSlot = {
      rig: new CharacterRig(this.lib, this.specToOpts(spec)),
      lod: null,
      variant,
      posePhase: Math.random() * Math.PI * 2,
      deathT: -1,
      deathDir: 0,
      active: true,
    };
    this.group.add(slot.rig!.root);
    return slot;
  }

  private specToOpts(spec: RigSpec) {
    return {
      skin: spec.skin,
      shirt: spec.shirt,
      pants: spec.pants,
      hair: spec.hair,
      accent: spec.accent,
      height: spec.height,
      build: spec.build,
      hunch: spec.hunch,
      zombie: spec.zombie,
      detail: this.quality.detailGeometry && spec.height > 1.5,
    };
  }

  /**
   * Sync the rig pool with the live entity list and pose everything.
   * Called once per rendered frame (not per simulation step).
   */
  update(zombies: readonly Zombie[], dt: number, cameraPos: THREE.Vector3): void {
    const t = performance.now() / 1000;
    let animBudget = this.quality.maxAnimatedZombies;

    // Retire slots whose zombie is gone.
    for (const [id, slot] of this.slots) {
      let alive = false;
      for (const z of zombies) {
        if (z.id === id) {
          alive = true;
          break;
        }
      }
      if (!alive) {
        this.release(slot);
        this.slots.delete(id);
      }
    }

    for (const z of zombies) {
      const d = Math.hypot(z.position.x - cameraPos.x, z.position.z - cameraPos.z);

      if (!z.alive) {
        // Corpses: a short fall, then fade out of the render list.
        let slot = this.slots.get(z.id);
        if (!slot) {
          slot = this.acquire(z.variant);
          slot.deathT = 0;
          slot.deathDir = (Math.random() - 0.5) * 1.2;
          this.slots.set(z.id, slot);
        }
        slot.deathT += dt;
        if (slot.deathT > 9) {
          this.release(slot);
          this.slots.delete(z.id);
          continue;
        }
        this.poseCorpse(slot, z, d);
        continue;
      }

      const tooFar = d > this.quality.zombieLodDistance;
      if (tooFar && this.quality.tier === 'low') {
        const slot = this.slots.get(z.id);
        if (slot) {
          this.release(slot);
          this.slots.delete(z.id);
        }
        continue;
      }

      let slot = this.slots.get(z.id);
      if (!slot) {
        slot = this.acquire(z.variant);
        this.slots.set(z.id, slot);
      }

      const animate = d < this.quality.animationDistance && animBudget > 0;
      if (animate) animBudget--;

      if (slot.rig) {
        slot.rig.root.visible = !tooFar || this.quality.tier !== 'low';
        this.poseZombie(slot, z, t, animate);
      }
      // Low quality swaps far zombies for a silhouette.
      if (this.quality.tier === 'low' && tooFar) this.ensureLod(slot);
      else if (slot.lod) slot.lod.visible = false;
    }
  }

  private ensureLod(slot: RigSlot): void {
    if (!slot.lod) {
      slot.lod = new THREE.Mesh(BOX, this.lodMaterial);
      this.group.add(slot.lod);
    }
    slot.lod.visible = true;
  }

  private poseZombie(slot: RigSlot, z: Zombie, time: number, animate: boolean): void {
    const rig = slot.rig!;
    rig.root.position.set(z.position.x, z.position.y, z.position.z);
    rig.root.rotation.y = z.facing;

    if (slot.lod) {
      slot.lod.visible = true;
      slot.lod.position.set(z.position.x, z.position.y + 0.9, z.position.z);
      slot.lod.scale.set(0.7, 1.8, 0.5);
      slot.lod.rotation.y = z.facing;
    }
    if (!animate) return;

    const speed = Math.hypot(z.velocity.x, z.velocity.z);
    const state = z.state;
    const def = ZOMBIES[z.variant];

    let pose: PoseState = 'idle';
    if (state === 'chase' || state === 'wander' || state === 'fleeing') pose = speed > 3.4 ? 'run' : 'walk';
    else if (state === 'attack' || state === 'windup') pose = 'attack';
    else if (state === 'stagger' || state === 'grabbed') pose = 'stagger';
    else if (state === 'pouncing' || state === 'charging' || state === 'riding') pose = 'run';
    else if (state === 'pinned' || state === 'vomiting' || state === 'talking') pose = 'attack';
    else if (state === 'spawning') pose = 'crouch';

    void def;
    // Step phase comes from the simulation, so feet match the ground speed.
    slot.posePhase = z.stepPhase;

    const swing = Math.sin(slot.posePhase);
    const swing2 = Math.cos(slot.posePhase);
    const amp = pose === 'run' ? 0.85 : pose === 'walk' ? 0.5 : 0.08;

    rig.legL.rotation.x = swing * amp;
    rig.legR.rotation.x = -swing * amp;
    rig.armL.rotation.x = -swing * amp * 0.55;
    rig.armR.rotation.x = swing * amp * 0.55;
    rig.armL.rotation.z = 0.12;
    rig.armR.rotation.z = -0.12;

    // Bob + lean: the body drops on each footfall.
    const bob = Math.abs(swing2) * amp * 0.055;
    rig.root.position.y = z.position.y + bob;
    rig.hips.rotation.z = swing * amp * 0.06;
    rig.torso.rotation.y = -swing * amp * 0.12;
    rig.torso.rotation.x = -0.04 + (pose === 'run' ? -0.14 : 0);

    switch (pose) {
      case 'attack': {
        // Reach: both arms forward, jaw open, body lurching.
        const windup = state === 'windup' ? 1 : state === 'attack' ? 0 : 0.5;
        const reach = state === 'attack' ? 1 : 0.35 + windup * 0.3;
        rig.armL.rotation.x = -2.1 * reach;
        rig.armR.rotation.x = -2.1 * reach;
        rig.torso.rotation.x = -0.28 * reach;
        this.setJaw(rig, 0.35 + reach * 0.5);
        break;
      }
      case 'stagger': {
        const s = clamp01(Math.sin(time * 22) * 0.5 + 0.5);
        rig.torso.rotation.x = 0.25 + s * 0.15;
        rig.armL.rotation.x = 0.6;
        rig.armR.rotation.x = 0.55;
        rig.head.rotation.z = s * 0.25;
        this.setJaw(rig, 0.2);
        break;
      }
      case 'crouch': {
        rig.hips.position.y *= 0.82;
        rig.legL.rotation.x = -0.5;
        rig.legR.rotation.x = -0.5;
        this.setJaw(rig, 0.5);
        break;
      }
      case 'idle':
      case 'walk':
      case 'run':
      default: {
        // Breathing + a slack jaw on idle keeps corpses-to-be from looking frozen.
        const breathe = Math.sin(time * 1.6 + z.id) * 0.015;
        rig.torso.rotation.x += breathe;
        this.setJaw(rig, pose === 'run' ? 0.25 : 0.12);
        break;
      }
    }
  }

  private setJaw(rig: CharacterRig, amount: number): void {
    // The jaw is the third child of the neck group; grabbing it lazily keeps the
    // rig constructor cheap.
    const jaw = rig.head.children[rig.head.children.length - 1];
    if (jaw) jaw.rotation.x = amount * 0.5;
  }

  private poseCorpse(slot: RigSlot, z: Zombie, d: number): void {
    const rig = slot.rig!;
    const fall = clamp01(slot.deathT / 0.55);
    const ease = 1 - (1 - fall) * (1 - fall);
    // Toppling: rotate about the hips and let the body settle.
    rig.root.position.set(z.position.x, z.position.y, z.position.z);
    rig.root.rotation.y = z.facing + slot.deathDir;
    rig.hips.rotation.x = ease * Math.PI * 0.46;
    rig.hips.position.y = lerp(rig.hips.position.y, 0.24, ease);
    rig.torso.rotation.x = ease * 0.35;
    rig.armL.rotation.x = ease * 0.9;
    rig.armR.rotation.x = ease * 0.7;
    rig.legL.rotation.x = ease * 0.4;
    rig.legR.rotation.x = ease * 0.25;
    if (slot.lod) slot.lod.visible = false;
    void d;
    if (slot.deathT > 6) {
      // Fade the corpse out so a long chapter does not fill the level with bodies.
      const fade = clamp01((slot.deathT - 6) / 3);
      rig.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          const mat = mesh.material as THREE.Material & { opacity: number; transparent: boolean };
          if (!mat.transparent) mat.transparent = true;
          mat.opacity = 1 - fade;
        }
      });
    }
  }
}

/** Renders the AI teammates (and optionally the player's own shadow proxy). */
export class SurvivorRenderer {
  readonly group = new THREE.Group();
  private rigs = new Map<number, { rig: CharacterRig; phase: number; look: RigSpec }>();

  constructor(
    private lib: MaterialLibrary,
    private quality: QualitySettings,
  ) {
    this.group.name = 'survivors';
  }

  applyQuality(q: QualitySettings): void {
    this.quality = q;
  }

  clear(): void {
    for (const [, entry] of this.rigs) {
      this.group.remove(entry.rig.root);
      entry.rig.dispose();
    }
    this.rigs.clear();
    this.group.clear();
  }

  sync(survivors: readonly Survivor[], dt: number, time: number): void {
    const seen = new Set<number>();
    for (const s of survivors) {
      if (s.isPlayer) continue;
      seen.add(s.id);
      let entry = this.rigs.get(s.id);
      if (!entry) {
        const look: RigSpec = { ...SURVIVOR_STYLE, shirt: 0x3f5a6a, accent: 0x7a6a4a };
        entry = { rig: new CharacterRig(this.lib, this.specToOpts(look)), phase: 0, look };
        this.rigs.set(s.id, entry);
        this.group.add(entry.rig.root);
      }
      const rig = entry.rig;
      rig.root.visible = s.alive;
      if (!s.alive) continue;

      const speed = Math.hypot(s.velocity.x, s.velocity.z);
      const moving = speed > 0.4;
      entry.phase += dt * (2.2 + speed * 1.6);
      const amp = clamp(speed / 4.6, 0, 1) * 0.8;
      const swing = Math.sin(entry.phase);
      const swing2 = Math.cos(entry.phase);

      rig.root.position.set(s.position.x, s.position.y + (moving ? Math.abs(swing2) * amp * 0.05 : 0), s.position.z);
      rig.root.rotation.y = s.facing;
      rig.legL.rotation.x = swing * amp;
      rig.legR.rotation.x = -swing * amp;
      // Aim: the AI's arms point where it is looking (a two-handed grip).
      const aiming = speed < 1.2;
      if (aiming) {
        rig.armL.rotation.x = -1.35;
        rig.armR.rotation.x = -1.3;
        rig.armL.rotation.z = 0.28;
        rig.armR.rotation.z = -0.34;
      } else {
        rig.armL.rotation.x = -swing * amp * 0.5 - 0.5;
        rig.armR.rotation.x = swing * amp * 0.5 - 0.9;
        rig.armL.rotation.z = 0.12;
        rig.armR.rotation.z = -0.2;
      }
      rig.hips.rotation.z = swing * amp * 0.05;
      rig.torso.rotation.y = -swing * amp * 0.1;
      rig.torso.rotation.x = -0.05;

      if (s.incapacitated) {
        // Down on one knee, pistol up.
        rig.hips.position.y = 0.62;
        rig.legL.rotation.x = -1.2;
        rig.legR.rotation.x = 0.6;
        rig.torso.rotation.x = 0.15;
      } else {
        rig.hips.position.y = 1.8 * 0.46;
      }

      if (s.dead) rig.root.visible = false;
      void time;
    }

    for (const [id, entry] of this.rigs) {
      if (!seen.has(id)) {
        this.group.remove(entry.rig.root);
        entry.rig.dispose();
        this.rigs.delete(id);
      }
    }
  }

  private specToOpts(spec: RigSpec) {
    return {
      skin: spec.skin,
      shirt: spec.shirt,
      pants: spec.pants,
      hair: spec.hair,
      accent: spec.accent,
      height: spec.height,
      build: spec.build,
      hunch: spec.hunch,
      zombie: false,
      detail: this.quality.detailGeometry,
    };
  }
}
