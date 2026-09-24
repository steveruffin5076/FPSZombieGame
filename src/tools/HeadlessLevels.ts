/**
 * HEADLESS LEVEL CHECK
 * ====================
 * A development tool, not part of the game bundle. Run it with:
 *
 *     npm run check:levels
 *
 * The level generator is deliberately pure — it writes colliders into a
 * `CollisionWorld` and data into a `LevelLayout`, and never touches WebGL — so
 * it can run in Node with a stubbed 2D canvas. That is how the pipeline is
 * validated without launching a browser:
 *
 *   - every chapter generates in a sane amount of time,
 *   - the route is walkable end to end (a chapter you cannot finish is a bug),
 *   - the Director has usable spawn anchors, near and far,
 *   - loot spots and triggers land on ground the player can reach,
 *   - the entity manager and Director can start against a real layout.
 */
import { CAMPAIGN } from '@/config/campaign';
import { QUALITY_PRESETS, SettingsStore, difficultyDef } from '@/core/Settings';
import { CollisionWorld } from '@/physics/Collision';
import { NAV_FLAG } from '@/world/Nav';
import { Level } from '@/world/Level';
import { MaterialLibrary, ProceduralTextures, VfxTextures } from '@/render/Materials';
import { AudioSystem } from '@/audio/Audio';
import { MusicDirector } from '@/audio/Music';
import { Effects } from '@/vfx/Effects';
import { ItemManager } from '@/world/Items';
import { EntityManager } from '@/entities/EntityManager';
import { Director } from '@/director/Director';
import { installCanvasStub } from '@/tools/CanvasStub';

declare const process: { exitCode: number };

function row(label: string, value: string | number): string {
  return `${label.padEnd(24)} ${value}`;
}

