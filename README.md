# DEADLIGHT

A realistic first-person zombie-survival shooter that runs in the browser — inspired by
*Left 4 Dead*. Four survivors, an AI Director that paces the horror, special infected with
distinct tells, a five-chapter campaign that ends in a locked safe room, and three AI
teammates who actually help.

Everything is generated at runtime: there is no art to download. Geometry, textures, audio
and animations are all procedural, which is why the whole game is ~350 kB of JavaScript
(111 kB gzipped) plus three.js.

```
npm install
npm run dev        # http://localhost:5173
```

---

## Contents

- [What is in the box](#what-is-in-the-box)
- [Tech stack (and why)](#tech-stack-and-why)
- [How to run](#how-to-run)
- [Controls](#controls)
- [Architecture](#architecture)
- [The AI Director](#the-ai-director)
- [AI teammates](#ai-teammates)
- [Special infected](#special-infected)
- [Content and balance configuration](#content-and-balance-configuration)
- [Procedural assets and provenance](#procedural-assets-and-provenance)
- [Performance](#performance)
- [Development tooling](#development-tooling)
- [Known issues and next steps](#known-issues-and-next-steps)
- [Multiplayer roadmap](#multiplayer-roadmap)

---

## What is in the box

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Core FPS: movement, camera, shooting, ballistics, a generated level, common zombies | done |
| 2 | 15 weapons, inventory/slots, health + temp health, melee, throwables, healing, pickups | done |
| 3 | Three AI teammates: pathfinding, engagement, revives, healing, throwables, callouts | done |
| 4 | Special infected (Boomer, Hunter, Smoker, Spitter, Charger, Jockey, Tank, Witch) + the Director | done |
| 5 | Five chapters, safe rooms, campaign progression, end-of-chapter stats | done |
| 6 | Audio, VFX, HUD/menus, quality presets, balancing, optimisation, docs | done |

**Campaign.** Five chapters — *Dead Awakening*, *The Undercity*, *Chapel Stairs*,
*Downtown Storm*, *Deadlight Dawn* — each a generated level with a route, scripted events
(ambushes, crescendos, gauntlets, Tank fights) and a safe room at the end. Reaching the safe
room restocks the squad, fully heals everyone and advances the chapter.

**Difficulties.** Easy, Normal, Hard, Expert. Every multiplier (infected health, damage,
Director budgets, item density) lives in `src/core/Settings.ts` and `src/director/DirectorConfig.ts`.

---

## Tech stack (and why)

| Choice | Reason |
| --- | --- |
| **TypeScript 5.9, strict** | A game of this size is a systems problem: 40+ modules with hard contracts. `strict` + `noUnusedLocals` caught real bugs (see the reload-state bug in the commit log). |
| **three.js 0.180 (WebGL2)** | Best-supported browser renderer with a mature material/shadow/instancing pipeline, small enough to ship as one chunk. WebGL2 is available on ~97 % of active browsers; WebGPU is not yet universal enough to be the only path. |
| **Vite 7** | Instant HMR for a 200 ms edit-run loop, and a production build that is a single `vite build`. |
| **Procedural everything** | No asset pipeline, no download, no licences to audit. Levels are deterministic from a seed, so a chapter is the same on every machine. |
| **AudioContext synthesis** | Weapon reports, zombie moans, impacts and the adaptive score are synthesised in `src/audio/` — a multi-mood score with zero audio files. |
| **esbuild (dev only)** | The headless harnesses (`npm run sim`, `npm run check:levels`) run the real gameplay stack in Node. |

Why not Unity/Godot/Unreal? The brief asked for a browser game. Of the browser-native
options, **three.js + a hand-written engine** was chosen over Babylon.js or PlayCanvas
because the interesting work here is the Director, the AI and the feel of the guns, not
scene-graph plumbing — and two-way WebGL2 with instanced batching is enough for the draw
budget (see [Performance](#performance)).

---

## How to run

```bash
npm install          # three.js + dev tooling
npm run dev          # dev server on 0.0.0.0:5173
npm run build        # typecheck + production bundle into dist/
npm run preview      # serve the production build on :4173
npm run typecheck    # tsc --noEmit
```

Development-only diagnostics (no browser needed):

```bash
npm run check:levels              # generate every chapter, report nav/geometry/item health
npm run sim -- 0 normal 600       # 10 simulated minutes of chapter 1 with a scripted player
npm run sim -- 3 hard 900 --debug  # verbose trace of chapter 4
```

Requires Node 20+ and a WebGL2 browser. `node_modules/` is not committed: run `npm install`
after a fresh clone.

---

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| `Shift` | Sprint (no shooting while sprinting) |
| `Ctrl` / `C` | Crouch |
| Mouse | Look |
| Left mouse | Fire |
| Right mouse | Aim down sights (scoped weapons zoom) |
| `R` | Reload (empty-mag reload is slower than a tactical one) |
| `1` `2` `3` `4` | Primary / secondary / melee / throwable |
| Mouse wheel, `Q` | Cycle weapons |
| `F` | Melee — also smashes barricades when the prompt says *MELEE TO SMASH* |
| `E` | Interact: pick up, open/close doors, revive (hold), use healing items |
| `5` / `6` | Medkit / pills |
| `G` | Drop the equipped throwable? No — throw the equipped throwable |
| `Esc` | Pause menu (settings, restart, quit to menu) |

Gamepad is supported (sticks, triggers, bumpers, D-pad) via `src/core/Input.ts`.
Touch devices get on-screen controls; `Input.isTouch` drives the layout.

---

## Architecture

```
                          ┌─────────────────────────────┐
                          │        index.html           │
                          │  boot splash · #viewport    │
                          └──────────────┬──────────────┘
                                         │
                                   src/main.ts
                     WebGL2 check → Engine.boot() → hide splash
                                         │
   ┌─────────────────────────────────────▼─────────────────────────────────────┐
   │                            engine/Engine.ts                               │
   │  fixed-step loop · chapter lifecycle · squad-wipe detection · UI glue     │
   │  wireEvents(): bus → HUD, audio, music, Director, mission objectives      │
   └───┬───────────┬───────────┬───────────┬───────────┬───────────┬──────────┘
       │           │           │           │           │           │
  ┌────▼───┐  ┌────▼────┐  ┌───▼────┐  ┌───▼─────┐  ┌──▼──────┐ ┌─▼────────┐
  │ player │  │entities │  │ world  │  │ director│  │ render  │ │   ui     │
  │Player  │  │Manager  │  │ Level  │  │Director │  │Renderer │ │Hud/Menus │
  │Weapons │  │Zombie   │  │ Nav    │  │pacing   │  │Materials│ │HudContext│
  │Camera  │  │Survivor │  │Generatr│  │budgets  │  │Batcher  │ │toasts    │
  │recoil  │  │Teammate │  │Items   │  │events   │  │Charactr │ │minimap   │
  │        │  │AI       │  │Noise   │  │moods    │  │Vfx      │ │          │
  └────┬───┘  └────┬────┘  └───┬────┘  └───┬─────┘  └──┬──────┘ └─┬────────┘
       │           │           │           │           │          │
       └───────────┴─────┬─────┴───────────┴───────────┴──────────┘
                         │
                 ┌───────▼────────┐   ┌──────────────┐   ┌──────────────┐
                 │  core/         │   │  physics/    │   │  audio/      │
                 │  Types, Math   │   │  Collision   │   │  Audio (synth)│
                 │  Events (bus)  │   │  Character   │   │  Music (moods)│
                 │  Settings      │   │  (capsule,   │   │              │
                 │  Input, Loop   │   │   raycast)   │   │              │
                 └────────────────┘   └──────────────┘   └──────────────┘
```

**Rules that keep it modular**

- **`core/Events.ts` is the only cross-system channel.** Systems publish into a typed bus
  (`weapon:fire`, `zombie:killed`, `survivor:downed`, `director:intensity`, …) and never
  hold references to each other's UI. The HUD, the score and the Director all subscribe.
- **`physics/Collision.ts` is the only place that knows about the world's solids.** Boxes,
  ramps, the uniform-grid broadphase, DDA raycasts and the character controller all live
  behind it. Entities never touch scene meshes.
- **Everything hot is pooled or scratch.** `CollisionScratch`, node arrays, ragdolls, gore
  decals, projectiles and spawn slots are pre-allocated; the steady-state cost of a physics
  query or a shot is zero allocations.
- **`config/` is data, not code.** Weapon stats, infected stats, difficulty multipliers,
  Director budgets and the whole campaign are plain objects. Balance changes never touch
  systems code.
- **Deterministic generation.** `LevelGenerator` takes a chapter seed; the same seed
  produces the same city, the same route and the same spawn anchors.

**Module map**

| Path | Responsibility |
| --- | --- |
| `src/engine/` | Fixed-step loop, chapter lifecycle, event wiring, squad state |
| `src/core/` | Types, math/RNG/perf, event bus, settings, input, game loop |
| `src/config/` | Weapons, zombies, campaign, balance data |
| `src/player/` | Player controller, camera, recoil, interaction |
| `src/weapons/` | Weapon state machine, ballistics, penetration, view model |
| `src/entities/` | Zombie/teammate/survivor entities, spawning, projectiles, ragdolls |
| `src/director/` | Pacing, budgets, spawn placement, scripted events, mercy rules |
| `src/world/` | Level generation, runtime (doors, breakables, lights), nav grid, items, noise |
| `src/render/` | Renderer, material library, procedural textures, geometry batching, characters |
| `src/physics/` | Collision world and character movement |
| `src/audio/` | Synthesised SFX and the adaptive score |
| `src/vfx/` | Muzzle flashes, tracers, blood, gore, explosions, decals |
| `src/ui/` | HUD, minimap, menus, settings, results screen |
| `src/tools/` | Headless level checker and gameplay simulator (dev only) |

---

## The AI Director

`src/director/Director.ts` runs a five-mood state machine — **relax → build → sustain →
peak → fade** — and drives every spawn decision from it.

- **Intensity scoring** (`scoreIntensity`) reads squad health, downs, how close the infected
  are, how long the squad has been in contact, and how much of the level is left.
- **Mood choice** (`chooseMood`) is hysteresis-based: it needs a sustained threshold breach
  to escalate, and it force-fades a peak that has run longer than 46 s so the game can never
  sit in a permanent horde.
- **Budgets** (`DIRECTOR_BUDGETS` × chapter `budgetScale` × difficulty) buy spawn slots at a
  credit/sec rate, so pressure is a tap, not a valve.
- **Population caps** (`liveCap` per mood, plus `mercyLiveCap` during a mercy window) keep
  the field readable; `cull()` dissolves the surplus farthest-first and never dissolves an
  infected that is within 32 m, pinning a survivor, or mid-charge.
- **Mercy** is explicit: last survivor alive and below 30 % health, the player incapacitated,
  two downs inside 30 s, or squad average health below 45 % → intensity is halved for 22 s
  and the live cap drops to 6.
- **Placement** (`pickAnchor`) prefers spawn anchors that are off-screen, 16–52 m away,
  behind the squad's facing and not on a different floor.
- **Scripted events** (`CAMPAIGN[].events`) fire from route triggers: ambush, crescendo,
  gauntlet, tank, witch, alarm, bridge collapse. Each carries a `waveScale`.

Config lives in `src/director/DirectorConfig.ts`; per-chapter overrides live next to the
chapter in `src/config/campaign.ts`.

---

## AI teammates

Three survivors with different personalities (`SURVIVOR` defs): **Rook** (aggressive,
pushes), **Vale** (supportive, heals and revives first), **Callahan** (cautious, keeps
distance and covers).

`TeammateAI` is a utility scorer, not a state machine: every decision tick it scores the
candidate goals — engage the biggest threat, rescue a pinned teammate, revive a downed one,
heal, throw (bile/pipe bomb at a cluster, molotov at a choke), follow, spread to avoid
splash — and commits to the best. Movement uses the same capsule controller as the player
and the nav flow field rooted at whoever is leading.

They talk: `VOICE` lines are picked by situation (spotted a special, throwing, reviving,
low health, "thanks", horde incoming) with per-line cooldowns.

**The regroup leash.** An agent more than 45 m from the lead for 6 s — or still outside the
safe room 8 s after the player starts waiting — is warped back to the squad. Without it a
single wedged doorway makes a chapter unfinishable, because the ending requires every living
survivor inside the safe room.

---

## Special infected

| Infected | Behaviour | Tell |
| --- | --- | --- |
| **Common** | Shambles, lunges, climbs, hordes | Moan, footsteps |
| **Boomer** | Vomits bile: blinds the screen, summons a horde; explodes on death | Wet gurgle |
| **Hunter** | Crouch-walks, pounces, pins, claws while pinned | Screech before the pounce |
| **Smoker** | Tongue-grabs a survivor from range and reels them in | Cough, tongue crack |
| **Spitter** | Arcs acid that leaves a damaging pool | Gurgling spit-up |
| **Charger** | Winds up and charges in a straight line, then slams | Roar while winding up |
| **Jockey** | Leaps on a survivor's shoulders and steers them into danger | Cackle |
| **Tank** | Enormous health, rips up chunks of the world and throws them, swings | Ground-shaking footsteps, deep roar |
| **Witch** | Dormant; enrages if shot, startled or walked past too closely | Crying |
| **Horde events** | Triggered by the Director, alarms and bile | Horn/alarm plus a wave |

---

## Content and balance configuration

| File | Contains |
| --- | --- |
| `src/config/weapons.ts` | 15 weapon defs (damage, pellets, spread, bloom, recoil, reload times, ADS, penetration), surface profiles, spawn tables |
| `src/config/zombies.ts` | Infected stats, survivor personalities, combat/perception tuning, voice lines |
| `src/config/campaign.ts` | The five chapters: seed, size, theme, Director overrides, events, difficulty scale, starting weapon |
| `src/core/Settings.ts` | Difficulty table, quality presets (Low/Medium/High), player settings defaults |
| `src/director/DirectorConfig.ts` | Mood thresholds, budgets, population caps, mercy rules, spawn placement |

Nothing about balance lives in systems code, so a tuning pass is a one-file change.

---

## Procedural assets and provenance

There are **no third-party art, audio or model files in this repository**, which makes the
provenance question trivial:

- **Geometry** — generated in `src/world/Generator.ts` (terrain slabs, roads, lane markings,
  sidewalks, buildings, interiors, stairs, bridges, overpasses, props) from the chapter seed.
- **Textures** — procedural noise/gradient canvases in `src/render/Materials.ts`
  (`ProceduralTextures`): asphalt, brick, plaster, concrete, wood, metal, roof, foliage,
  water. Generated once at boot, then sampled with mipmaps.
- **VFX textures** — `src/render/VfxTextures.ts`: smoke puffs, blood splats, muzzle flashes,
  decals.
- **Characters** — `src/render/Characters.ts` builds low-poly rigs procedurally and animates
  them in code: zombie shamble/lunge/attack and survivor walk/aim/reload gestures, with
  per-limb animation and hit-zone-aligned colliders.
- **Audio** — `src/audio/Audio.ts` synthesises every sound with oscillators, noise buffers and
  filters; `src/audio/Music.ts` runs six musical moods built from the same primitives.
- **Third-party code** — three.js (MIT) and the build tooling in `package.json` (MIT). No
  other runtime dependency.

If real assets are ever added, they must be CC0/MIT-compatible and recorded here with source
and licence.

---

## Performance

Target: **1080p Medium, 50–60 FPS on mid-range hardware** (integrated GPU or a 5-year-old
discrete card).

What the frame budget is spent on and how it is controlled:

| Technique | Where |
| --- | --- |
| Static geometry batched per material/surface | `render/Batcher.ts` — the whole city is ~10 draw calls |
| Instanced zombies, decals, particles, blood | `Entities` + `VfxTextures`, one instanced mesh per class |
| Frustum culling by three.js plus hand-rolled range culling for AI | `Zombie.update` early-outs beyond `PERCEPTION` ranges |
| Object pooling for zombies, projectiles, decals, ragdolls, lights | `EntityManager`, `Effects`, `Level.buildLights` |
| LOD by distance: animation updates, shadows and lights gated by distance | `CharacterRenderer`, `Level.updateLightBudget` |
| Fixed-step simulation (1/60) decoupled from render | `core/Loop.ts` (max 5 catch-up steps) |
| Quality presets Low/Medium/High | Shadows, fog, particle counts, texture sizes, lighting budget |
| Zero-allocation steady state | Shared scratch objects everywhere in the hot path |

Render cost scales with the preset in `QUALITY_PRESETS`; `applyQuality` re-applies shadows,
fog, particle caps and the per-frame light budget without a reload. On very low-end devices
the renderer degrades to Low automatically if the frame time stays above the budget.

---

## Development tooling

Two Node harnesses run the *real* gameplay code with no renderer, no DOM and no audio:

```bash
npm run check:levels
```

Generates every chapter and reports geometry, nav-grid coverage, route reachability, spawn
anchor health and item placement (including unreachable pickups). Use it after any change to
the generator or the nav bake.

```bash
npm run sim -- <chapterIndex> <difficulty> <seconds> [--debug]
```

Boots the full stack — player, weapons, ballistics, zombies, teammates, Director, loot — with
a scripted bot driving the player (aims with mouse deltas, taps semi-autos, reloads, cycles
dry weapons, heals out of contact, smashes barricades, opens doors, follows a nav guide field
to the objective). It reports route progress, kills, downs/revives, shot accuracy, Director
mood pacing, horde counts and fights per minute, and exits with code 2 if any health value
goes non-finite.

---

## Known issues and next steps

**Known issues**

1. **`check:levels` warnings.** Buried spawn anchors (up to 22 in chapter 1, 42 in chapter 4)
   and unreachable item spots (up to 19 of 71 in chapter 4). They do not block play — the
   Director skips unusable anchors — but they waste spawn budget.
2. **Sim bot stalls.** The harness bot completes some chapters and stalls in others at a
   barricade or a doorway the flow field will not path through. This is bot navigation, not an
   engine blocker (a human can walk or smash through), but it limits how much of the campaign
   the harness can currently regression-test end-to-end.
3. **Batcher numeric `addQuad` mapping.** The 15-argument numeric overload maps road/lane
   quads with `color` bound to the wrong parameter; those quads type-check but render
   incorrectly. Fix by re-ordering the numeric parameters or converting the call sites to
   `Vector3` form.
4. **HUD minimap and debug overlays are unverified by eye.** They type-check and are wired to
   live data, but they have not had a visual pass in a browser.
5. **Ragdolls are simple.** Deaths use a pooled fall animation rather than physics-driven
   bodies.
6. **No browser play-test pass has been done on this revision.** The systems are exercised
   headlessly and the build is clean; the boot → menu → chapter → pause → death → results flow
   still needs a human pass.

**Next steps (in order)**

1. Browser play-test of the full loop and a HUD/debug overlay pass.
2. Fix the Batcher quad mapping and the residual `check:levels` warnings.
3. Give the sim bot a proper path-following controller (pure-pursuit over the flow field with
   door/barricade handling) so the whole campaign is regression-tested.
4. Ragdoll physics, then dismemberment.
5. Per-weapon animation passes (reload, inspect, sprint poses).
6. Photo-mode/spectator debug camera for level inspection.

---

## Multiplayer roadmap

Browser-native co-op is designed for but not implemented. The single-player architecture was
built so that adding it does not require a rewrite, and the full plan — authoritative server,
WebRTC data channels, Colyseus matchmaking, interest management, netcode for the Director and
the AI takeover of disconnected players — is in [`docs/MULTIPLAYER_ROADMAP.md`](docs/MULTIPLAYER_ROADMAP.md).
The short version: `Input` is already a per-peer abstraction (the harness proves it by
replacing the player's input with a scripted one), all gameplay state is in plain data
structures, and the Director already owns *when* and *where* things happen — which is exactly
the part that must move server-side.

---

## Licence

Code: MIT. Procedural assets: generated by this codebase, no third-party licences.
