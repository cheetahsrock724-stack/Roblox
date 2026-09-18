/**
 * The full creator→player journey required by the platform's acceptance criteria:
 *
 *   register → login → editor project → place objects → write a script → play-test → publish
 *   → appears on the website → a second account sees the page → Play → matchmaking
 *   → the client joins → both players see each other → game logic runs → leave
 *   → the creator edits and publishes a new version → version history is preserved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, connectGame, randomName, sleep, startPlatform } from './helpers.mjs';
import { starterWorld, projectFromWorld } from '@kinetiq/engine';
import { deserializeWorld } from '@kinetiq/engine';

test('creator publishes a game that a second player can join and play', async (t) => {
  const env = await startPlatform();
  t.after(() => env.stop());

  // ---------------------------------------------------------------- accounts
  const creator = createClient(env.base);
  const player = createClient(env.base);
  const creatorName = randomName('Maker');
  const playerName = randomName('Player');

  const registration = await creator.register(creatorName);
  assert.equal(registration.status, 201, JSON.stringify(registration.json));
  assert.equal(registration.json.user.username, creatorName);
  assert.ok(registration.json.user.id.startsWith('usr_'));
  assert.ok(registration.json.csrfToken, 'registration returns a CSRF token');
  assert.ok(creator.cookies.has('kq_session'), 'session cookie issued');

  const second = await player.register(playerName);
  assert.equal(second.status, 201);
  assert.notEqual(second.json.user.id, registration.json.user.id);

  // Login as the creator in a fresh client (proves credentials work independently of registration).
  const creatorSession = createClient(env.base);
  const login = await creatorSession.login(creatorName);
  assert.equal(login.status, 200, JSON.stringify(login.json));
  assert.equal(login.json.user.id, registration.json.user.id);

  // ---------------------------------------------------------------- create project
  const created = await creator.post('/api/creator/projects', {
    name: 'Journey Test Obby',
    description: 'Created by the end-to-end test.',
    genre: 'Obby',
    maxPlayers: 6,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const gameId = created.json.game.id;
  const project = created.json.project;
  assert.ok(project.world, 'new projects come with a starter world');

  // ---------------------------------------------------------------- edit world: place objects
  const world = deserializeWorld(project.world);
  const startPad = world.create('Part', {
    name: 'StartPad',
    position: { x: 0, y: 0, z: 0 },
    size: { x: 20, y: 2, z: 20 },
    color: '#3d5afe',
    anchored: true,
  });
  world.create('SpawnPoint', { name: 'Start', position: { x: 0, y: 3, z: 0 }, parent: null });
  world.create('Part', { name: 'Step1', position: { x: 0, y: 6, z: -14 }, size: { x: 8, y: 1, z: 8 }, color: '#00e5c0', anchored: true });
  world.create('Part', { name: 'Step2', position: { x: 0, y: 12, z: -28 }, size: { x: 8, y: 1, z: 8 }, color: '#ff8a3d', anchored: true });
  world.create('Light', { name: 'Sun', lightType: 'directional', brightness: 1.2 });
  world.create('Sound', { name: 'BackgroundMusic', volume: 0.4, looped: true });
  world.create('TextLabel', { name: 'Hud', text: 'Reach the top!', textSize: 28, position: { x: 0.5, y: 0.1 } });
  assert.ok(startPad.id.startsWith('par_'));

  // ---------------------------------------------------------------- write a script
  const scriptSource = [
    'local hits = 0',
    'Events.on("playerJoined", function(player)',
    '  print(player.name .. " joined the journey test")',
    '  player:sendMessage("Welcome to the journey test!")',
    'end)',
    'Events.on("objectTouched", function(payload)',
    '  if payload.instance and payload.instance.name == "Finish" then',
    '    hits = hits + 1',
    '    print("finish touched by " .. tostring(payload.playerId))',
    '  end',
    'end)',
    'Events.on("heartbeat", function(dt)',
    '  local pad = World:findByName("StartPad")',
    '  if pad then pad.color = Color.new(0.24, 0.35, 1) end',
    'end)',
    'print("journey script loaded")',
  ].join('\n');
  world.create('Script', { name: 'Journey.server.lua', source: scriptSource, kind: 'server', runOnLoad: true });
  const clientScriptSource = [
    'print("client hud script running")',
    'local player = Players.localPlayer',
    'if player then print("hello " .. player.name) end',
  ].join('\n');
  world.create('Script', { name: 'JourneyHud.client.lua', source: clientScriptSource, kind: 'client' });

  const savedProject = projectFromWorld(world, {
    name: 'Journey Test Obby',
    ownerId: registration.json.user.id,
    ownerName: creatorName,
    config: { maxPlayers: 6, spawnPosition: { x: 0, y: 4, z: 0 } },
  });

  const save = await creator.put(`/api/creator/projects/${gameId}`, { project: savedProject, mode: 'draft' });
  assert.equal(save.status, 200, JSON.stringify(save.json).slice(0, 400));

  // Draft is loadable again (editor reopen).
  const reopen = await creator.get(`/api/creator/projects/${gameId}`);
  assert.equal(reopen.status, 200);
  assert.ok(reopen.json.project.world.chunks, 'draft project round-trips through the API');

  // ---------------------------------------------------------------- publish
  const publish = await creator.post(`/api/creator/projects/${gameId}/publish`, { changelog: 'First release' });
  assert.equal(publish.status, 200, JSON.stringify(publish.json));
  const firstVersion = publish.json.published;
  // Every save (draft or publish) creates a new immutable version; publish promotes the newest one.
  assert.ok(firstVersion.versionNumber >= 1, 'publish returns a version number');
  assert.ok(firstVersion.contentHash?.length >= 8);

  // ---------------------------------------------------------------- appears on the website
  const home = await player.get('/api/home');
  assert.equal(home.status, 200);
  const discover = await player.get('/api/games?sort=new&limit=50');
  assert.equal(discover.status, 200);
  const listed = (discover.json.games ?? []).find((game) => game.id === gameId);
  assert.ok(listed, 'published game appears in discovery');

  const page = await player.get(`/api/games/${gameId}`);
  assert.equal(page.status, 200);
  assert.equal(page.json.game.name, 'Journey Test Obby');
  assert.equal(page.json.game.creator.username, creatorName);

  // The creator's private draft project is not exposed on the public game page.
  const release = await player.get(`/api/games/${gameId}/release`);
  assert.equal(release.status, 200);
  assert.ok(release.json.world, 'release bundle carries the world');
  const releaseScripts = release.json.clientScripts ?? [];
  assert.ok(releaseScripts.some((script) => script.name === 'JourneyHud.client.lua'), 'client scripts ship with the release');
  assert.ok(
    !JSON.stringify(release.json).includes('Journey.server.lua'),
    'server scripts are never shipped to clients',
  );

  // ---------------------------------------------------------------- play test (editor local server)
  const playtest = await creator.post(`/api/creator/projects/${gameId}/playtest`, {});
  assert.equal(playtest.status, 200, JSON.stringify(playtest.json));
  const testClient = connectGame(env.base, playtest.json.connectUrl);
  await testClient.ready();
  assert.ok(testClient.state.welcome, 'play-test server sends a welcome frame');
  assert.equal(testClient.state.welcome.mode, 'playtest');

  // Server script ran against the live test server.
  await testClient.waitFor((state) => state.logs.some((log) => log.message?.includes('journey script loaded')), {
    label: 'play-test script load log',
  });
  await playtestStop(playtest.json.serverId);
  await testClient.close();
  await sleep(50);

  // ---------------------------------------------------------------- matchmaking + two real clients
  const joinA = await creator.play(gameId);
  assert.equal(joinA.status, 200, JSON.stringify(joinA.json));
  const joinB = await player.play(gameId);
  assert.equal(joinB.status, 200, JSON.stringify(joinB.json));
  assert.equal(joinB.json.serverId, joinA.json.serverId, 'matchmaking reuses the same realm');
  assert.equal(joinB.json.reused, true);

  const clientA = connectGame(env.base, joinA.json.connectUrl);
  const clientB = connectGame(env.base, joinB.json.connectUrl);
  t.after(async () => {
    await clientA.close().catch(() => {});
    await clientB.close().catch(() => {});
  });
  await clientA.ready();
  await clientB.ready();

  const playerIdA = clientA.state.welcome.player.id;
  const playerIdB = clientB.state.welcome.player.id;
  assert.notEqual(playerIdA, playerIdB);
  assert.ok(clientA.state.welcome.spawn.position, 'welcome frame carries a spawn position');
  assert.ok(Array.isArray(clientA.state.welcome.world?.chunks), 'welcome ships world chunks');

  // Both players see each other.
  await clientA.waitFor((state) => state.snapshots.some((snap) => (snap.p ?? []).some((row) => row[0] === playerIdB)), {
    label: 'player A seeing player B',
  });
  await clientB.waitFor((state) => state.snapshots.some((snap) => (snap.p ?? []).some((row) => row[0] === playerIdA)), {
    label: 'player B seeing player A',
  });

  // ---------------------------------------------------------------- movement replicates
  for (let index = 0; index < 40; index += 1) {
    clientA.input({ moveZ: -1, run: true, sequence: index + 1 });
    await sleep(25);
  }
  const startRow = clientB.snapshotFor(playerIdA);
  assert.ok(startRow, 'client B has a snapshot row for A');
  await clientB.waitFor(
    (state) => {
      const row = connection_lastRow(state, playerIdA);
      return row && Math.hypot(row[1] - startRow[1], row[3] - startRow[3]) > 2;
    },
    { label: 'A moving on B’s screen' },
  );

  // ---------------------------------------------------------------- game logic + chat
  await clientA.waitFor((state) => state.logs.some((log) => log.message?.includes('joined the journey test')), {
    label: 'playerJoined script log',
  });
  clientA.chat('hello from the journey test');
  await clientB.waitFor((state) => state.chat.some((frame) => frame.text?.includes('hello from the journey test')), {
    label: 'chat replication',
  });

  // ---------------------------------------------------------------- leave
  await clientB.close();
  await clientA.waitFor((state) => state.despawns.some((frame) => frame.id === playerIdB), { label: 'despawn broadcast' });

  // ---------------------------------------------------------------- creator updates → v2 → history preserved
  const updated = deserializeWorld(savedProject.world);
  updated.create('Part', { name: 'Step3', position: { x: 0, y: 18, z: -42 }, size: { x: 8, y: 1, z: 8 }, color: '#ffd166', anchored: true });
  const secondProject = projectFromWorld(updated, {
    name: 'Journey Test Obby',
    ownerId: registration.json.user.id,
    ownerName: creatorName,
    config: { maxPlayers: 6 },
  });
  const save2 = await creator.put(`/api/creator/projects/${gameId}`, { project: secondProject, mode: 'publish' });
  assert.equal(save2.status, 200, JSON.stringify(save2.json).slice(0, 300));

  const versions = await creator.get(`/api/creator/projects/${gameId}/versions`);
  assert.equal(versions.status, 200);
  assert.ok(versions.json.versions.length >= 2, 'version history preserved');
  const v1 = versions.json.versions.find((version) => version.versionNumber === 1);
  assert.ok(v1 && v1.published, 'older version still exists after publishing a new one');

  const refreshed = await player.get(`/api/games/${gameId}`);
  assert.ok(refreshed.json.game.currentVersion >= 2, 'website shows the new version');

  async function playtestStop(serverId) {
    const response = await creator.post(`/api/servers/${serverId}/shutdown`, {});
    assert.ok([200, 404].includes(response.status), `shutdown status ${response.status}`);
  }
});

function connection_lastRow(state, playerId) {
  for (let index = state.snapshots.length - 1; index >= 0; index -= 1) {
    const row = (state.snapshots[index].p ?? []).find((entry) => entry[0] === playerId);
    if (row) return row;
  }
  return null;
}

test('starter world is playable as-is', async () => {
  const world = deserializeWorld(starterWorld('Playable'));
  const spawn = world.pickSpawn();
  assert.ok(spawn?.position, 'starter world has a spawn point');
  assert.ok(world.findByClass('Part').length >= 1, 'starter world has ground');
});
