/**
 * HEADLESS GAMEPLAY SIMULATION (development only)
 * ==============================================
 *     npm run sim              # chapter 1, normal, 4 simulated minutes
 *     npm run sim -- 3 hard 300
 *
 * This runs the *entire gameplay stack* — player controller, weapons,
 * ballistics, zombie AI, teammate AI, the Director, loot and the level runtime —
 * with no renderer, no DOM and no audio. The interesting failure modes of a
 * project like this are not visual: they are "the squadded never reached the
 * safe room", "teammates stopped reviving", "the Director never spent a credit",
 * "chapter 4 takes forty minutes of simulated time".
 *
 * A scripted bot plays the chapter: it walks the route, shoots what it can see,
 * reloads, swaps weapons instead of dry-firing, heals and interacts. That is
 * enough to exercise every system the engine drives, **in the same order the
 * engine drives them** (`src/engine/Engine.ts` -> `step()`), so a pass here means
 * the simulation rules work; a browser is then only needed to check the parts
 * that draw.
 *
 * The harness is also a dry run of the co-op architecture: the bot supplies an
 * input snapshot rather than DOM events, which is exactly what a remote peer
 * will send.
 */
import * as THREE from 'three';
import { installCanvasStub } from '@/tools/CanvasStub';
import { bus } from '@/core/Events';
import { CAMPAIGN, chapterDef } from '@/config/campaign';
import { Rng } from '@/core/MathUtil';
import { QUALITY_PRESETS, SettingsStore, difficultyDef } from '@/core/Settings';
import { Input, type ActionName } from '@/core/Input';
import { CollisionScratch, CollisionWorld } from '@/physics/Collision';
import { Level } from '@/world/Level';
import { FLOW_SLOT_OBJECTIVE } from '@/world/Nav';
import { ItemManager } from '@/world/Items';
import { MaterialLibrary, ProceduralTextures, VfxTextures } from '@/render/Materials';
import { AudioSystem } from '@/audio/Audio';
import { MusicDirector } from '@/audio/Music';
import { Effects } from '@/vfx/Effects';
import { EntityManager } from '@/entities/EntityManager';
import { Survivor } from '@/entities/Survivor';
import { Zombie } from '@/entities/Zombie';
import { Player } from '@/player/Player';
import { TeammateAI, DEFAULT_SQUAD_LOADOUT } from '@/entities/TeammateAI';
import { Director } from '@/director/Director';
import { WeaponSystem } from '@/weapons/Weapons';
import { SURVIVORS } from '@/config/zombies';
import { weaponDef } from '@/config/weapons';
import { ZombieRenderer, SurvivorRenderer } from '@/render/Characters';

declare const process: { argv: string[]; exitCode: number };

// ---------------------------------------------------------------------------
// Scripted input — the "network peer" shape of a player
// ---------------------------------------------------------------------------

class ScriptedInput extends Input {
  private held = new Set<ActionName>();
  private tapped = new Set<ActionName>();
  private look = { x: 0, y: 0 };
  /** Absolute yaw/pitch the bot wants this frame, in radians. */
  wantYaw = 0;
  wantPitch = 0;

  constructor() {
    // The stub document hands back a stub canvas, so `attach()` finds nothing to
    // listen to and this input is driven purely by `set`/`tap`.
    super(document.createElement('canvas') as unknown as HTMLElement);
  }

  override action(name: ActionName): boolean {
    return this.held.has(name);
  }

  override actionPressed(name: ActionName): boolean {
    return this.tapped.has(name);
  }

  override down(): boolean {
    return false;
  }

  override lookDelta(out: { x: number; y: number }): void {
    out.x = this.look.x;
    out.y = this.look.y;
  }

  /** Hold (`pressed = true`) or tap (`pressed = false`) an action. */
  set(name: ActionName, down: boolean): void {
    if (down) this.held.add(name);
    else this.held.delete(name);
  }

  tap(name: ActionName): void {
    this.tapped.add(name);
  }

  /** Look delta in radians for this frame (the engine's unit). */
  setLook(x: number, y: number): void {
    this.look.x = x;
    this.look.y = y;
  }

  beginFrame(): void {
    this.tapped.clear();
    this.look.x = 0;
    this.look.y = 0;
    this.wheel = 0;
  }
}

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

/** Scratch for the guide flow direction (reused every frame, never retained). */
const GUIDE = new THREE.Vector3();

/** Bot decisions are seeded so a simulation is reproducible. */
const botRng = new Rng(0xb07b07);

