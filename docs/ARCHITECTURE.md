# Architecture

A tour of the runtime, in the order a frame touches it. For the module-by-module map and the
diagram, see the [README](../README.md#architecture).

---

## 1. Boot and the frame

```
main.ts
  ├─ WebGL2 capability check          → friendly "unsupported" panel if missing
  ├─ Engine.boot()                    → construct systems, attach listeners
  ├─ progress callbacks               → #boot-bar
  └─ hide splash on 'chapter:start'
```

`Engine` owns one `GameLoop` (`core/Loop.ts`):

- **Fixed simulation step**, 1/60 s, with at most 5 catch-up steps per frame. Rendering
  interpolates nothing, but the simulation is frame-rate independent, which matters for
  determinism in the harnesses.
- **Pause on visibility loss**, and on `Esc` (the pause menu is the source of truth for
  `Engine.state`).

Simulation order inside one step:

```
1. input.beginFrame()        (collect deltas; wheel/pointer-lock edges)
2. player.step()             (look → movement → weapons → interaction → camera)
3. teammates.update()        (decide → move → engage → talk → regroup leash)
4. entities.update()         (zombie AI, projectiles, explosions, hazards)
5. director.update()         (intensity → mood → budgets → spawns → events)
6. level.update()            (doors, breakables, lights, trigger volumes, hazards)
7. items.update()            (pickups, restock, streamed loot)
8. engine.updateSafeRoom()   (all-inside check → restock → chapter complete)
9. renderer.render()         (scene → post → HUD draws from bus state)
```

Everything downstream of step 1 reads or writes plain data; nothing in the loop allocates
in steady state.

---

## 2. Player and weapons

`Player` is the only class that owns a camera transform. It reads `input.lookDelta()`
(already in radians, already sensitivity-scaled) and drives:

- **Movement** through `Character` (`physics/Character.ts`) — a capsule against the collision
  world with step-up, ramp support, coyote time, crouch clearance and a void guard.
- **Recoil** as a damped spring (`applyRecoil`, `RECOIL_STIFF/ZETA`). Weapon configs express
  recoil in *degrees*; the spring works in radians, and the impulse is scaled by `√stiffness`
  so a 0.6° kick produces roughly a 0.7° muzzle climb.
- **Velocity-derived spread**, view bob, landing dip, lean and shake.

`WeaponSystem` is a small state machine over four slots (primary, secondary, melee,
throwable):

```
tryFire ──> canFire? ──> fire() ──> per pellet: applySpread → castBullet → onEntityHit
   │                        │
   │                        └─ bloom += spreadPerShot, kick, flash, tracer, sound
   ├─ dry → click + auto-reload
   └─ semi-auto requires a fresh press (automatic weapons hold)
```

`castBullet` (`weapons/Ballistics.ts`) walks the ray through entity and world hits, supports
penetration depth, falls off with distance, applies hit-zone multipliers, and routes damage
through `takeDamage`. Two policies live there because they are properties of bullets, not of
call sites: **friendly fire** (a survivor hit with the setting off takes 0) and **finite
damage** (a non-finite result is clamped to 0 rather than poisoning a health value).

Inventory, ammo pools (shared per ammo type, as in the genre), healing items, pickups and
restock-on-safe-room are all in the same module.

---

## 3. Entities and AI

`EntityManager` owns zombies, survivors, projectiles and the spatial hash. Zombie AI is a
small behaviour tree (`Zombie.update`): dormant → chase → attack, plus variant-specific
abilities (pounce, pin, tongue grab, charge, ride, spit, throw, enrage). Perception is
cone + hearing based; `world/Noise.ts` accumulates footstep/gunfire noise into a small queue
that the zombies consume, so a sprinting survivor genuinely pulls the horde.

`TeammateAI` is utility-based:

| Candidate goal | Score inputs |
| --- | --- |
| Engage | threat size, distance, weapon range, personality aggression |
| Rescue | is a teammate pinned, distance, line of sight |
| Revive | downed teammate, bleed-out timer, danger at the body |
| Heal | own health, recent damage, contact state |
| Throw | cluster size, chokepoint, remaining throwables |
| Follow / spread | distance to lead, squad clustering, crossfire risk |
| Retreat | own health, threat count, cover direction |

Movement reuses `Character` and the nav grid's flow fields (one per survivor, rebuilt
round-robin every 0.12 s) — the field is rooted at whoever is leading, so teammates path
through doorways the player has just used instead of hugging a straight line.

