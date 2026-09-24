# Multiplayer roadmap — browser-native co-op

Goal: **four players co-op, drop-in/drop-out, in the browser**, keeping the single-player
campaign, the Director and the AI teammates intact. The design below is the target; nothing
here is implemented yet, and nothing in the single-player code needs to be rewritten to get
there.

---

## 0. Why this codebase is already close

| Property | Why it matters for netcode |
| --- | --- |
| `Input` is a class with virtual methods, not global event handlers | A remote player is just another `Input` implementation — the headless harness already proves it by driving the real `Player` with `ScriptedInput`. |
| Simulation is a fixed 1/60 step with no dependency on render | Deterministic stepping, catch-up limits and rewind/replay become possible. |
| All gameplay state is plain data (positions, health, ammo, timers) | Snapshotting needs no serialisation hooks per class. |
| The Director decides *when/where*, entities act locally | The one system that must be authoritative is already the one with a single decision point per step. |
| Nav grid, spawn anchors, item spots and level layout are seed-derived | Clients can generate the identical level from a 32-bit seed instead of transferring geometry. |
| Rendering is procedural | No asset streaming at all: a joining client needs a seed and a build version. |

---

## 1. Topology

**Host-authoritative listen server, relayed through a matchmaker.**

```
        Client A ─┐
        Client B ─┼── WebRTC data channels (unreliable/unordered) ──► Host (player 1)
        Client C ─┘                                                   │
   ┌──────────────────────────────────────────────────────────────────┘
   │  authoritative: player actions, zombie AI, Director, damage resolution
   └──► snapshots (reliable-ordered for events, unreliable for state)
```

- **Why host-authoritative first:** no dedicated servers to pay for, sub-30 ms latency for the
  majority of sessions, and it matches the genre (L4D ran listen servers).
- **Where it breaks:** the host's connection quality sets the floor for everyone, and a host
  quit ends the match. Mitigations, in order of effort: host migration (state lives in one
  snapshot), then dedicated relay servers for ranked/campaign play.
- **Transport:** WebRTC `RTCDataChannel`. Two channels per peer: `state` (unreliable,
  unordered, sequence-numbered) and `events` (reliable, ordered, for kills, revives, doors,
  Director events, chat). TCP fallback via WebSocket for restrictive NATs.
- **Signalling / matchmaking:** [Colyseus](https://colyseus.io) rooms for lobby, matchmaking,
  chat and NAT traversal signalling, with a TURN fallback (coturn) for symmetric NATs. Colyseus
  also gives us a clean place to run *server-side* Director logic later without changing the
  client.

---

## 2. Authority model

| System | Authority | Notes |
| --- | --- | --- |
| Player movement | Client-predicted, host-verified | Cheap to predict, expensive to get wrong; host validates against speed/step constraints. |
| Shooting | Client sends intent (fire, aim, weapon), host resolves | Host computes the hit; no client-side hit authority (anti-cheat). |
| Damage | Host | Zombie and survivor health live on the host. |
| Zombie AI | Host | Clients run cheap local interpolation; the host sends target + state. |
| Director | Host | It is a small, single-decision-per-step system — hosting it costs almost nothing. |
| Item pickups | Host-validated | Loot is shared world state; a pickup is an event, not a prediction. |
| Doors / breakables / triggers | Host | Same as above; clients fire the animation locally on the event. |
| Safe-room state, chapter progression | Host | The host is the campaign's clock. |

The rule of thumb: **anything that can be disputed goes to the host; anything that only
affects the shooter's own view is predicted locally.**

---

## 3. Netcode design

### 3.1 Tick and snapshot rate

- Simulation: 60 Hz on all peers (they must be, to predict movement with one code path).
- Snapshots: **20 Hz** for world state (positions, health, zombie states), interpolated on
  clients with a 100 ms buffer.
- Events: reliable-ordered, sent immediately (shots that hit, kills, revives, pickups, Director
  announcements).

### 3.2 What gets sent per zombie

```
variant(3b) | state(4b) | flags(1b) | x,y,z quantised to 1cm | yaw 8b | health 8b | targetId 3b
```

≈ 14 bytes per infected. A peak of 30 infected is ~420 bytes per snapshot, ~8.4 kB/s outbound
per client at 20 Hz. Players are ~20 bytes each (position, yaw, pitch, state, weapon, ammo).

### 3.3 Interest management

- Full rate for anything within `NEAR_DISTANCE` (≈ 25 m) or in the player's view cone.
- Half rate for the mid band; the far band only receives state changes (spawn, death, mood).
- The Director's spawn anchors are already evaluated against the *player* position, so
  server-side interest filtering is a natural extension: spawn behind someone, but only
  replicate it to the players who can see it.

### 3.4 Prediction and reconciliation

- **Movement:** client predicts its own capsule with the standard controller, keeps a ring
  buffer of inputs; when the host's authoritative state arrives it rewinds and re-simulates the
  unacknowledged inputs (standard rollback, ~a few frames).
- **Weapons:** fire immediately for feel (muzzle flash, sound, recoil, tracers), but damage and
  zombie reactions wait for the host's confirmation. A rejected shot (host says the target was
  already dead) is silently corrected by the next snapshot.