interface BotMemory {
  stuck: number;
  /** Objective the guide flow field was last built from. */
  guideGoal: THREE.Vector3;
  guideTimer: number;
  guideValid: boolean;
  /** Cells of travel the guide field reports to the objective (-1 unreachable). */
  guideDistance: number;
  lastPos: THREE.Vector3;
  waypoint: THREE.Vector3;
  strafeDir: number;
  shotsFired: number;
  thinkTimer: number;
  target: Zombie | null;
  /** Counts frames so semi-auto weapons can be tapped rather than held. */
  firePhase: number;
  /** Seconds spent holding a weapon with no ammo at all. */
  dryTimer: number;
  /** Cooldown so the bot swings at a barricade instead of spamming melee. */
  smashTimer: number;
  /** Cooldown for door taps (`use` is a press, not a hold, for doors). */
  useTimer: number;
  /** Temporary walk-to target that breaks a deadlock the flow field cannot. */
  detour?: THREE.Vector3;
}

function runBot(
  input: ScriptedInput,
  player: Player,
  entities: EntityManager,
  level: Level,
  dt: number,
  memory: BotMemory,
): void {
  // --- navigation goal ----------------------------------------------------
  const marker = level.objectiveMarker();
  if (marker && marker.distance > 3.5) {
    memory.waypoint.copy(marker.position);
  } else {
    memory.waypoint.copy(level.routePoint(Math.min(1, level.progress + 0.06)));
  }
  // Keep a BFS flow field pointed at the objective. Straight-line steering walks
  // into the first wall between us and the waypoint; a field over the nav grid
  // finds the doorway instead — the same trick the zombie AI uses to reach the
  // squad, which also makes this harness a test that the route is *walkable*.
  memory.guideTimer -= dt;
  if (memory.guideTimer <= 0 && memory.waypoint.distanceTo(memory.guideGoal) > 2.5) {
    memory.guideTimer = 0.5;
    const goalNode = level.nav.nodeAt(memory.waypoint.x, memory.waypoint.y + 0.5, memory.waypoint.z, 4);
    if (goalNode >= 0) {
      level.nav.buildFlow(goalNode, FLOW_SLOT_OBJECTIVE);
      memory.guideGoal.copy(memory.waypoint);
      memory.guideValid = true;
    } else {
      memory.guideValid = false;
    }
  }

  const dx = memory.waypoint.x - player.position.x;
  const dz = memory.waypoint.z - player.position.z;
  const travelYaw = Math.atan2(dx, dz);

  // --- target selection (refreshed a few times a second, not every frame) --
  memory.thinkTimer -= dt;
  if (memory.thinkTimer <= 0) {
    memory.thinkTimer = 0.15;
    let best: Zombie | null = null;
    let bestScore = Infinity;
    for (const z of entities.zombies) {
      if (!z.alive) continue;
      const d = z.position.distanceTo(player.position);
      if (d > 45) continue;
      const score = d - (z.special ? 14 : 0) - (z.isPinning ? 30 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = z;
      }
    }
    memory.target = best;
  }
  const target = memory.target && memory.target.alive ? memory.target : null;

  const weapon = player.weapons;
  const item = weapon?.active ?? null;

  // --- aiming -------------------------------------------------------------
  // A barricade in the face beats shooting at something across the street —
  // but only once the bot has actually stalled: props are everywhere, and
  // stopping to stare at every crate is its own kind of bug.
  const smash =
    memory.stuck > 1.0 && player.interactPrompt?.includes('SMASH')
      ? level.breakableAt(player.position.x, player.position.y, player.position.z, 2.2)
      : null;
  if (smash) {
    const d = smash.def;
    input.wantYaw = Math.atan2(d.x - player.position.x, d.z - player.position.z);
    input.wantPitch = 0;
  } else if (target) {
    const tx = target.position.x - player.position.x;
    const tz = target.position.z - player.position.z;
    const dist = Math.hypot(tx, tz);
    input.wantYaw = Math.atan2(tx, tz);
    input.wantPitch = Math.atan2(target.position.y + 1.35 - player.eyePosition.y, Math.max(1.5, dist));
  } else {
    input.wantYaw = travelYaw;
    input.wantPitch = 0;
  }
  const yawError = wrapPi(input.wantYaw - player.yaw);
  // Effective aim includes the muzzle climb from recoil; a human pulls the mouse
  // down through it, and the bot compensates the same way.
  const aimPitch = player.pitch + player.recoilOffsetPitch;
  // The controller applies `yaw -= look.x`, so a rightward mouse delta arrives
  // here as a negative number: the bot must feed the negated error back in.
  // `Player.step` does `yaw -= look.x; pitch -= look.y`, so both axes are fed
  // the negated error. (Fixing only the yaw is how the bot ended up aiming with
  // its pitch pinned at the ceiling, hitting nothing while the squad did the work.)
  input.setLook(
    -clamp(yawError * 0.35, -0.09, 0.09),
    -clamp((input.wantPitch - aimPitch) * 0.35, -0.07, 0.07),
  );

  // --- firing -------------------------------------------------------------
  // Ammo matters: tapping the trigger on an empty magazine just burns the
  // fire-rate timer (and the log fills with `weapon:dry` clicks).
  const hasAmmo = item ? item.def.ammoType === 'none' || item.ammo > 0 : false;
  // Firing needs a *converged* aim, not merely a target in front of us: a
  // 0.35 rad tolerance at 15 m is a guaranteed miss.
  const pitchError = Math.abs(input.wantPitch - aimPitch);
  const canShoot =
    !!target && Math.abs(yawError) < 0.07 && pitchError < 0.06 && !!item && item.def.slot !== 'melee' && hasAmmo;
  if (canShoot) {
    // Automatic weapons are held; semi-automatics are tapped. Holding the
    // trigger on a semi-auto only ever produces one shot (see
    // `WeaponSystem.tryFire`), which is exactly the mistake a new player makes.
    if (item!.def.automatic) input.set('fire', true);
    else if (memory.firePhase % 2 === 0) input.tap('fire');
  } else {
    input.set('fire', false);
  }
  memory.firePhase++;

  // --- weapon upkeep ------------------------------------------------------
  if (item && item.def.ammoType !== 'none') {
    const reserve = weapon!.reserveFor(item.def.ammoType);
    if (item.ammo === 0 && reserve > 0) {
      input.tap('reload');
      memory.dryTimer = 0;
    } else if (item.ammo === 0) {
      // Nothing in the magazine and nothing in reserve: cycle to whatever else
      // still has bullets (a human does this with the wheel or the 1/2/3 keys).
      memory.dryTimer += dt;
      if (memory.dryTimer > 0.5) {
        memory.dryTimer = 0;
        input.tap('nextWeapon');
      }
    } else {
      memory.dryTimer = 0;
      // Top up during a lull rather than in the middle of a firefight.
      if (item.ammo <= item.def.magazine * 0.35 && reserve > 0 && !target) input.tap('reload');
    }
  }

  // --- survival -----------------------------------------------------------
  // Heal during breaks only: a medkit takes seconds and cannot be interrupted.
  const threatDist = nearestThreatDistance(player, entities);
  if (player.health < 45 && threatDist > 25 && weapon && weapon.heals.medkit > 0) input.tap('heal');
  else if (player.health < 30 && threatDist > 18 && weapon && weapon.heals.pills > 0) input.tap('heal');

  // Interaction: revives, doors, loot (the player controller decides priority).
  // Revives and looting are *held*; doors toggle on a single press, so a bot that
  // only ever holds `use` stands at the safe-room door forever.
  const prompt = player.interactPrompt ?? '';
  input.set('use', prompt !== '');
  if (prompt.includes('DOOR') && !prompt.includes('LOCKED')) {
    memory.useTimer += dt;
    if (memory.useTimer > 0.4) {
      memory.useTimer = 0;
      input.tap('use');
    }
  } else {
    memory.useTimer = 0;
  }
  // A barricade the generator dropped across the route has to be smashed —
  // standing in front of it with the "MELEE TO SMASH" prompt is a dead end.
  if (player.interactPrompt?.includes('SMASH')) {
    memory.smashTimer += dt;
    if (memory.smashTimer > 0.6) {
      memory.smashTimer = 0;
      input.tap('melee');
    }
  } else {
    memory.smashTimer = 0;
  }

  // --- movement -----------------------------------------------------------
  // Strafe while shooting: express the desired travel direction in the *body*
  // frame (which is aiming at the target), exactly as a human plays. Walking
  // "forward" while facing an enemy is how a bot ends up chasing the horde away
  // from its objective.
  const goal = memory.detour ?? memory.waypoint;
  const toWaypointX = goal.x - player.position.x;
  const toWaypointZ = goal.z - player.position.z;
  const wpLen = Math.max(0.001, Math.hypot(toWaypointX, toWaypointZ));
  let moveX = toWaypointX / wpLen;
  let moveZ = toWaypointZ / wpLen;
  if (!memory.detour && memory.guideValid && wpLen > 4 && level.nav.hasFlow(FLOW_SLOT_OBJECTIVE)) {
    const node = level.nav.nodeAt(player.position.x, player.position.y + 0.5, player.position.z, 3);
    if (node >= 0 && level.nav.flowDirection(node, GUIDE, 3, FLOW_SLOT_OBJECTIVE)) {
      const reach = level.nav.distanceAt(node, FLOW_SLOT_OBJECTIVE);
      memory.guideDistance = reach;
      const w = clamp((wpLen - 4) / 12, 0, 1);
      moveX = GUIDE.x * w + moveX * (1 - w);
      moveZ = GUIDE.z * w + moveZ * (1 - w);
      const l = Math.hypot(moveX, moveZ) || 1;
      moveX /= l;
      moveZ /= l;
    }
  }
  // Back off when something is close enough to swing at us.
  if (threatDist < 4.5 && target) {
    const awayX = player.position.x - target.position.x;
    const awayZ = player.position.z - target.position.z;
    const awayLen = Math.max(0.001, Math.hypot(awayX, awayZ));
    moveX = awayX / awayLen;
    moveZ = awayZ / awayLen;
  }
  // Stop to shoot. Sprinting sideways while spraying a carbine is a great way to
  // miss every pellet: the spread model accounts for movement, and so must the
  // bot. (This is also why the hit rate above reads like a real firefight.)
  const targetDist = target ? target.position.distanceTo(player.position) : Infinity;
  const holdStill = canShoot && targetDist < 26 && threatDist > 6;
  const facingX = Math.sin(player.yaw);
  const facingZ = Math.cos(player.yaw);
  // Character's local frame: forward = (sin, cos), right = (-cos, sin).
  const localForward = moveX * facingX + moveZ * facingZ;
  const localStrafe = moveX * -facingZ + moveZ * facingX;
  input.set('forward', !holdStill && localForward > 0.2);
  input.set('back', !holdStill && localForward < -0.2);
  input.set('right', !holdStill && localStrafe > 0.2);
  input.set('left', !holdStill && localStrafe < -0.2);
  input.set('sprint', !holdStill && localForward > 0.7 && !target && player.health > 60);

  // Unstick: strafe (and finally hop) when the position stops changing.
  const moved = player.position.distanceTo(memory.lastPos);
  memory.lastPos.copy(player.position);
  // Standing still to shoot is not being stuck: counting it makes the bot
  // strafe out of every firefight it starts (and then blame the geometry).
  const tryingToMove = !holdStill;
  if (tryingToMove && moved < dt * 0.6) memory.stuck += dt;
  else memory.stuck = Math.max(0, memory.stuck - dt * 2);

  if (memory.stuck > 1.2) {
    // Seeded, so two runs of the same chapter produce the same route: a
    // harness whose failures move around is useless for A/B tuning.
    if (memory.strafeDir === 0) memory.strafeDir = botRng.next() < 0.5 ? -1 : 1;
    input.set(memory.strafeDir > 0 ? 'right' : 'left', true);
    if (memory.stuck > 3) {
      input.tap('jump');
      memory.stuck = 0;
    }
  } else {
    memory.strafeDir = 0;
  }
}

