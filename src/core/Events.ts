/**
 * Strongly-typed, allocation-light event bus.
 *
 * This is the primary decoupling seam of the codebase: the Director, HUD, audio
 * mixer and analytics all react to gameplay events instead of holding direct
 * references to each other. It is deliberately shaped like a message channel
 * (`emit` / `addListener`) so that `NetAdapter` can mirror the same events over
 * a WebSocket / WebRTC DataChannel without touching gameplay code.
 */

/** Emit/listen helpers are generated from this map; every payload is plain data. */
export interface GameEvents {
  // --- lifecycle -----------------------------------------------------------
  'game:state': { state: string; previous: string };
  'chapter:start': { chapterIndex: number; name: string };
  /** Quality tier changed (menu or the adaptive controller). */
  'quality-changed': { tier: string };
  'chapter:complete': { chapterIndex: number; stats: ChapterStats };
  'campaign:complete': { stats: ChapterStats };
  'soundtrack:mood': { mood: 'calm' | 'tension' | 'combat' | 'panic' | 'relief' | 'horror' };

  // --- player --------------------------------------------------------------
  'player:damaged': { amount: number; health: number; source: string; direction: number };
  'player:incapacitated': Record<string, never>;
  'player:revived': Record<string, never>;
  'player:died': { cause: string };
  'player:healed': { amount: number; health: number };
  'player:pill': { health: number };
  'player:hurtSound': { kind: 'light' | 'heavy' };

  // --- weapons -------------------------------------------------------------
  'weapon:fire': { weaponId: string; position: [number, number, number]; suppressor: boolean };
  'weapon:dry': { weaponId: string };
  'weapon:reloadStart': { weaponId: string; duration: number; empty: boolean; tactical: boolean };
  'weapon:reloadEnd': { weaponId: string };
  'weapon:switch': { weaponId: string; slot: string };
  'weapon:melee': { weaponId: string };
  'weapon:throw': { kind: 'pipebomb' | 'molotov' | 'bile' };
  'impact': { surface: string; position: [number, number, number]; loudness: number };

  // --- zombies -------------------------------------------------------------
  'zombie:spawned': { variant: string };
  'zombie:killed': { variant: string; headshot: boolean; overkill: number };
  'zombie:hit': { variant: string; damage: number; headshot: boolean };
  'special:attack': { variant: string; target: string };
  'special:cue': { variant: string; distance: number };
  'boomer:explode': { position: [number, number, number] };
  'horde:start': { source: 'director' | 'crescendo' | 'alarm' | 'boomer'; size: number };
  'horde:end': Record<string, never>;

  // --- survivors -----------------------------------------------------------
  'survivor:damaged': { id: number; name: string; health: number };
  'survivor:incapacitated': { id: number; name: string };
  'survivor:revived': { id: number; name: string };
  'survivor:died': { id: number; name: string };
  'survivor:reviveProgress': { id: number; progress: number };
  'survivor:voice': { id: number; name: string; line: string; duration: number };
  'survivor:pickup': { id: number; item: string };

  // --- director ------------------------------------------------------------
  'director:intensity': { level: number; mood: string; label: string };
  'director:event': { kind: string; description: string };
  'director:itemDrop': { item: string };

  // --- world ---------------------------------------------------------------
  'door:open': { id: number };
  'door:locked': { id: number; message: string };
  'level:objective': { text: string };
  'level:safeRoomReached': { chapterIndex: number };
  'breakable:broken': { position: [number, number, number] };
  'trigger:crescendo': { name: string };
}

export type EventName = keyof GameEvents;

/** Aggregate end-of-chapter statistics (also the payload of a future scoreboard RPC). */
export interface ChapterStats {
  chapterIndex: number;
  chapterName: string;
  kills: number;
  headshots: number;
  specialsKilled: number;
  damageDealt: number;
  damageTaken: number;
  friendlyFire: number;
  shotsFired: number;
  shotsHit: number;
  accuracy: number;
  itemsUsed: number;
  revives: number;
  timesIncapacitated: number;
  timeSeconds: number;
  distanceTravelled: number;
  deaths: number;
  survivorsSurvived: number;
}

type Listener<K extends EventName> = (payload: GameEvents[K]) => void;

interface Sub {
  fn: (payload: unknown) => void;
  once: boolean;
  /** Set to true while iterating so `off()` during dispatch is safe. */
  dead: boolean;
}

export class EventBus {
  private map = new Map<string, Sub[]>();
  /** Rolling log of the most recent events — invaluable when debugging Director bugs. */
  readonly history: { name: string; payload: unknown; t: number }[] = [];
  historyLimit = 200;

  on<K extends EventName>(name: K, fn: Listener<K>): () => void {
    return this.addListener(name, fn, false);
  }

  once<K extends EventName>(name: K, fn: Listener<K>): () => void {
    return this.addListener(name, fn, true);
  }

  private addListener<K extends EventName>(name: K, fn: Listener<K>, once: boolean): () => void {
    let list = this.map.get(name);
    if (!list) {
      list = [];
      this.map.set(name, list);
    }
    const sub: Sub = { fn: fn as (p: unknown) => void, once, dead: false };
    list.push(sub);
    return () => {
      sub.dead = true;
    };
  }

  off<K extends EventName>(name: K, fn: Listener<K>): void {
    const list = this.map.get(name);
    if (!list) return;
    for (const s of list) if (s.fn === fn) s.dead = true;
  }

  emit<K extends EventName>(name: K, payload: GameEvents[K]): void {
    if (this.historyLimit > 0) {
      this.history.push({ name, payload, t: performance.now() });
      if (this.history.length > this.historyLimit) this.history.shift();
    }
    const list = this.map.get(name);
    if (!list || list.length === 0) return;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.dead) continue;
      try {
        s.fn(payload);
      } catch (err) {
        // A misbehaving listener must never take down the frame loop.
        console.error(`[EventBus] listener for "${name}" threw:`, err);
      }
      if (s.once) s.dead = true;
    }
    // Compact dead subscriptions lazily.
    if (list.length > 8 && list.some((s) => s.dead)) {
      this.map.set(
        name,
        list.filter((s) => !s.dead),
      );
    }
  }

  /** Remove every listener (used on campaign restart to avoid leaks). */
  clear(): void {
    this.map.clear();
  }
}

/** Process-wide bus. Systems that need isolation (tests) can build their own. */
export const bus = new EventBus();
