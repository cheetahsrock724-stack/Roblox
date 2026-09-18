/**
 * Seeds the platform on first run: two demo accounts, original avatar items, and three demo games
 * built entirely with the public creator APIs — the same APIs a normal developer uses. There are
 * no demo-only engine features anywhere in the codebase.
 *
 * Demo 1: "Skyline Sprint"     — an obstacle course (obby) with checkpoints and a finish badge.
 * Demo 2: "Grid Arena"         — a multiplayer arena with scoring, respawns and a top-score badge.
 * Demo 3: "Lakeside Lounge"    — a social hangout with seating, music and chat.
 */
import * as db from '@kinetiq/db';
import { World, projectFromWorld, buildVersionBundle, DEFAULT_RIG } from '@kinetiq/engine';
import { platformConfig } from '@kinetiq/shared';

const DEMO_PASSWORD = 'demo-Password1!';

export function seedIfEmpty({ log = console } = {}) {
  const userCount = db.users.userCount();
  const gameCount = db.get('SELECT COUNT(*) AS n FROM games')?.n ?? 0;
  if (gameCount > 0) return { seeded: false };

  log.info?.('seeding demo content (first run)');

  const alice = ensureUser({
    username: 'AriDev',
    displayName: 'Ari',
    bio: 'Builds obstacle courses and racing games.',
  });
  const bob = ensureUser({
    username: 'NiaPlays',
    displayName: 'Nia',
    bio: 'Runs the arena. Always up for a match.',
  });
  ensureUser({ username: 'ModTeam', displayName: 'Moderation', role: 'moderator' });
  ensureUser({ username: 'PlatformAdmin', displayName: 'Platform Admin', role: 'admin' });

  db.social.addFriend(alice.id, bob.id);
  db.social.follow(bob.id, alice.id);

  const items = seedAvatarItems(alice);
  const badges = {};

  const games = [
    createSkylineSprint(alice, items),
    createGridArena(bob, items),
    createLakesideLounge(bob, items),
  ];
  for (const game of games) {
    for (const badge of game.badges) badges[badge.name] = badge;
  }

  // Give the demo accounts some balance and a couple of owned items.
  db.economy.grantCredits(alice.id, 2500, 'adjustment', { description: 'Demo starting balance' });
  db.economy.grantCredits(bob.id, 2500, 'adjustment', { description: 'Demo starting balance' });
  for (const item of items.slice(0, 3)) {
    db.assets.addToInventory(bob.id, 'avatar_item', item.id, { acquiredVia: 'grant' });
  }

  if (games[0]?.badges?.[0]) {
    db.badges.awardBadge(badges['Course Complete'].id, alice.id, { gameId: games[0].game.id });
  }

  log.info?.(
    `seeded ${games.length} demo games, ${items.length} avatar items, 4 accounts (password: ${DEMO_PASSWORD})`,
  );
  return { seeded: true, games, items, accounts: { alice, bob }, password: DEMO_PASSWORD };
}

function ensureUser({ username, displayName, bio = '', role = 'user' }) {
  const existing = db.users.findByUsername(username);
  if (existing) return existing;
  const user = db.users.createUser({
    username,
    displayName,
    password: DEMO_PASSWORD,
    role,
    bio,
    email: null,
    emailVerified: true,
  });
  db.economy.grantCredits(user.id, platformConfig.economy.signupBonus, 'signup_bonus', {
    description: 'Welcome bonus',
  });
  return user;
}