---

## 4. World

`Level.load(chapter)` runs the whole pipeline:

```
generator → nav bake → batch geometry → doors → breakables → lights → decals → loaded = true
```

- `Generator` (`world/Generator.ts`) lays out terrain, roads with lane markings, sidewalks,
  buildings with interiors and furniture, stairs and ramps, overpasses, fences and props,
  then bakes everything into per-material batched geometry (`render/Batcher.ts`).
- `NavGrid` (`world/Nav.ts`) bakes a walkable cell/layer grid with clearance checks, then
  answers `nodeAt`, `flowDirection`, `randomPointNear` and reachability queries. Four flow
  fields serve the survivors; a fifth reserved slot (`FLOW_SLOT_OBJECTIVE`) exists so tooling
  (and a future "follow the objective" AI mode) can path to a fixed point.
- The runtime half of `Level` owns doors (open/close/lock/break, animation, collider
  toggling), breakables (damage, destruction, explosive barrels, melee-smashable barricades),
  the light budget, trigger volumes (safe room, ambush, crescendo, alarms), the objective
  marker and route progress samples.

`Level.loaded` gates `update()`, `applyQuality()` and `objectiveMarker()`. It is set at the
end of `load()`; forgetting it silently disables doors, triggers and the HUD compass, which
is exactly the kind of bug the headless harnesses exist to catch.

---

## 5. Director

See the README section for the mood machine. Structurally the Director is:

```
input:  squad state (health, downs, positions), level progress, contact metrics
core:   scoreIntensity() → chooseMood() → budget accrual → spendCredit()
output: spawns (anchors, caps, culling), item drops, scripted events, bus signals
```

It never touches entities directly for anything other than spawning and retiring; it emits
`director:intensity`, `director:event` and `director:itemDrop`, and the HUD, the music
director and the mission text all listen.

---

## 6. Rendering

- `Renderer` owns the scene, camera, fog/grade, post-processing (vignette, grain, grade,
  minimal bloom) and shadow cascades; `applyQuality` reconfigures it live.
- `MaterialLibrary` builds every surface from `ProceduralTextures`, keeping a small cache so
  a reload never re-generates canvases.
- `Batcher` merges static geometry per material key; dynamic props are separate meshes.
- `Characters.ts` builds and animates the first-person view model, zombie rigs and survivor
  rigs procedurally; hit zones come from the same data the animation uses, so what you see is
  what you shoot.
- `vfx/Effects.ts` is a pooled particle/decal/tracer system with per-effect budgets that scale
  with the quality preset.

---

## 7. Audio

`AudioSystem` is a synthesis engine: a small graph per sound (oscillator/noise + filter +
envelope), positional gain from the listener transform, and a voice cap that drops the quietest
sources first. `MusicDirector` layers six moods (calm → tense → combat → horde → finale →
relief) and crossfades them from Director intensity, so the score rises and falls with the
pacing rather than with scripted music cues.

---

## 8. UI

`Hud` renders to its own canvas layer above the 3D view: health/temp health, teammate bars,
ammo and weapon, crosshair with dynamic spread, hit markers, damage direction, minimap,
objective marker, interaction prompts, toasts and a deliberately subtle Director intensity
indicator. `Menus` owns the main menu, pause, settings (sensitivity, volume, FOV, graphics
preset, gore, friendly fire), death screen and the end-of-chapter statistics panel fed from
`ChapterStats`.

---

## 9. Testing strategy

Because there is no browser in CI, correctness is enforced by three tools:

1. **`npm run typecheck`** — strict TypeScript, no unused locals or parameters.
2. **`npm run check:levels`** — generates all five chapters and asserts geometry/nav/item
   health, printing warnings where generation is imperfect.
3. **`npm run sim`** — runs the real gameplay stack headlessly with a scripted player and
   asserts: route progress, chapter completion, kill/down/revive counts, Director mood
   distribution, and *no non-finite state anywhere* (exit code 2).

The sim is the closest thing this project has to a player, and it has already earned its
keep: the NaN friendly-fire cascade, the never-completing reload and the unreachable-objective
bugs were all found by it rather than by reading code.
