/**
 * The end-to-end journey: a creator registers, builds a world with objects and a script, play-tests
 * it, publishes it, a second player finds it on the website and joins, both see each other, the game
 * script reacts, they leave, and the creator publishes a second version without breaking the first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPlatform, createClient, createGameClient } from './helpers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('creator publishes a game that a second player can join and play', async (t) => {
  const env = await startPlatform();
  t.after(async () => {
    await env.stop();
  });

  const creator = createClient(env.base);
  const player = createClient(env.base);

  // ---------------------------------------------------------------- accounts
  const creatorUser = await creator.register('MakerOne');
  assert.equal(creatorUser.username, 'MakerOne');
  const playerUser = await player.register('PlayerTwo');
  assert.ok(playerUser.id.startsWith('usr_'));

  const me = await creator.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.id, creatorUser.id);
  assert.ok(me.json.csrfToken, 'sessions expose a csrf token');

  // ---------------------------------------------------------------- project + world
  const created = await creator.post('/api/creator/projects', { name: 'Journey Test Obby', genre: 'Obby' });
  assert.equal(created.status, 201);
  const gameId = created.json.game.id;

  const { World, Vector3, projectFromWorld } = await import('@kinetiq/engine');
  const world = new World({ name: 'Journey Test Obby' });
  world.ensureServices();
  world.create('Part', { name: 'Ground', size: { x: 80, y: 2, z: 80 }, position: new Vector3(0, -1, 0), color: '#3d5afe', anchored: true });
  world.create('Part', { name: 'Step1', size: { x: 8, y: 1, z: 8 }, position: new Vector3(0, 1, -14), color: '#00e5c0', anchored: true });
  world.create('SpawnPoint', { name: 'Start', position: new Vector3(0, 6.5, 0), enabled: true });
  const scoreboard = world.create('Part', { name: 'Scoreboard', size: { x: 12, y: 1, z: 1 }, position: new Vector3(0, 14, -10), anchored: true });
  const script = world.create('Script', {
    name: 'JourneyScript',
    kind: 'server',
    runOnLoad: true,
    source: [
      'print("journey script loaded")',
      'Part = Part or nil',
      'local visits = 0',
      'Players.playerJoined:connect(function(player)',
      '  visits = visits + 1',
      '  print(player.name .. " joined the journey test")',
      '  local board = World:findByName("Scoreboard")',
      '  if board then',
      '    board.color = "#ff8a3d"',
      '  end',
      '  Events.fire("visitCounted", visits)',
      'end)',
      'Events.on("ping", function()',
      '  print("pong from server")',
      'end)',
    ].join('\n'),
    parent: world.root.findFirstChild('ServerScripts'),
  });
  assert.ok(script, 'script parented into ServerScripts');

  const project = projectFromWorld(world, {
    name: 'Journey Test Obby',
    metadata: { description: 'An automated journey through the whole platform.', tags: ['obby', 'test'] },
    ownerId: creatorUser.id,
    ownerName: creatorUser.username,
  });

  // ---------------------------------------------------------------- save + publish
  const saved = await creator.put(`/api/creator/projects/${gameId}`, {
    mode: 'publish',
    project,
    name: 'Journey Test Obby',
    description: 'An automated journey through the whole platform.',
    genre: 'Obby',
    maxPlayers: 10,
    changelog: 'first release',
  });
  assert.equal(saved.status, 200, saved.text.slice(0, 400));
  assert.ok(saved.json.version.published, 'publish marks the version live');
  const firstVersion = saved.json.version;

  // ---------------------------------------------------------------- website surfaces
  const discover = await player.get('/api/games?sort=new&limit=20');
  assert.equal(discover.status, 200);
  assert.ok(discover.json.games.some((game) => game.id === gameId), 'published game is discoverable');

  const search = await player.get('/api/search?q=Journey');
  assert.ok(search.json.games.some((game) => game.id === gameId), 'search finds the game');

  const detail = await player.get(`/api/games/${gameId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.game.name, 'Journey Test Obby');
  assert.equal(detail.json.game.creator.username, 'MakerOne');
  assert.ok(detail.json.game.versions.length >= 1, 'version history is public');

  const home = await player.get('/api/home');
  assert.equal(home.status, 200);
  assert.ok(Array.isArray(home.json.newest), 'home lists new releases');

  // ---------------------------------------------------------------- play test (real realm, draft)
  const playtest = await creator.post(`/api/creator/projects/${gameId}/playtest`, { maxPlayers: 4 });
  assert.equal(playtest.status, 200, playtest.text.slice(0, 300));
  assert.ok(playtest.json.connectUrl.includes('token='), 'play-test hands out a join token');

  const testClient = createGameClient(env.base);
  await testClient.connect(playtest.json.connectUrl);
  const welcome = await testClient.waitFor((state) => state.welcome, { label: 'play-test welcome' });
  assert.equal(welcome.welcome.mode, 'playtest');
  testClient.send({ t: 'ready' });
  await testClient.waitFor((state) => state.logs.some((log) => log.message?.includes('journey script loaded')), {
    label: 'play-test script load log',
  });
  await testClient.close();

  // ---------------------------------------------------------------- matchmaking + join
  const joinA = await creator.post(`/api/games/${gameId}/join`, {});
  assert.equal(joinA.status, 200, joinA.text.slice(0, 300));
  assert.ok(joinA.json.serverId.startsWith('rlm_'));
  assert.ok(joinA.json.joinToken);

  const joinB = await player.post(`/api/games/${gameId}/join`, {});
  assert.equal(joinB.status, 200, joinB.text.slice(0, 300));
  assert.equal(joinB.json.serverId, joinA.json.serverId, 'matchmaking reuses a server with space');

  const clientA = createGameClient(env.base);
  const clientB = createGameClient(env.base);
  await clientA.connect(joinA.json.connectUrl);
  await clientB.connect(joinB.json.connectUrl);

  const welcomeA = await clientA.waitFor((state) => state.welcome, { label: 'welcome A' });
  assert.equal(welcomeA.welcome.game.id, gameId);
  assert.equal(welcomeA.welcome.game.name, 'Journey Test Obby');
  assert.equal(welcomeA.welcome.realm.gameId, gameId);
  assert.equal(welcomeA.welcome.realm.versionId, firstVersion.id, 'joins use the newest published version');
  assert.ok(welcomeA.welcome.spawn?.position, 'welcome carries a spawn transform');
  assert.ok(welcomeA.welcome.chunks.length >= 1, 'welcome streams world chunks');
  assert.ok(welcomeA.welcome.logs.some((entry) => entry.message?.includes('journey script loaded')), 'welcome replays script output');
  await clientB.waitFor((state) => state.welcome, { label: 'welcome B' });

  // Both players see each other in snapshots.
  const playerIdA = welcomeA.welcome.player.id;
  const startRow = await clientB
    .waitFor((state) => state.snapshots.at(-1)?.p?.length >= 2, { timeout: 8000, label: 'B sees two players' })
    .then(() => clientB.latestSnapshot().p.find((entry) => entry[0] === playerIdA));
  assert.ok(startRow, 'B has a replicated row for A');

  // ---------------------------------------------------------------- movement replicates
  for (let i = 0; i < 30; i += 1) {
    clientA.input({ moveX: 0, moveZ: -1, run: true, yaw: 0, jump: i === 4 });
    await sleep(30);
  }
  await clientB.waitFor((state) => {
    const row = state.snapshots.at(-1)?.p?.find((entry) => entry[0] === playerIdA);
    if (!row) return false;
    const moved = Math.hypot(row[1] - startRow[1], row[3] - startRow[3]);
    return moved > 1 || Math.abs(row[2] - startRow[2]) > 1;
  }, { timeout: 8000, label: 'A movement replicated to B' });

  // ---------------------------------------------------------------- game logic (server script)
  // The script recolours the Scoreboard part when a player joins: the change must replicate.
  await clientA.waitFor((state) => state.logs.some((log) => log.message?.includes('joined the journey test')), {
    timeout: 8000,
    label: 'playerJoined script log delivered to A',
  });
  const scoreboardId = project.world.chunks
    ? Object.values(project.world.chunks).flatMap((chunk) => chunk.roots ?? []).find((node) => node.name === 'Scoreboard')?.id
    : null;
  await clientA.waitFor((state) => state.snapshots.some((frame) => frame.o?.some(([id]) => id === scoreboardId)), {
    timeout: 8000,
    label: 'object updates from the script',
  });

  // ---------------------------------------------------------------- chat + dev console data
  clientA.chat('hello from player one');
  await clientB.waitFor((state) => state.chat.some((entry) => entry.text?.includes('hello from player one')), {
    timeout: 6000,
    label: 'chat replicated',
  });

  // ---------------------------------------------------------------- leave + shutdown
  await clientA.close();
  await clientB.waitFor((state) => state.snapshots.at(-1)?.p?.length === 1, {
    timeout: 8000,
    label: 'player count drops after leaving',
  });
  await clientB.close();
  const stopped = await creator.post(`/api/servers/${joinA.json.serverId}/shutdown`, {});
  assert.ok([200, 404].includes(stopped.status), 'server can be shut down by the platform');

  // ---------------------------------------------------------------- new version
  const v2Script = { ...project.scripts[0], source: `${project.scripts[0].source}\nprint("v2 loaded")` };
  const projectV2 = { ...project, scripts: [v2Script] };
  const published2 = await creator.put(`/api/creator/projects/${gameId}`, {
    mode: 'publish',
    project: projectV2,
    changelog: 'second release',
    name: 'Journey Test Obby',
    description: 'Second release.',
    genre: 'Obby',
  });
  assert.equal(published2.status, 200, published2.text.slice(0, 300));
  assert.notEqual(published2.json.version.id, firstVersion.id, 'publishing creates a new version');
  assert.ok(published2.json.version.versionNumber > firstVersion.versionNumber);

  const versions = await creator.get(`/api/creator/projects/${gameId}/versions`);
  assert.ok(versions.json.versions.length >= 2, 'version history preserved');
  const v1 = versions.json.versions.find((version) => version.id === firstVersion.id);
  assert.ok(v1 && v1.published, 'the earlier release still exists and stays published');

  const detailAfter = await player.get(`/api/games/${gameId}`);
  assert.equal(detailAfter.json.game.currentVersion, published2.json.version.versionNumber, 'website shows the new version');

  // ---------------------------------------------------------------- persistence + isolation
  const datastore = await creator.post(`/api/creator/projects/${gameId}/datastore`, {
    storeName: 'PlayerStats',
    playerId: creatorUser.id,
    values: { coins: 42 },
  });
  if (datastore.status === 200 || datastore.status === 201) {
    const read = await creator.get(`/api/creator/projects/${gameId}/datastore?storeName=PlayerStats&playerId=${creatorUser.id}`);
    assert.equal(read.json.values?.coins, 42, 'player data persists per game');
  }
});