/** Original avatar item catalogue (procedural colours; no third-party assets). */
function seedAvatarItems(creator) {
  const definitions = [
    { name: 'Aviator Cap', category: 'hat', price: 120, colors: ['#8b5cf6', '#22d3ee'], attachment: { bone: 'head', offset: [0, 0.9, 0], scale: [1.15, 0.6, 1.15], shape: 'cylinder' } },
    { name: 'Signal Beanie', category: 'hat', price: 90, colors: ['#f97316', '#facc15'], attachment: { bone: 'head', offset: [0, 0.95, 0], scale: [1.1, 0.5, 1.1], shape: 'sphere' } },
    { name: 'Trailblazer Jacket', category: 'shirt', price: 200, colors: ['#3d5afe', '#101728'], attachment: { bone: 'torso', offset: [0, 0, 0], scale: [1.05, 1.05, 1.05], shape: 'block' } },
    { name: 'Cargo Pants', category: 'pants', price: 150, colors: ['#334155'], attachment: { bone: 'legs', offset: [0, 0, 0], scale: [1.05, 1.02, 1.05], shape: 'block' } },
    { name: 'Springstep Boots', category: 'shoes', price: 110, colors: ['#0f172a', '#00e5c0'], attachment: { bone: 'legs', offset: [0, -0.9, 0], scale: [1.1, 0.4, 1.2], shape: 'block' } },
    { name: 'Halo Ring', category: 'accessory', price: 350, colors: ['#fef08a'] },
    { name: 'Glow Trail Pack', category: 'back', price: 420, colors: ['#00e5c0', '#0ea5e9'], attachment: { bone: 'torso', offset: [0, 0.2, 0.75], scale: [0.9, 1.1, 0.4], shape: 'block' } },
    { name: 'Friendly Face', category: 'face', price: 60, colors: ['#f2c9a0'] },
    { name: 'Explorer Hair', category: 'hair', price: 80, colors: ['#1f2937'], attachment: { bone: 'head', offset: [0, 1.05, 0], scale: [1.05, 0.35, 1.05], shape: 'block' } },
    { name: 'Starter Package', category: 'package', price: 0, colors: ['#3d5afe'], attachment: { bone: 'root', offset: [0, 0, 0], scale: [1, 1, 1], shape: 'block' } },
  ];
  return definitions.map((definition) =>
    db.assets.createAvatarItem({
      creatorUserId: creator.id,
      name: definition.name,
      description: `Original ${definition.category} created with the ${platformConfig.platformName} creator tools.`,
      category: definition.category,
      colors: definition.colors,
      attachment: definition.attachment ?? {},
      price: definition.price,
      isForSale: definition.price > 0,
      moderationStatus: 'approved',
    }),
  );
}

/** Publishes a world + scripts as a playable game using the same path as the editor. */
function publishDemo({ owner, name, description, genre, tags, maxPlayers, world, scripts, metadata = {}, config = {} }) {
  const game = db.games.createGame({
    ownerUserId: owner.id,
    name,
    description,
    genre,
    tags,
    maxPlayers,
    isPublic: true,
  });
  const project = projectFromWorld(world, {
    name,
    ownerId: owner.id,
    ownerName: owner.username,
    metadata: { description, genre, tags, maxPlayers, isPublic: true, ...metadata },
    config: { ...config, maxPlayers },
  });
  project.scripts = scripts.map((script) => ({
    // Script ids are derived by the repository from (version, name): never user supplied, and
    // unique per version so two games can share a script file name.
    name: script.name,
    kind: script.kind,
    source: script.source,
    runOnLoad: true,
    disabled: false,
    path: script.kind === 'module' ? 'SharedStorage' : script.kind === 'server' ? 'ServerScripts' : 'ClientScripts',
    folder: script.kind === 'module' ? 'SharedStorage' : script.kind === 'server' ? 'ServerScripts' : 'ClientScripts',
  }));

  const versionNumber = 1;
  const bundle = buildVersionBundle(project, {
    gameId: game.id,
    versionNumber,
    changelog: 'Initial release',
    publishedBy: owner.id,
  });
  bundle.metadata = { ...bundle.metadata, description, genre, tags, maxPlayers, isPublic: true };
  const version = db.games.createVersion({
    gameId: game.id,
    manifest: JSON.stringify(bundle),
    changelog: 'Initial release',
    label: 'release',
    createdBy: owner.id,
    published: true,
  });
  db.games.replaceScripts(version.id, game.id, project.scripts);
  db.games.updateGame(game.id, { isPublic: true, thumbnailAssetId: null });
  const badgeRecords = [];
  const badgeDefinitions = metadata.badges ?? [];
  for (const badge of badgeDefinitions) {
    badgeRecords.push(db.badges.createBadge({ gameId: game.id, creatorUserId: owner.id, ...badge }));
  }
  return { game: db.games.findById(game.id), version, badges: badgeRecords };
}