- **Zombies:** never predicted. They are interpolated between snapshots with a 100 ms delay;
  local "flinch" feedback plays on the client but the health bar follows the host.
- **Doors/breakables:** predicted open locally, confirmed by event. If the host disagrees, the
  next snapshot puts it back.

### 3.5 Lag compensation for shooting

The host keeps a 200 ms history of survivor and zombie positions. On a fire event it rewinds
the world to the shooter's reported timestamp, resolves the shot with the existing
`castBullet` path (unchanged), and restores. This is the same hit detection as single-player,
which is the point: one ballistics implementation, two callers.

---

## 4. Keeping the single-player game intact

- **AI takeover.** If a player disconnects (or a lobby is not full), a `TeammateAI` is
  instantiated to drive that body. `TeammateAI` already consumes the same `Survivor` state the
  player controller produces, so a takeover is: stop reading remote input, start running the
  AI, keep the entity id.
- **Difficulty scaling.** `DIFFICULTIES` already exposes budget multipliers; co-op adds a
  player-count factor (as L4D does) so four humans face more than one human plus three AI.
- **Mode flags.** `PlayMode.Single` and `PlayMode.Coop` differ only in who produces input and
  who owns truth; the chapter, Director, spawn and scoring code paths are shared.
- **Friendly fire** is already a setting that both the player and teammate paths read, which
  is exactly the toggle co-op needs.

---

## 5. Work breakdown

| Milestone | Deliverable | Rough size |
| --- | --- | --- |
| M1 — transport | Two browsers exchange `PlayerCommand` and `Snapshot` over a manual WebRTC connection, no matchmaking, hardcoded ip | 1–2 weeks |
| M2 — movement sync | Host-authoritative movement with client prediction and reconciliation for 2 peers; a second capsule is visible and shoots | 2–3 weeks |
| M3 — combat sync | Host-resolved shooting with lag compensation; zombie replication with interest management; damage, death, ragdolls on all peers | 2–3 weeks |
| M4 — campaign sync | Director events, doors, breakables, items, safe-room state, chapter transitions; reconnect and AI takeover | 2 weeks |
| M5 — matchmaking | Colyseus lobby, room browser, NAT/TURN fallback, chat, drop-in/drop-out | 2 weeks |
| M6 — hardening | Anti-cheat sanity checks, bandwidth profiles, host migration prototype, load tests at 4 peers | 2–3 weeks |

### Concrete first steps (M1)

1. Extract the input contract: make `Input` an interface (`InputSource`) with a `LocalInput`
   implementation (today's class) and a `RemoteInput` that applies a serialised command list.
2. Define `PlayerCommand { seq, dt, moveX, moveZ, yaw, pitch, buttons, weapon }` and
   `Snapshot { tick, survivors[], zombies[], events[] }` in `src/net/Protocol.ts`.
3. Add `src/net/Session.ts` with `host()`/`join()`, one data channel, and a `NetworkSystem`
   that `Engine` steps after the player (host) or before it (client).
4. Gate everything behind `--net` / a menu option so single-player stays byte-identical.

---

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Zombie count at 4 players × peak hordes is bandwidth-heavy | Interest management + quantised snapshots; the Director caps live counts per client anyway. |
| Browser tab throttling when the host alt-tabs | Detect `visibilitychange`, warn, and offer host migration; require the host to keep the tab focused. |
| Rollback re-simulation cost | The simulation is cheap (0.1 ms/step for the full stack, measured by the headless harness), so re-simulating 3–4 frames per snapshot is affordable. |
| Cheating (clients know the level seed) | Same as the genre's listen-server baseline: trust the host, keep damage on the host, keep progression on the host. |
| Audio spam with four players' shots | Voice/volume budget in `AudioSystem` already drops the quietest sources; add per-owner ducking. |