function main(): number {
  const quality = { ...QUALITY_PRESETS.high };
  const settings = new SettingsStore();
  const vfx = new VfxTextures();
  const materials = new MaterialLibrary(new ProceduralTextures());
  const audio = new AudioSystem(settings.current);
  const music = new MusicDirector(audio);
  const effects = new Effects(vfx, quality);

  let failures = 0;
  const fail = (msg: string): void => {
    failures += 1;
    console.log(`  !! ${msg}`);
  };

  for (const chapter of CAMPAIGN) {
    console.log('='.repeat(74));
    console.log(`CHAPTER ${chapter.index + 1}: ${chapter.name}   seed 0x${chapter.seed.toString(16)}`);
    console.log('='.repeat(74));

    const world = new CollisionWorld();
    const level = new Level(world, materials, vfx, quality);
    const t0 = Date.now();
    const layout = level.load(chapter, () => undefined);
    const genMs = Date.now() - t0;

    console.log(row('generate', `${genMs} ms`));
    console.log(row('bounds', `${layout.bounds.maxX - layout.bounds.minX}x${layout.bounds.maxZ - layout.bounds.minZ} m, maxY ${layout.bounds.maxY.toFixed(1)}`));
    console.log(row('colliders', `${world.boxes.length} boxes, ${world.ramps.length} ramps`));
    console.log(row('geometry', `${layout.stats.buildings} buildings, ${layout.stats.rooms} rooms`));
    console.log(row('batches', `${layout.batches.size} materials, ${(layout.stats.triangles / 1000).toFixed(1)}k tris`));
    console.log(row('doors / breakables', `${layout.doors.length} / ${layout.breakables.length}`));
    console.log(row('lights / decals', `${layout.lights.length} / ${layout.decals.length}`));

    // --- navigation ------------------------------------------------------
    const nav = level.nav;
    let walkable = 0;
    let onRoute = 0;
    let interior = 0;
    for (let cz = 0; cz < nav.h; cz++) {
      for (let cx = 0; cx < nav.w; cx++) {
        if (!nav.isWalkableCellIndex(cx, cz)) continue;
        walkable++;
        const flags = nav.getCellFlagsByIndex(cx, cz);
        if (flags & NAV_FLAG.ON_ROUTE) onRoute++;
        if (flags & NAV_FLAG.INTERIOR) interior++;
      }
    }
    console.log(row('nav', `${nav.w}x${nav.h} cells · ${walkable} walkable · ${onRoute} on route · ${interior} interior`));
    if (walkable < 1200) fail(`only ${walkable} walkable cells — the map is mostly solid`);
    if (onRoute < 200) fail(`only ${onRoute} cells flagged as route — pathing toward the safe room will be poor`);

    const route = level.routeSamples;
    let blockedRoute = 0;
    for (const p of route) {
      const cx = Math.floor((p.x - nav.minX) / nav.cellSize);
      const cz = Math.floor((p.z - nav.minZ) / nav.cellSize);
      let ok = nav.isWalkableCellIndex(cx, cz);
      for (let dz = -1; dz <= 1 && !ok; dz++) {
        for (let dx = -1; dx <= 1 && !ok; dx++) ok = nav.isWalkableCellIndex(cx + dx, cz + dz);
      }
      if (!ok) blockedRoute++;
    }
    console.log(row('route', `${route.length} samples · ${blockedRoute} blocked`));
    if (blockedRoute > 0) fail(`${blockedRoute} route samples are not walkable — the safe room may be unreachable`);

    // --- anchors ---------------------------------------------------------
    const anchors = layout.spawnAnchors;
    const near = anchors.filter((a) => a.routeDistance <= 8 && !(a.flags & NAV_FLAG.INTERIOR)).length;
    const far = anchors.filter((a) => a.routeDistance > 8 && !(a.flags & NAV_FLAG.INTERIOR)).length;
    const inside = anchors.filter((a) => a.flags & NAV_FLAG.INTERIOR).length;
    const climb = anchors.filter((a) => a.y > 0.6).length;
    console.log(row('spawn anchors', `${anchors.length} · near ${near} · far ${far} · interior ${inside} · elevated ${climb}`));
    if (anchors.length < 40) fail(`only ${anchors.length} spawn anchors — hordes will trickle in`);
    if (near < 6) fail(`only ${near} close anchors — the Director cannot flank or ambush`);

    let buried = 0;
    for (const a of anchors) if (!nav.isWalkable(a.x, a.y, a.z)) buried++;
    if (buried > 0) fail(`${buried} spawn anchors are buried in geometry`);

    // --- loot + triggers -------------------------------------------------
    const badSpots = layout.itemSpots.filter((s) => !nav.isWalkable(s.x, s.y, s.z)).length;
    console.log(row('item spots', `${layout.itemSpots.length} · ${badSpots} unreachable`));
    if (layout.itemSpots.length > 0 && badSpots > layout.itemSpots.length * 0.25) {
      fail(`${badSpots}/${layout.itemSpots.length} item spots are unreachable`);
    }

    const kinds = layout.triggers.map((t) => t.kind).join(', ') || '(none)';
    console.log(row('triggers', `${layout.triggers.length}: ${kinds}`));

    // --- systems that consume the layout ---------------------------------
    const entities = new EntityManager(world, nav, effects, audio, quality, {
      onZombieKilled: () => undefined,
      onZombieSpawned: () => undefined,
      onSurvivorDowned: () => undefined,
      onSurvivorDied: () => undefined,
      onSurvivorDamaged: () => undefined,
      onPin: () => undefined,
      onUnpin: () => undefined,
      onAbility: () => undefined,
      onDoorDamage: () => undefined,
      applyDamage: (t, amount, opts) => t.takeDamage(amount, opts),
    });
    const items = new ItemManager(world, materials, audio, effects);
    items.load(layout, level);

    const director = new Director(
      {
        difficulty: difficultyDef(settings.current.difficulty),
        seed: chapter.seed ^ 0x9e3779b9,
        ...chapter.director,
      },
      level,
      nav,
      entities,
      audio,
      music,
      effects,
      items,
    );
    director.start(layout);
    const snap = director.snapshot;
    console.log(row('director', `mood ${snap.mood} · intensity ${snap.intensity.toFixed(2)} · credit ${snap.credit.toFixed(2)}`));

    // Spawn a squad-sized horde at a legal spot and step the simulation.
    const centre = level.routePoint(0.5);
    let spawned = 0;
    for (let i = 0; i < 30; i++) {
      const z = entities.spawn('common', centre.x + (i % 6) * 2, centre.y + 0.2, centre.z + Math.floor(i / 6) * 2, 0, 1);
      if (z) spawned++;
    }
    for (let step = 0; step < 120; step++) entities.update(1 / 60, { zombieDamage: 1, zombieHealth: 1, friendlyFire: false });
    const moved = entities.zombies.filter((z) => z.alive).length;
    console.log(row('sim smoke test', `${spawned}/30 spawned · ${moved} alive after 2 s`));
    if (spawned === 0) fail('entity manager refused every spawn');
    if (spawned > 0 && moved === 0) fail('every spawned zombie died or despawned within two seconds');

    items.clear();
    entities.clear();
    director.finishChapter();
    level.disposeLayout();
    console.log('');
  }

  effects.dispose();
  audio.dispose();
  music.dispose();
  console.log(failures === 0 ? 'ALL CHAPTERS OK' : `${failures} CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

installCanvasStub();
process.exitCode = main();