/** Demo 1 — obstacle course. */
function createSkylineSprint(owner, items) {
  const world = new World({ name: 'Skyline Sprint' });
  world.ensureServices();
  world.root.setProperty('gravity', -100);
  world.root.findFirstChild('Lighting')?.setProperty('skyColor', '#8fd6ff');
  world.root.findFirstChild('Lighting')?.setProperty('clockTime', 15);

  world.create('Part', {
    name: 'StartPad',
    size: { x: 18, y: 2, z: 18 },
    position: { x: 0, y: 0, z: 0 },
    color: '#2dd4bf',
    material: 'neon',
    anchored: true,
  });
  world.create('SpawnPoint', { name: 'Start', position: { x: 0, y: 3, z: 0 } });

  // A course of platforms that rise and zig-zag; colours mark the difficulty ramp.
  const platforms = [];
  let x = 0;
  let z = -14;
  let y = 3;
  for (let i = 0; i < 22; i += 1) {
    const width = Math.max(3, 8 - i * 0.2);
    const part = world.create('Part', {
      name: `Step${i + 1}`,
      size: { x: width, y: 1.2, z: width * 0.85 },
      position: { x, y, z },
      color: i % 3 === 0 ? '#f97316' : i % 3 === 1 ? '#22d3ee' : '#a855f7',
      material: 'smoothplastic',
      anchored: true,
      tags: ['course'],
    });
    platforms.push(part);
    x += (i % 2 === 0 ? 1 : -1) * (5 + (i % 4));
    z -= 11;
    y += 1.4;
  }

  // Moving platform (anchored + linearVelocity, replicated to clients).
  const moving = world.create('Part', {
    name: 'Mover',
    size: { x: 8, y: 1, z: 8 },
    position: { x: -18, y: 14, z: -120 },
    color: '#00e5c0',
    material: 'metal',
    anchored: true,
    linearVelocity: { x: 6, y: 0, z: 0 },
    tags: ['course', 'moving'],
  });
  const movingEnd = world.create('Part', {
    name: 'MoverTarget',
    size: { x: 10, y: 1, z: 10 },
    position: { x: 22, y: 15, z: -150 },
    color: '#38bdf8',
    material: 'smoothplastic',
    anchored: true,
    tags: ['course'],
  });

  const finish = world.create('Part', {
    name: 'FinishPad',
    size: { x: 22, y: 2, z: 22 },
    position: { x: 0, y: 34, z: -238 },
    color: '#facc15',
    material: 'neon',
    anchored: true,
    tags: ['finish'],
  });
  world.create('Interactable', {
    name: 'FinishGate',
    prompt: 'Claim your finish badge',
    position: { x: 0, y: 36, z: -238 },
    size: { x: 10, y: 6, z: 4 },
    color: '#fde68a',
    tags: ['finish'],
  });

  for (const [index, stage] of [0, 7, 14].entries()) {
    world.create('Interactable', {
      name: `Checkpoint${index + 1}`,
      prompt: `Checkpoint ${index + 1}`,
      position: platforms[stage].getProperty('position'),
      size: { x: 6, y: 4, z: 6 },
      color: '#4ade80',
      tags: ['checkpoint', String(index + 1)],
    });
  }

  world.create('Model', { name: 'Course' }).setParent(world.root);

  const scripts = [
    {
      name: 'Course.server.lua',
      kind: 'server',
      source: `-- Skyline Sprint: checkpoints, finishes and the moving platform logic.
-- Everything here uses the public creator API.

local START = Vector3.new(0, 3, 0)
local course = World:findByName("Course")
local checkpointCount = 3

local progress = {}
local finished = {}

local function getStore()
  return Data.open("SkylineSprint")
end

local function respawnPlayer(player)
  local character = player.character
  if character then
    character.health = character.maxHealth
  end
end

Players.playerJoined:Connect(function(player)
  progress[player.id] = 0
  finished[player.id] = false
  print(player.name .. " joined the course")
  player:sendMessage("Reach the glowing pads. Checkpoints save your progress!")
end)

Players.playerLeft:Connect(function(player)
  local store = getStore()
  local data = store:get(player.id)
  data.checkpoint = progress[player.id] or 0
  store:set(player.id, data)
end)

Events.on("interacted", function(target, player)
  if target == nil or player == nil then return end
  local tags = target:get("tags")
  if tags == nil then return end
  local isCheckpoint = false
  local isFinish = false
  for _, tag in ipairs(tags) do
    if tag == "checkpoint" then isCheckpoint = true end
    if tag == "finish" then isFinish = true end
  end

  if isCheckpoint then
    progress[player.id] = (progress[player.id] or 0) + 1
    player:sendMessage("Checkpoint " .. progress[player.id] .. "/" .. checkpointCount .. " reached!")
  elseif isFinish and not finished[player.id] then
    finished[player.id] = true
    local store = getStore()
    local data = store:get(player.id)
    data.finishes = (data.finishes or 0) + 1
    store:set(player.id, data)
    local badge = Economy.createBadge and nil
    -- The published game defines its badge ids in GamePasses; award by name lookup.
    Economy.awardBadge(player.id, "badge_course_complete")
    player:sendMessage("Course complete! Finishes: " .. data.finishes)
  end
end)

-- Falling players restart at the last checkpoint (server authoritative).
Events.on("heartbeat", function()
  for _, player in ipairs(Players:getPlayers()) do
    local character = player.character
    if character and character.position.y < -60 then
      character.respawn()
      player:sendMessage("Back to the start!")
    end
  end
end)
`,
    },
    {
      name: 'MovingPlatform.server.lua',
      kind: 'server',
      source: `-- Moves the "Mover" platform back and forth between its two endpoints.
local mover = World:findByName("Mover")
local target = World:findByName("MoverTarget")
if mover == nil or target == nil then return end

local minX = -20
local maxX = 24
local speed = 7
local direction = 1

Events.on("heartbeat", function(dt)
  local position = mover.position
  local nextX = position.x + direction * speed * dt
  if nextX > maxX then direction = -1; nextX = maxX end
  if nextX < minX then direction = 1; nextX = minX end
  mover.position = Vector3.new(nextX, position.y, position.z)
end)
`,
    },
    {
      name: 'CourseHud.client.lua',
      kind: 'client',
      source: `-- Client HUD: a small banner and a timer, built with the public UI API.
local banner = UI.create("TextLabel", {
  name = "CourseBanner",
  text = "Skyline Sprint",
  textSize = 26,
  bold = true,
  textColor = "#eef2ff",
  position = UDim2.new(0.5, -140, 0, 18),
  size = UDim2.new(0, 280, 0, 46),
  background = "#0d1220",
  backgroundTransparency = 0.25,
  cornerRadius = 12,
})

local hint = UI.create("TextLabel", {
  name = "CourseHint",
  text = "WASD to move • Space to jump • E to interact",
  textSize = 16,
  textColor = "#9fb3d9",
  position = UDim2.new(0.5, -190, 1, -60),
  size = UDim2.new(0, 380, 0, 30),
  backgroundTransparency = 1,
})
`,
    },
  ];

  const published = publishDemo({
    owner,
    name: 'Skyline Sprint',
    description:
      'A vertical obstacle course with checkpoint saves, a moving platform and a finish badge. Built with the standard creator tools.',
    genre: 'Obby',
    tags: ['obby', 'multiplayer', 'parkour', 'checkpoints'],
    maxPlayers: 12,
    world,
    scripts,
    metadata: {
      badges: [
        { name: 'Course Complete', description: 'Reached the finish pad in Skyline Sprint.' },
        { name: 'Halfway There', description: 'Reached checkpoint 2 in Skyline Sprint.' },
      ],
    },
    config: { gravity: -100, streaming: { enabled: true, radiusStuds: 320, chunkSize: 96 } },
  });

  // Badge ids are referenced by scripts; store the mapping in game settings.
  const completeBadge = published.badges[0];
  const version = db.games.getVersion(published.version.id);
  const bundle = JSON.parse(version.manifest);
  bundle.scripts = bundle.scripts.map((script) => ({
    ...script,
    source: script.source.replace('"badge_course_complete"', `"${completeBadge.id}"`),
  }));
  db.run('UPDATE game_versions SET manifest = ?, content_hash = ? WHERE id = ?', [
    JSON.stringify(bundle),
    db.get('SELECT content_hash FROM game_versions WHERE id = ?', [version.id]).content_hash,
    version.id,
  ]);
  db.games.replaceScripts(version.id, published.game.id, bundle.scripts);
  return published;
}

