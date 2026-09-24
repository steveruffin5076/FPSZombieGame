/**
 * NOISE BUS
 * =========
 * Gunfire, explosions, doors and footsteps emit gameplay *noise* — a separate
 * concept from audio. Infected hear noise (see `entities/Zombie.ts`) and walk
 * toward it, which is what makes suppsressed weapons and melee meaningful.
 *
 * Implemented as a tiny ring buffer so the AI can consume every event that
 * happened since its last update, with no allocation per frame.
 */
import * as THREE from 'three';

export interface NoiseEvent {
  x: number;
  y: number;
  z: number;
  /** How far the sound travels (metres). Louder = larger. */
  loudness: number;
  /** Gameplay time the noise was made. */
  time: number;
  /** What made the noise (used for AI flavour + HUD). */
  source: 'gunshot' | 'explosion' | 'melee' | 'footstep' | 'door' | 'voice' | 'alarm' | 'glass' | 'zombie';
}

class NoiseBus {
  private events: NoiseEvent[] = [];
  /** Global multiplier (killed by the "silent" difficulty modifier). */
  scale = 1;
  /** Time (game seconds) of the most recent event — drives the HUD noise meter. */
  lastEventTime = -999;

  emit(position: THREE.Vector3, loudness: number, source: NoiseEvent['source'] = 'gunshot', time = 0): void {
    if (loudness <= 0.5) return;
    this.events.push({
      x: position.x,
      y: position.y,
      z: position.z,
      loudness: loudness * this.scale,
      time,
      source,
    });
    this.lastEventTime = time;
    // Cap the buffer: a horde fight can emit hundreds of events per second.
    if (this.events.length > 64) this.events.splice(0, this.events.length - 64);
  }

  /** Copy and clear pending events (called once per AI update). */
  consume(out: NoiseEvent[]): NoiseEvent[] {
    out.length = 0;
    for (const e of this.events) out.push(e);
    this.events.length = 0;
    return out;
  }

  get pending(): number {
    return this.events.length;
  }

  clear(): void {
    this.events.length = 0;
  }
}

export const noise = new NoiseBus();