/** Distance to the closest living infected (INF when the field is clear). */
function nearestThreatDistance(player: Player, entities: EntityManager): number {
  let best = Infinity;
  for (const z of entities.zombies) {
    if (!z.alive) continue;
    const d = z.position.distanceTo(player.position);
    if (d < best) best = d;
  }
  return best;
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  const args = process.argv.slice(2);
  const chapterIndex = Math.max(0, Math.min(CAMPAIGN.length - 1, Number(args[0] ?? 0)));
  const difficulty = (args[1] ?? 'normal') as 'easy' | 'normal' | 'hard' | 'expert';
  const seconds = Number(args[2] ?? 240);
  const chapter = chapterDef(chapterIndex);

  const settings = new SettingsStore();
  settings.apply({ difficulty, goreLevel: 'reduced' });
  const quality = { ...QUALITY_PRESETS.high };

  // --- systems -----------------------------------------------------------
  const world = new CollisionWorld();
  const vfx = new VfxTextures();
  const materials = new MaterialLibrary(new ProceduralTextures());
  const audio = new AudioSystem(settings.current);
  const music = new MusicDirector(audio);
  const effects = new Effects(vfx, quality);
  const level = new Level(world, materials, vfx, quality);
  const scratch = new CollisionScratch();

  let kills = 0;
  let specialKills = 0;
  let headshots = 0;
  let downs = 0;
  let revives = 0;
  let hits = 0;
  let dealt = 0;
  let allHits = 0;
  let fireEvents = 0;
  let dryEvents = 0;
  let reloadStarts = 0;
  let reloadEnds = 0;
  bus.on('weapon:fire', () => fireEvents++);
  bus.on('weapon:dry', () => dryEvents++);
  bus.on('weapon:reloadStart', () => reloadStarts++);
  bus.on('weapon:reloadEnd', () => reloadEnds++);

  const entities = new EntityManager(world, level.nav, effects, audio, quality, {
    onZombieKilled: (z, opts) => {
      kills++;
      if (z.special) specialKills++;
      if (opts.headshot) headshots++;
    },
    onZombieSpawned: () => undefined,
    // Accuracy is measured on landed hits attributed to the *player*, so the
    // teammates' fire never inflates the bot's own marksmanship numbers.
    onZombieHit: (_z, opts) => {
      allHits++;
      if (opts.attacker && opts.attacker === (player as unknown as object)) {
        hits++;
        dealt += opts.damage;
      } else if (allHits < 4) {
        console.log(`      [diag] hit by ${(opts.attacker as unknown as { constructor: { name: string } })?.constructor?.name} dmg ${opts.damage.toFixed(1)}`);
      }
    },
    onSurvivorDowned: (s) => {
      downs++;
      console.log(`      [event] ${s.name} went down`);
    },
    onSurvivorDied: (s) => console.log(`      [event] ${s.name} DIED`),
    onSurvivorDamaged: () => undefined,
    onPin: (s, z) => console.log(`      [event] ${s.name} pinned by ${z.variant}`),
    onUnpin: () => undefined,
    onAbility: () => undefined,
    onDoorDamage: () => undefined,
    applyDamage: (t, amount, opts) => t.takeDamage(amount, opts),
  });

  const layout = level.load(chapter, () => undefined);
  const items = new ItemManager(world, materials, audio, effects);
  items.load(layout, level);

  // --- squad -------------------------------------------------------------
  const input = new ScriptedInput();
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 400);
  const player = new Player(1, world, camera, input, entities, level, items, effects, audio, settings.current, scratch);
  entities.registerSurvivor(player);
  player.weapons = new WeaponSystem(player, world, entities, materials, effects, audio, settings.current);
  player.weapons.setLevel(level);

  const squad: Survivor[] = [player];
  const teammates: TeammateAI[] = [];
  for (let i = 0; i < 3; i++) {
    const ai = new TeammateAI(
      2 + i,
      SURVIVORS[i % SURVIVORS.length],
      world,
      level.nav,
      entities,
      effects,
      audio,
      DEFAULT_SQUAD_LOADOUT[i % DEFAULT_SQUAD_LOADOUT.length],
      i,
    );
    teammates.push(ai);
    squad.push(ai);
    entities.registerSurvivor(ai);
  }

  // --- debug: catch non-finite health at the source ------------------------
  for (const s of squad) {
    const take = s.takeDamage.bind(s);
    s.takeDamage = (amount: number, opts) => {
      if (!Number.isFinite(amount)) console.log(`      !! NaN takeDamage -> ${s.name}: ${amount} kind=${opts?.kind} attacker=${opts?.attacker?.constructor?.name ?? '-'}`);
      return take(amount, opts);
    };
    const heal = s.heal.bind(s);
    s.heal = (amount: number) => {
      if (!Number.isFinite(amount)) console.log(`      !! NaN heal -> ${s.name}: ${amount}\n${new Error().stack}`);
      return heal(amount);
    };
    const temp = s.giveTempHealth.bind(s);
    s.giveTempHealth = (amount: number, decay: number, delay: number) => {
      if (!Number.isFinite(amount) || !Number.isFinite(decay)) console.log(`      !! NaN tempHealth -> ${s.name}: amount=${amount} decay=${decay} delay=${delay}\n${new Error().stack}`);
      return temp(amount, decay, delay);
    };
  }

  const spawn = layout.playerSpawn;
  player.spawnAt(spawn.x, spawn.y + 0.3, spawn.z, spawn.yaw);
  player.weapons.give('pistol_m9', weaponDef('pistol_m9').magazine, 60);
  // Mirror `Engine.spawnSquad`: the chapter's tier-1 primary is what the player
  // actually holds at the start of a run.
  if (chapter.startPrimary) {
    const def = weaponDef(chapter.startPrimary);
    player.weapons.give(chapter.startPrimary, def.magazine, def.reserveMax);
    player.weapons.equip('primary', chapter.startPrimary, true);
  } else {
    player.weapons.equip('secondary', 'pistol_m9', true);
  }
  player.weapons.give('pipe_bomb', 1, 1);
  player.weapons.giveHeal('medkit', 1);
  player.weapons.giveHeal('pills', 1);
  player.health = 100;

  const cos = Math.cos(spawn.yaw);
  const sin = Math.sin(spawn.yaw);
  teammates.forEach((ai, i) => {
    const side = (i - 1) * 1.4;
    ai.char.teleport(spawn.x - sin * 2.2 + cos * side, spawn.y + 0.3, spawn.z - cos * 2.2 - sin * side);
    ai.char.snapToGround(4);
    ai.facing = spawn.yaw;
  });

  // Counters that mirror what the engine does with the shared bus.
  bus.on('survivor:incapacitated', () => {
    downs++;
  });
  bus.on('survivor:revived', () => {
    revives++;
  });

  const director = new Director(
    { difficulty: difficultyDef(difficulty), seed: chapter.seed ^ 0x9e3779b9, ...chapter.director },
    level,
    level.nav,
    entities,
    audio,
    music,
    effects,
    items,
  );
  director.start(layout);
  entities.allowedVariants = ['common', 'common_fast', 'common_armoured'];

  // Rendering-side systems are headless-safe (they build Three.js objects but
  // never touch a GL context), so animate them too — cheap extra coverage.
  const zombieRig = new ZombieRenderer(materials, quality);
  const survivorRig = new SurvivorRenderer(materials, quality);

  console.log(`SIM chapter ${chapter.index + 1} "${chapter.name}" · ${difficulty} · budget ${seconds}s`);
  console.log(`    spawn ${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)} · route ${level.routeSamples.length} samples · ${layout.spawnAnchors.length} anchors`);

  const dt = 1 / 60;
  const steps = Math.floor(seconds / dt);
  const memory: BotMemory = {
    stuck: 0,
    lastPos: player.position.clone(),
    waypoint: new THREE.Vector3(layout.playerSpawn.x, layout.playerSpawn.y, layout.playerSpawn.z),
    guideGoal: new THREE.Vector3(layout.playerSpawn.x, layout.playerSpawn.y, layout.playerSpawn.z),
    guideTimer: 0,
    guideValid: false,
    guideDistance: -1,
    strafeDir: 0,
    shotsFired: 0,
    thinkTimer: 0,
    target: null,
    firePhase: 0,
    dryTimer: 0,
    smashTimer: 0,
    useTimer: 0,
  };

  let safeRoomHold = 0;
  let roomStall = 0;
  let completed = false;
  // Pacing evidence: how long the Director spent in each mood.
  const moodTime: Record<string, number> = {};
  let lastMood = director.snapshot.mood;
  let peakIntensity = 0;
  let peakLive = 0;
  let nextReport = 20;
  let walked = 0;
  let lastStep: THREE.Vector3 = player.position.clone();

  const wallStart = Date.now();
  for (let step = 0; step < steps; step++) {
    const t = step * dt;
    input.beginFrame();
    runBot(input, player, entities, level, dt, memory);

    // ---- engine step order (see Engine.step) ----------------------------
    if (DEBUG && t > 500 && step % 60 === 0) {
      const d = Math.hypot(memory.waypoint.x - player.position.x, memory.waypoint.z - player.position.z);
      console.log(
        `   t ${t.toFixed(1)} pos ${player.position.x.toFixed(2)},${player.position.y.toFixed(2)},${player.position.z.toFixed(2)} vel ${Math.hypot(player.velocity.x, player.velocity.z).toFixed(2)} ` +
          `yaw ${player.yaw.toFixed(2)} want ${input.wantYaw.toFixed(2)} wp ${memory.waypoint.x.toFixed(1)},${memory.waypoint.z.toFixed(1)} d ${d.toFixed(1)} ` +
          `grounded ${player.grounded} prompt ${player.interactPrompt ?? '-'} hurt ${player.health.toFixed(0)} near ${nearestThreatDistance(player, entities).toFixed(1)} ` +
          `keys ${['forward','back','left','right','sprint','jump'].filter((k) => input.action(k as never)).join(',') || '-'} stuck ${memory.stuck.toFixed(2)} ` +
          `guide ${memory.guideDistance} live ${entities.zombies.filter((z) => z.alive).length} ` +
          `mark ${level.objectiveMarker()?.label ?? '-'}@${(level.objectiveMarker()?.distance ?? -1).toFixed(1)} prog ${level.progress.toFixed(2)}`,
      );
    }
    if (DEBUG && t > 3.0 && t < 4.2 && step % 6 === 0) {
      const probe = { y: 0, surface: '' } as never;
      world.groundAt(player.position.x, player.position.z, player.position.y + 1.2, 0.4, probe as never);
      console.log(
        `   t ${t.toFixed(2)} pos ${player.position.x.toFixed(2)},${player.position.y.toFixed(2)},${player.position.z.toFixed(2)} vy ${player.velocity.y.toFixed(2)} ` +
          `grounded ${player.grounded} yaw ${player.yaw.toFixed(2)} want ${input.wantYaw.toFixed(2)} probe ${(probe as { y: number }).y.toFixed(2)}/${(probe as { surface: string }).surface}`,
      );
    }
    if (DEBUG && step % 60 === 0) console.log(`   t ${t.toFixed(1)}s pos ${player.position.x.toFixed(1)},${player.position.y.toFixed(2)},${player.position.z.toFixed(1)} vy ${player.velocity.y.toFixed(2)} grounded ${player.grounded} prompt ${player.interactPrompt ?? '-'}`);
    player.step(dt, true);
    player.updateStatus(dt);


    const living = squad.filter((s) => !s.dead);
    const lead = (entities.leadSurvivor as Survivor | null) ?? player;
    const diff = difficultyDef(settings.current.difficulty);
    for (const ai of teammates) {
      if (ai.dead) continue;
      const threats: Zombie[] = [];
      for (const z of entities.zombies) {
        if (!z.alive) continue;
        if (z.position.distanceToSquared(ai.position) > 900) continue;
        threats.push(z);
        if (threats.length >= 16) break;
      }
      ai.update(dt, {
        leadPos: lead.position,
        leadSlot: lead.flowSlot,
        threats,
        zombieDamage: diff.zombieDamage,
        // Mirror `Engine.step`: while the player waits inside the safe room for
        // stragglers, the leash pulls them in — the ending needs the whole squad.
        regroup: roomStall > 8,
      });
    }


    entities.update(dt, {
      zombieDamage: diff.zombieDamage,
      zombieHealth: diff.specialHealth,
      friendlyFire: settings.current.friendlyFire,
    });
    level.update(dt, player.position, player.alive);
    director.update(dt, player, living);
    items.update(player.position, level.progress);
    items.updateVisuals(dt, t);

    if (step % 3 === 0) {
      zombieRig.update(entities.zombies, dt * 3, camera.position);
      survivorRig.sync(squad, dt * 3, t);
    }
    effects.update(dt);
    audio.tick(dt);
    music.update(dt);

    for (const trigger of level.checkTriggers(player.position)) {
      switch (trigger.kind) {
        case 'horde':
        case 'ambush':
        case 'crescendo':
        case 'gauntlet':
        case 'final_defence':
          director.triggerHorde(trigger.waveScale, 40);
          console.log(`      [trigger] ${trigger.kind}: ${trigger.name}`);
          break;
        case 'tank':
          console.log(`      [trigger] tank: ${trigger.name} -> ${director.forceTank(trigger.name) ? 'spawned' : 'blocked by cooldown'}`);
          break;
        case 'witch':
          director.forceWitch(new THREE.Vector3(trigger.x, level.floorAt(trigger.x, trigger.z), trigger.z));
          break;
        default:
          break;
      }
    }

    // Safe-room end condition (mirrors Engine.updateSafeRoom).
    const room = layout.safeRoom;
    const playerInRoom = Math.hypot(player.position.x - room.x, player.position.z - room.z) < Math.max(room.width, room.depth) * 0.75;
    if (
      living.length > 0 &&
      living.every((s) => Math.hypot(s.position.x - room.x, s.position.z - room.z) < Math.max(room.width, room.depth) * 0.75)
    ) {
      safeRoomHold += dt;
      if (safeRoomHold > 3) {
        completed = true;
        console.log(`      [${fmt(t)}] SAFE ROOM REACHED`);
        break;
      }
    } else {
      safeRoomHold = 0;
      roomStall = playerInRoom && !player.dead ? roomStall + dt : 0;
    }

    walked += player.position.distanceTo(lastStep);
    lastStep.copy(player.position);

    // NaN guard: a non-finite health means something divided by zero, and it
    // silently disables every damage/AI check that reads it. Catch it early.
    for (const s of squad) {
      if (!Number.isFinite(s.health) || !Number.isFinite(s.position.x) || !Number.isFinite(s.char.velocity.x)) {
        console.log(`      !! NON-FINITE STATE at ${t.toFixed(2)}s: ${s.name} health=${s.health} pos=${s.position.toArray()} vel=${s.char.velocity.toArray()}`);
        console.log(`         pinned=${s.pinnedBy?.variant ?? '-'} pinKind=${s.pinKind ?? '-'} incap=${s.incapacitated} tempHealth=${s.tempHealth}`);
        process.exitCode = 2;
        step = steps;
        break;
      }
    }
    const snap = director.snapshot;
    if (snap.mood !== lastMood) {
      console.log(`      [${fmt(t)}] director mood ${lastMood} -> ${snap.mood}`);
      lastMood = snap.mood;
    }
    moodTime[snap.mood] = (moodTime[snap.mood] ?? 0) + dt;
    peakIntensity = Math.max(peakIntensity, snap.intensity);
    peakLive = Math.max(peakLive, entities.population);

    if (player.dead) {
      console.log(`      [${fmt(t)}] PLAYER DIED (${player.causeOfDeath || 'unknown'})`);
      break;
    }

    if (t >= nextReport) {
      nextReport += 20;
      const rows = teammates
        .map((a) => `${a.name.split(' ')[0]} ${a.dead ? 'DEAD' : a.incapacitated ? 'DOWN' : `${Math.round(a.health)}hp`}`)
        .join(' · ');
      console.log(
        `    [${fmt(t)}] route ${(level.progress * 100).toFixed(0)}% · pos ${player.position.x.toFixed(1)},${player.position.y.toFixed(1)},${player.position.z.toFixed(1)} · ` +
          `wp ${memory.waypoint.x.toFixed(1)},${memory.waypoint.z.toFixed(1)} · player ${Math.round(player.health)}hp · ` +
          `director ${snap.mood} ${(snap.intensity * 100).toFixed(0)}% · live ${entities.population} · kills ${kills} · | ${rows}`,
      );
    }

    input.endFrame();
  }

  const wall = (Date.now() - wallStart) / 1000;
  const perStepMs = (wall * 1000) / Math.max(1, steps);
  console.log('');
  console.log(`SIM done in ${wall.toFixed(2)}s wall (${(seconds / Math.max(0.001, wall)).toFixed(1)}x realtime, ${perStepMs.toFixed(3)} ms/step)`);
  console.log(`    result           ${completed ? 'SAFE ROOM REACHED' : player.dead ? 'PLAYER DIED' : 'TIME EXPIRED'}`);
  console.log(`    route progress   ${(level.progress * 100).toFixed(0)}%`);
  console.log(`    distance walked  ${walked.toFixed(0)} m`);
  console.log(`    kills            ${kills} (${headshots} headshots, ${specialKills} special)`);
  console.log(`    downs / revives  ${downs} / ${revives}`);
  console.log(
    `    combat events    all damaged hits ${allHits} · weapon:fire ${fireEvents} · dry clicks ${dryEvents} · reloads ${reloadStarts} started / ${reloadEnds} finished`,
  );
  const pellets = player.weapons?.pelletsFired ?? 0;
  const accuracy = pellets > 0 ? (hits / pellets) * 100 : 0;
  console.log(
    `    player damage    ${hits} hits / ${pellets} projectiles (${accuracy.toFixed(0)}% on target) · ${dealt.toFixed(0)} damage dealt`,
  );
  console.log(
    `    director         peak ${(peakIntensity * 100).toFixed(0)}% · mood ${director.snapshot.mood} · hordes ${director.totals.hordeEvents} · ` +
      `spawned ${director.totals.spawned} (${director.totals.specialsSpawned} special, ${director.totals.tanksSpawned} tank, ${director.totals.witchesSpawned} witch)`,
  );
  console.log(`    infected         peak live ${peakLive} · alive at end ${entities.population}`);
  console.log(`    loot             ${items.itemCount} pickups streamed`);
  const totalMoodTime = Object.values(moodTime).reduce((a, b) => a + b, 0) || 1;
  const timeline = ['relax', 'build', 'sustain', 'peak', 'fade']
    .map((m) => `${m} ${(((moodTime[m] ?? 0) / totalMoodTime) * 100).toFixed(0)}%`)
    .join(' · ');
  console.log(`    pacing           ${timeline}`);
  console.log(`    fights/min       ${((director.totals.hordeEvents + director.totals.specialsSpawned) / Math.max(1, seconds / 60)).toFixed(1)}`);

  zombieRig.clear();
  survivorRig.clear();
  effects.dispose();
  audio.dispose();
  music.dispose();

  // A chapter that does not finish is only a failure if the bot also died or got
  // permanently stuck; timeouts are reported so pacing can be judged by hand.
  return completed ? 0 : player.dead ? 1 : 0;
}

const DEBUG = process.argv.includes('--debug');

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

installCanvasStub();
process.exitCode = main();