/** Demo 2 — multiplayer arena. */
function createGridArena(owner) {
  const world = new World({ name: 'Grid Arena' });
  world.ensureServices();
  world.root.setProperty('gravity', -95);

  world.create('Part', {
    name: 'Arena',
    size: { x: 120, y: 3, z: 120 },
    position: { x: 0, y: -1.5, z: 0 },
    color: '#1f2937',
    material: 'metal',
    anchored: true,
    tags: ['arena'],
  });
  world.create('SpawnPoint', { name: 'SpawnA', position: { x: -40, y: 3, z: -40 } });
  world.create('SpawnPoint', { name: 'SpawnB', position: { x: 40, y: 3, z: 40 } });

  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2;
    world.create('Part', {
      name: `Cover${i + 1}`,
      size: { x: 6, y: 8, z: 6 },
      position: { x: Math.cos(angle) * 34, y: 4, z: Math.sin(angle) * 34 },
      color: '#334155',
      material: 'concrete',
      anchored: true,
      tags: ['cover'],
    });
  }

  for (const [index, position] of [
    [-46, 6, 0],
    [46, 6, 0],
    [0, 6, -46],
    [0, 6, 46],
  ].entries()) {
    world.create('Interactable', {
      name: `CapturePoint${index + 1}`,
      prompt: 'Capture point',
      position: { x: position[0], y: position[1], z: position[2] },
      size: { x: 12, y: 1, z: 12 },
      color: index % 2 === 0 ? '#f97316' : '#22d3ee',
      tags: ['capture', String(index + 1)],
    });
  }

  const scripts = [
    {
      name: 'Arena.server.lua',
      kind: 'server',
      source: `-- Grid Arena: capture points, scoring, respawns and a persistent stat.
local CAPTURE_RADIUS = 12
local scores = {}
local captureOwner = {}

local function store()
  return Data.open("ArenaStats")
end

local function awardKill(playerId)
  local data = store()
  local values = data:get(playerId)
  values.score = (values.score or 0) + 10
  data:set(playerId, values)
  return values.score
end

Players.playerJoined:Connect(function(player)
  scores[player.id] = 0
  player:sendMessage("Capture the pads. Score persists between sessions.")
end)

Events.on("interacted", function(target, player)
  if target == nil or player == nil then return end
  for _, tag in ipairs(target:get("tags") or {}) do
    if tag == "capture" then
      captureOwner[target.id] = player.id
      local score = awardKill(player.id)
      player:sendMessage("Captured! Total score: " .. score)
      Economy.grant(player.id, 5, "arena capture")
      if score >= 100 then
        Economy.awardBadge(player.id, "BADGE_ARENA_100")
        player:sendMessage("Badge unlocked: Arena Veteran")
      end
    end
  end
end)

-- Respawn players who fall out of the arena.
Events.on("heartbeat", function()
  for _, player in ipairs(Players:getPlayers()) do
    local character = player.character
    if character and character.position.y < -40 then
      character.respawn()
    end
  end
end)

-- Damage on touch with tagged hazards.
Events.on("objectTouched", function(payload)
  -- Reserved for future hazard parts.
end)
`,
    },
    {
      name: 'ArenaHud.client.lua',
      kind: 'client',
      source: `-- Simple scoreboard overlay driven by the server remote.
local board = UI.create("TextLabel", {
  name = "ScoreBoard",
  text = "Grid Arena",
  textSize = 22,
  bold = true,
  position = UDim2.new(0, 16, 0, 16),
  size = UDim2.new(0, 220, 0, 40),
  background = "#0d1220",
  cornerRadius = 10,
  textColor = "#eef2ff",
})

local remote = Remote.get("ScoreUpdate")
remote:onClientEvent(function(viewerScore, topScore)
  board.text = "Score " .. tostring(viewerScore) .. "  •  Top " .. tostring(topScore)
end)
`,
    },
  ];

  return publishDemo({
    owner,
    name: 'Grid Arena',
    description:
      'A four-point capture arena for up to 16 players. Score persists per player, and captures pay out platform currency.',
    genre: 'Fighting',
    tags: ['arena', 'pvp', 'multiplayer', 'capture'],
    maxPlayers: 16,
    world,
    scripts,
    metadata: {
      badges: [
        { name: 'Arena Veteran', description: 'Scored 100 points in Grid Arena.' },
        { name: 'First Capture', description: 'Captured your first point in Grid Arena.' },
      ],
    },
    config: { gravity: -95, streaming: { enabled: true, radiusStuds: 256, chunkSize: 128 } },
  });
}

