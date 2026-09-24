/**
 * Entity-level shared contracts.
 *
 * Declared separately from the implementations so `Zombie`, `Survivor`, the
 * Director and the HUD can all agree on the shape of a combatant without
 * importing each other (no circular imports, and a clean seam for the future
 * networked client/server split).
 */
import type * as THREE from 'three';
import type { Damageable, DamageOptions } from '@/core/Types';
import type { ZombieVariant } from '@/config/zombies';

export type ZombieState =
  | 'spawning'
  | 'idle'
  | 'wander'
  | 'chase'
  | 'windup'
  | 'attack'
  | 'stagger'
  | 'pinned'
  | 'pouncing'
  | 'charging'
  | 'vomiting'
  | 'talking'
  | 'riding'
  | 'grabbed'
  | 'fleeing'
  | 'dormant'
  | 'dead';

/** Anything an infected can pin, ride or drag. */
export interface SurvivorEntity extends Damageable {
  readonly isPlayer: boolean;
  readonly name: string;
  health: number;
  maxHealth: number;
  tempHealth: number;
  incapacitated: boolean;
  /** True once the bleed-out timer expires or permadeath triggers. */
  dead: boolean;
  /** The infected currently holding this survivor hostage. */
  pinnedBy: ZTarget | null;
  /** Being ridden (Jockey) or dragged (Smoker). */
  pinBy(attacker: ZTarget, kind: 'pounce' | 'tongue' | 'ride'): void;
  releasePin(reason: 'rescued' | 'killed' | 'died' | 'escaped'): void;
  isBeingRevived: boolean;
  reviveProgress: number;
  /** Index of the navigation flow field this survivor is assigned to. */
  flowSlot: number;
  /** Yaw the survivor is facing (the AI aims with this; the player uses the camera). */
  facing: number;
  /** Human-readable cause for the death screen ("" while alive). */
  causeOfDeath: string;
}

/** Minimal view of a zombie that survivors need. */
export interface ZTarget extends Damageable {
  readonly variant: ZombieVariant;
  readonly special: boolean;
  /** Health ceiling — writable so the Director can scale it per difficulty. */
  maxHealth: number;
  health: number;
  readonly state: ZombieState;
  /** Whether a melee attack can instantly kill this infected. */
  readonly canBeInstakilled: boolean;
  /** Apply a stagger of `seconds` (ignored by the Tank). */
  stagger(seconds: number, source?: THREE.Vector3): void;
  /** True while the infected is holding a survivor. */
  isPinning: boolean;
  /** The survivor this infected is currently holding, if any. */
  pinnedSurvivor: SurvivorEntity | null;
}

export interface CombatContext {
  time: number;
  dt: number;
  /** Every living survivor (player + AI). */
  survivors: SurvivorEntity[];
  /** The survivor the Director considers the squad centre. */
  lead: SurvivorEntity;
  /** Global multiplier on infected damage output. */
  zombieDamage: number;
  /** Global multiplier on infected health. */
  zombieHealth: number;
  /** Whether friendly fire between survivors is enabled. */
  friendlyFire: boolean;
}

/** Simplified damage callback so entities never touch stats/UI directly. */
export interface CombatEvents {
  onZombieKilled(
    z: ZTarget,
    opts: {
      headshot: boolean;
      /** Whoever landed the killing blow (may be null: fire, falls, scripted). */
      attacker: Damageable | null;
      /** Damage of the killing blow, for the end-of-chapter statistics. */
      damage: number;
    },
  ): void;
  onZombieSpawned(z: ZTarget): void;
  /**
   * Every landed hit on an infected, *before* the kill notification. Optional:
   * the headless harness uses it for shot-accuracy statistics and a future
   * damage-number/telemetry pass can hang off the same hook.
   */
  onZombieHit?(z: ZTarget, opts: { damage: number; headshot: boolean; attacker: Damageable | null }): void;
  onSurvivorDowned(s: SurvivorEntity, attacker: ZTarget | null): void;
  onSurvivorDied(s: SurvivorEntity, attacker: ZTarget | null): void;
  onSurvivorDamaged(s: SurvivorEntity, amount: number, source: THREE.Vector3 | undefined): void;
  onPin(s: SurvivorEntity, z: ZTarget): void;
  onUnpin(s: SurvivorEntity, z: ZTarget, rescued: boolean): void;
  onAbility(z: ZTarget, kind: string, target?: SurvivorEntity): void;
  /** Damage routed to the level (doors, breakables). */
  onDoorDamage(id: number, amount: number): void;
  applyDamage(target: Damageable, amount: number, opts: DamageOptions): void;
}