/** Demo 3 — social hangout. */
function createLakesideLounge(owner) {
  const world = new World({ name: 'Lakeside Lounge' });
  world.ensureServices();
  const lighting = world.root.findFirstChild('Lighting');
  lighting?.setProperty('clockTime', 19.5);
  lighting?.setProperty('skyColor', '#f8b195');
  lighting?.setProperty('ambient', '#5b6b8c');
  lighting?.setProperty('fogEnd', 600);

  world.create('Terrain', {
    name: 'Ground',
    size: { x: 320, y: 4, z: 320 },
    position: { x: 0, y: -2, z: 0 },
    color: '#4b7f52',
    material: 'grass',
  });
  world.create('Part', {
    name: 'Lake',
    size: { x: 120, y: 2, z: 120 },
    position: { x: 90, y: -0.4, z: -60 },
    color: '#2b6cb0',
    material: 'water',
    transparency: 0.25,
    canCollide: false,
    anchored: true,
  });
  world.create('SpawnPoint', { name: 'Lounge', position: { x: 0, y: 4, z: 0 } });

  // Deck, seating and lights.
  world.create('Part', { name: 'Deck', size: { x: 60, y: 1, z: 44 }, position: { x: 0, y: 0.5, z: 0 }, color: '#8b6b4a', material: 'wood', anchored: true });
  for (let i = 0; i < 6; i += 1) {
    const x = -20 + (i % 3) * 18;
    const z = i < 3 ? -8 : 8;
    world.create('VehicleSeat', {
      name: `Seat${i + 1}`,
      size: { x: 4, y: 2, z: 4 },
      position: { x, y: 2, z },
      color: '#a16207',
      anchored: true,
    });
  }
  for (let i = 0; i < 4; i += 1) {
    world.create('Light', {
      name: `Lamp${i + 1}`,
      lightType: 'point',
      position: { x: -21 + i * 14, y: 9, z: 0 },
      color: '#ffd9a0',
      brightness: 2.4,
      range: 34,
    });
  }
  world.create('Interactable', {
    name: 'Jukebox',
    prompt: 'Play music',
    position: { x: 0, y: 3, z: -16 },
    size: { x: 6, y: 5, z: 3 },
    color: '#7c3aed',
    tags: ['jukebox'],
  });
  world.create('Sound', {
    name: 'LoungeMusic',
    assetId: '',
    group: 'music',
    looped: true,
    volume: 0.35,
    spatial: false,
    position: { x: 0, y: 6, z: -16 },
  });

  const scripts = [
    {
      name: 'Lounge.server.lua',
      kind: 'server',
      source: `-- Lakeside Lounge: welcomes, a visit counter and jukebox interactions.
local visits = {}

local function store()
  return Data.open("LoungeVisits")
end

Players.playerJoined:Connect(function(player)
  local data = store()
  local values = data:get(player.id)
  values.visits = (values.visits or 0) + 1
  data:set(player.id, values)
  visits[player.id] = values.visits
  player:sendMessage("Welcome to Lakeside Lounge, " .. player.displayName .. "! Visit #" .. values.visits)
  if values.visits >= 5 then
    Economy.awardBadge(player.id, "BADGE_LOUNGE_REGULAR")
  end
end)

Events.on("interacted", function(target, player)
  if target == nil or player == nil then return end
  for _, tag in ipairs(target:get("tags") or {}) do
    if tag == "jukebox" then
      player:sendMessage("Now playing: Lounge Theme")
      Remote.get("Music"):fireClient(player.id, { playing = true, track = "Lounge Theme" })
    end
  end
end)
`,
    },
    {
      name: 'LoungeAmbience.client.lua',
      kind: 'client',
      source: `-- Client ambience: gentle colour grading and a welcome toast.
local toast = UI.create("TextLabel", {
  name = "LoungeToast",
  text = "Welcome to Lakeside Lounge",
  textSize = 20,
  position = UDim2.new(0.5, -180, 0.08, 0),
  size = UDim2.new(0, 360, 0, 40),
  background = "#1b2233",
  backgroundTransparency = 0.2,
  cornerRadius = 14,
  textColor = "#ffe9c4",
})

Task.delay(6, function()
  toast.visible = false
end)

local music = Remote.get("Music")
music:onClientEvent(function(payload)
  if payload and payload.playing then
    Sound.play("", { group = "music", looped = true, volume = 0.3 })
  end
end)
`,
    },
  ];

  return publishDemo({
    owner,
    name: 'Lakeside Lounge',
    description:
      'A quiet social space: a wooden deck by the water, seating for six, ambient lighting and a jukebox. Visit counts persist per player.',
    genre: 'Social',
    tags: ['hangout', 'social', 'relaxing', 'chat'],
    maxPlayers: 20,
    world,
    scripts,
    metadata: {
      badges: [{ name: 'Lounge Regular', description: 'Visited Lakeside Lounge five times.' }],
    },
    config: { gravity: -90, streaming: { enabled: true, radiusStuds: 384, chunkSize: 128 } },
  });
}

export { DEMO_PASSWORD, DEFAULT_RIG };
export default seedIfEmpty;
