/**
 * RealmServer — a Kinetiq game server instance.
 *
 * A realm hosts exactly one published game version:
 *   - loads the version bundle into a World
 *   - runs the game's server scripts in a sandboxed Lua VM
 *   - simulates physics/characters at a fixed tick rate (authoritative)
 *   - replicates state to clients at a snapshot rate, with interest management
 *   - validates every inbound frame, rate-limits clients, and never trusts client state
 *
 * Persistent data, currency, badges and moderation actions are delegated to injected platform
 * services so the realm process never touches credentials or the database directly.
 */
import { World, deserializeWorld, Character, Vector3, PROJECT_FORMAT, insertScriptsIntoWorld } from '@kinetiq/engine';
import { ScriptHost } from '@kinetiq/scripting';
import {
  ClientMessage,
  ServerMessage,
  PROTOCOL_VERSION,
  PROTOCOL_LIMITS,
  validateFrame,
  encodeSnapshot,
  sanitiseRemoteArgs,
  BandwidthMeter,
  ConnectionLimiter,
  sanitiseChatText,
  visibleWithin,
} from '@kinetiq/networking';
import { createLogger, ENGINE_LIMITS, nowSeconds, ids } from '@kinetiq/shared';

const SNAPSHOT_RATE = 20;
const TICK_RATE = ENGINE_LIMITS.realmTickRateHz;

export class RealmServer {
  constructor({
    id = ids.realm(),
    gameId,
    gameName = 'Game',
    versionId = null,
    versionNumber = 1,
    bundle,
    services = {},
    region = 'local',
    maxPlayers = 12,
    privateServerId = null,
    joinCode = null,
    idleShutdownSeconds = 300,
    mode = 'live',
    logger = null,
  }) {
    this.id = id;
    this.gameId = gameId;
    this.gameName = gameName;
    this.versionId = versionId;
    this.versionNumber = versionNumber;
    this.bundle = bundle;
    this.services = services;
    this.region = region;
    this.maxPlayers = Math.max(1, Math.min(ENGINE_LIMITS.maxPlayers ?? 200, Number(maxPlayers) || 12));
    this.privateServerId = privateServerId;
    this.joinCode = joinCode;
    // 'live' for public matchmade realms, 'playtest' for an editor preview of an unpublished draft.
    this.mode = mode;
    this.idleShutdownSeconds = idleShutdownSeconds;
    this.log = logger ?? createLogger(`realm:${id.slice(-6)}`);

    this.world = null;
    this.scriptHost = null;
    this.players = new Map();
    this.status = 'starting';
    this.createdAt = Date.now();
    this.startedAt = null;
    this.tickIndex = 0;
    this.lastSnapshotAt = 0;
    this.lastEmptyAt = Date.now();
    this.interval = null;
    this.bandwidth = new BandwidthMeter();
    this.limiter = new ConnectionLimiter();
    this.chatFilter = services.chatFilter ?? defaultChatFilter;
    this.remotes = new Map();
    this.playerDataCache = new Map();
    this.clientScripts = [];
    this.metrics = { ticks: 0, snapshots: 0, joins: 0, leaves: 0, errors: 0, bytesOut: 0, bytesIn: 0 };
    this.lastObjectState = new Map();
  }

  /** Loads the world and starts the simulation loop. */
  async start() {
    if (!this.bundle || this.bundle.format !== PROJECT_FORMAT) {
      this.status = 'failed';
      throw new Error('A realm requires a valid published version bundle');
    }
    this.world = deserializeWorld(this.bundle.world);
    // Releases ship without script instances; the realm recreates them so in-world scripts exist
    // for game logic, UI roots and DataStore-style services.
    insertScriptsIntoWorld(this.world, this.bundle.scripts ?? []);
    this.world.physics.gravity = this.bundle.config?.gravity ?? -90;
    // Instances whose transforms are replicated when they change.
    this.replicableInstances = this.world
      .findByClass('Part')
      .concat(this.world.findByClass('Mesh'), this.world.findByClass('VehicleSeat'), this.world.findByClass('Interactable'));
    this.ensureGameplayDefaults();
    this.scriptHost = new ScriptHost({
      mode: 'server',
      world: this.world,
      name: `realm:${this.id.slice(-6)}`,
      context: this.buildScriptContext(),
    });
    await this.scriptHost.start();
    // Only server scripts and shared modules execute inside the realm. Client scripts are shipped
    // to players (welcome frame + script updates) and run in their own sandbox on the client.
    const allScripts = this.bundle.scripts ?? [];
    this.clientScripts = allScripts
      .filter((script) => script.kind === 'client' && !script.disabled)
      .map((script) => ({ id: script.id ?? script.name, name: script.name, source: script.source }));
    await this.scriptHost.loadAll(
      allScripts
        .filter((script) => script.kind !== 'client')
        .map((script) => ({
          id: script.id ?? script.name,
          name: script.name,
          source: script.source,
          kind: script.kind === 'module' ? 'module' : 'server',
          disabled: Boolean(script.disabled),
        })),
    );
    this.status = 'running';
    this.startedAt = Date.now();
    this.world.events.fire('serverStarted', { realmId: this.id, gameId: this.gameId });
    this.#startLoop();
    this.log.info(`realm ready (${this.bundle.metadata?.name ?? this.gameName} v${this.versionNumber})`);
    this.services.onRealmEvent?.({ type: 'started', realmId: this.id });
    return this;
  }

  /** Games always get a floor, a spawn and services, even if the creator forgot. */
  ensureGameplayDefaults() {
    this.world.ensureServices();
    const hasFloor = this.world
      .findByClass('Part')
      .some((part) => part.getProperty('size')?.y && part.getProperty('size').x >= 20 && part.getProperty('anchored'));
    if (!hasFloor && !this.world.findByClass('Terrain').length) {
      this.world.create('Part', {
        name: 'Baseplate',
        size: { x: 256, y: 4, z: 256 },
        position: { x: 0, y: -2, z: 0 },
        color: '#31405c',
        material: 'concrete',
        anchored: true,
      });
    }
    if (!this.world.findByClass('SpawnPoint').length) {
      this.world.create('SpawnPoint', { name: 'Spawn', position: { x: 0, y: 6, z: 0 } });
    }
    // Every game gets a default chat remote available to scripts.
    this.remotes.set('Chat', null);
  }

  #startLoop() {
    const dt = 1 / TICK_RATE;
    let last = process.hrtime.bigint();
    this.accumulator = 0;
    this.interval = setInterval(() => {
      const now = process.hrtime.bigint();
      const elapsed = Number(now - last) / 1e9;
      last = now;
      this.accumulator += Math.min(elapsed, 0.25);
      let steps = 0;
      while (this.accumulator >= dt && steps < 6) {
        this.step(dt);
        this.accumulator -= dt;
        steps += 1;
      }
      if (!Number.isFinite(elapsed) || elapsed > 5) this.accumulator = 0;
      this.maybeCheckIdle();
    }, Math.round(1000 / TICK_RATE));
    this.interval.unref?.();
  }

  /** One authoritative simulation step. */
  step(dt) {
    try {
      for (const player of this.players.values()) {
        this.#applyInput(player, dt);
      }
      this.world.tick(dt);
      for (const player of this.players.values()) {
        player.character?.update(dt);
      }
      this.scriptHost?.tick(dt);
      this.tickIndex += 1;
      this.metrics.ticks += 1;
      const now = Date.now();
      if (now - this.lastSnapshotAt >= 1000 / SNAPSHOT_RATE) {
        this.lastSnapshotAt = now;
        this.broadcastSnapshot();
      }
    } catch (error) {
      this.metrics.errors += 1;
      this.log.error('tick failed', { error: error.message });
      this.scriptHost?.pushError('realm:tick', error.message);
    }
  }

  #applyInput(player, dt) {
    const character = player.character;
    if (!character || !player.input) return;
    const { moveX, moveZ, run, jump, yaw } = player.input;
    character.move({ x: moveX, y: 0, z: moveZ }, { run, deltaSeconds: dt, facing: yaw });
    if (jump) character.jump();
    player.input.jump = false; // jump is edge-triggered
  }

  /** ------------------------------------------------------------- players */
  async addPlayer({ userId, username, displayName, avatar = {}, appearance = {}, data = {}, socket = null, isBot = false }) {
    if (this.players.size >= this.maxPlayers) return { ok: false, reason: 'server_full' };
    if (this.status !== 'running') return { ok: false, reason: 'server_not_ready' };
    const existing = this.players.get(userId);
    if (existing?.socket && !isBot) {
      // A reconnect replaces the previous connection (they get a grace period on a dropped socket).
      existing.socket.close?.(4001, 'replaced');
    }
    const spawn = this.world.pickSpawn({
      occupiedPositions: [...this.players.values()].filter((p) => p.character).map((p) => p.character.position),
    });
    const character = new Character(this.world, {
      playerId: userId,
      displayName: displayName || username,
      spawn,
      avatar,
      appearance,
    });
    const player = {
      id: userId,
      username,
      displayName: displayName || username,
      character,
      socket,
      joinedAt: Date.now(),
      input: { moveX: 0, moveZ: 0, run: false, jump: false, yaw: 0 },
      ping: 0,
      lastPingAt: 0,
      ready: false,
      isBot,
      dataLoaded: false,
      chatCount: 0,
      chatResetAt: Date.now() + 1000,
    };
    this.players.set(userId, player);
    this.metrics.joins += 1;
    this.lastEmptyAt = null;

    await this.loadPlayerData(player, data);

    if (socket) {
      this.send(socket, {
        t: ServerMessage.SPAWN,
        player: this.publicPlayer(player),
        spawn: {
          position: character.position,
          rotation: { x: 0, y: (character.facing * 180) / Math.PI, z: 0 },
        },
      });
    }
    this.world.events.fire('playerJoined', this.publicPlayer(player));
    // Scripts receive a wrapped player handle so `player.name`, `.character`, `:sendMessage()` work.
    this.scriptHost?.fireEvent('playerJoined', this.scriptHost.wrapPlayer(this.publicPlayer(player)));
    this.broadcast(
      {
        t: ServerMessage.SPAWN,
        player: this.publicPlayer(player),
        spawn: { position: character.position, rotation: { x: 0, y: 0, z: 0 } },
      },
      { except: userId },
    );
    this.services.onPlayerJoin?.({ realmId: this.id, gameId: this.gameId, userId, username });
    return { ok: true, player, character };
  }

  async loadPlayerData(player, seed = {}) {
    if (!this.services.playerData || player.isBot) {
      player.savedData = seed.values ?? {};
      player.dataLoaded = true;
      return;
    }
    try {
      const result = await this.services.playerData.load({
        gameId: this.gameId,
        userId: player.id,
        realmId: this.id,
      });
      player.savedData = result?.values ?? {};
      player.dataVersion = result?.version ?? 0;
      player.dataLoaded = true;
    } catch (error) {
      this.log.error('failed to load player data', { error: error.message, userId: player.id });
      player.savedData = {};
      player.dataLoaded = true;
    }
  }

  async removePlayer(userId, { reason = 'left', persist = true } = {}) {
    const player = this.players.get(userId);
    if (!player) return false;
    this.players.delete(userId);
    this.metrics.leaves += 1;
    const playtime = Math.round((Date.now() - player.joinedAt) / 1000);
    // Keep the last known store values for a short while: `playerLeft` handlers routinely read a
    // player's data, and scripts should not have to care about ordering.
    if (player.stores) this.playerDataCache.set(userId, Object.fromEntries(player.stores));
    for (const store of player.stores?.values?.() ?? []) void store;
    this.world.events.fire('playerLeft', this.publicPlayer(player));
    this.scriptHost?.fireEvent('playerLeft', this.scriptHost.wrapPlayer(this.publicPlayer(player)));
    player.character?.destroy();
    this.broadcast({ t: ServerMessage.DESPAWN, id: userId });
    if (persist && this.services.playerData && player.dataLoaded && !player.isBot) {
      try {
        await this.services.playerData.save({
          gameId: this.gameId,
          userId: player.id,
          realmId: this.id,
          values: player.savedData ?? {},
        });
      } catch (error) {
        this.log.error('failed to save player data', { error: error.message, userId: player.id });
      }
    }
    this.services.onPlayerLeave?.({
      realmId: this.id,
      gameId: this.gameId,
      userId,
      username: player.username,
      playtimeSeconds: playtime,
      reason,
    });
    if (this.players.size === 0) this.lastEmptyAt = Date.now();
    return true;
  }

  publicPlayer(player) {
    return {
      id: player.id,
      username: player.username,
      displayName: player.displayName,
      characterId: player.character?.id ?? null,
    };
  }

  /** ------------------------------------------------------------- networking */
  send(socket, message) {
    if (!socket || socket.readyState !== 1) return false;
    try {
      const text = JSON.stringify(message);
      socket.send(text);
      this.bandwidth.recordOut(text.length);
      this.metrics.bytesOut += text.length;
      return true;
    } catch (error) {
      this.log.warn('send failed', { error: error.message });
      return false;
    }
  }

  broadcast(message, { except = null, filter = null } = {}) {
    for (const player of this.players.values()) {
      if (except && player.id === except) continue;
      if (!player.socket) continue;
      if (filter && !filter(player)) continue;
      this.send(player.socket, message);
    }
  }

  broadcastSnapshot() {
    this.metrics.snapshots += 1;
    for (const player of this.players.values()) {
      if (!player.socket) continue;
      const observer = player.character?.position ?? new Vector3(0, 0, 0);
      const radius = this.bundle.config?.streaming?.radiusStuds ?? ENGINE_LIMITS.defaultStreamingRadius ?? 512;
      const characters = [];
      for (const other of this.players.values()) {
        if (!other.character) continue;
        if (other.id === player.id) {
          characters.push(other.character.snapshot());
          continue;
        }
        characters.push(other.character.snapshot());
        void radius;
      }
      const dynamicObjects = this.#dynamicObjectUpdates(observer);
      this.send(
        player.socket,
        encodeSnapshot({
          tick: this.tickIndex,
          time: this.world.time,
          characters,
          objects: dynamicObjects,
        }),
      );
    }
  }

  /** Replicates creator-made moving parts (platforms, doors, physics props) that changed. */
  #dynamicObjectUpdates(observer) {
    const updates = [];
    const radius = this.bundle.config?.streaming?.radiusStuds ?? 512;
    try {
    // Anything with a transform can move: physics bodies *and* anchored parts driven by scripts
    // (moving platforms, doors, animated props). Character parts are excluded — characters have
    // their own replicated slot in every snapshot.
    const candidates = [];
    for (const instance of this.replicableInstances) {
      if (!instance.parent || !instance.world) continue;
      candidates.push(instance);
    }
    for (const instance of visibleWithin(observer, radius, candidates, (item) => item.getPosition())) {
      const changed = this.lastObjectState.get(instance.id);
      const position = instance.getProperty('position');
      // Not every class has a rotation property (Interactable, SpawnPoint, …).
      const rotation = instance.hasProperty('rotation') ? instance.getProperty('rotation') : null;
      const serialized = `${Math.round(position.x * 100) / 100}|${Math.round(position.y * 100) / 100}|${Math.round(position.z * 100) / 100}|${Math.round((rotation?.y ?? 0) * 10) / 10}`;
      if (changed === serialized) continue;
      this.lastObjectState.set(instance.id, serialized);
      updates.push([instance.id, [position.x, position.y, position.z], [rotation?.x ?? 0, rotation?.y ?? 0, rotation?.z ?? 0]]);
    }
    } catch (error) {
      // A single malformed instance must never stop replication for everyone else.
      this.log.warn('object replication failed', { error: error.message });
    }
    return updates.slice(0, 120);
  }

  /** Handles a raw frame from a connected client. */
  async handleMessage(player, raw) {
    const validation = validateFrame(raw);
    if (!validation.ok) {
      this.send(player.socket, { t: ServerMessage.ERROR, code: validation.error });
      return;
    }
    const { message, type } = validation;
    this.bandwidth.recordIn(typeof raw === 'string' ? raw.length : raw.length ?? 0);
    this.metrics.bytesIn += typeof raw === 'string' ? raw.length : 0;
    if (type === ClientMessage.PING) {
      this.send(player.socket, { t: ServerMessage.PONG, c: message.c ?? 0, s: nowSeconds() });
      return;
    }
    if (!this.limiter.allow(`${player.id}:all`, PROTOCOL_LIMITS.maxInputPerSecond)) {
      this.send(player.socket, { t: ServerMessage.ERROR, code: 'rate_limited' });
      return;
    }
    switch (type) {
      case ClientMessage.INPUT:
        this.#handleInput(player, message);
        break;
      case ClientMessage.CHAT:
        this.#handleChat(player, message);
        break;
      case ClientMessage.REMOTE:
        this.#handleRemote(player, message);
        break;
      case ClientMessage.RESPAWN:
        this.#handleRespawn(player);
        break;
      case ClientMessage.INTERACT:
        this.#handleInteract(player);
        break;
      case ClientMessage.READY:
        player.ready = true;
        this.send(player.socket, { t: ServerMessage.LOG, level: 'info', message: 'joined' });
        break;
      case ClientMessage.SET_UI_STATE:
        this.scriptHost?.fireEvent('uiStateChanged', player.id, message.d ?? {});
        break;
      default:
        this.send(player.socket, { t: ServerMessage.ERROR, code: 'unknown_message' });
    }
  }

  #handleInput(player, message) {
    const payload = message.i ?? message.data;
    if (!Array.isArray(payload) || payload.length < 5) return;
    player.input = {
      moveX: clamp(payload[0], -1, 1),
      moveZ: clamp(payload[1], -1, 1),
      run: Boolean(payload[2]),
      jump: Boolean(payload[3]),
      yaw: clamp(payload[4], -Math.PI * 4, Math.PI * 4),
    };
  }

  #handleChat(player, message) {
    const now = Date.now();
    if (now > player.chatResetAt) {
      player.chatCount = 0;
      player.chatResetAt = now + 1000;
    }
    player.chatCount += 1;
    if (player.chatCount > PROTOCOL_LIMITS.maxChatPerSecond) return;
    const text = sanitiseChatText(message.m ?? message.text ?? '');
    if (!text) return;
    const filtered = this.chatFilter(text);
    const entry = {
      t: ServerMessage.CHAT,
      from: player.id,
      username: player.displayName,
      text: filtered.clean,
      at: now,
    };
    this.broadcast(entry);
    this.world.events.fire('playerChatted', { playerId: player.id, text: filtered.clean, original: text, blocked: filtered.blocked });
    this.scriptHost?.fireEvent('playerChatted', player.id, filtered.clean);
    this.services.onChat?.({
      realmId: this.id,
      gameId: this.gameId,
      userId: player.id,
      username: player.username,
      text: filtered.clean,
      original: text,
      blocked: filtered.blocked,
    });
    if (filtered.blocked) {
      this.send(player.socket, { t: ServerMessage.LOG, level: 'warn', message: 'That message was filtered.' });
    }
  }

  #handleRemote(player, message) {
    if (!this.limiter.allow(`${player.id}:remote`, PROTOCOL_LIMITS.maxRemotePerSecond)) return;
    const name = String(message.n ?? message.name ?? '');
    if (!name || name.length > 64) return;
    const args = sanitiseRemoteArgs(message.a ?? message.args ?? []);
    this.scriptHost?.emitServerRemote(name, player.id, args);
    this.world.events.fire('remoteEvent', { name, playerId: player.id, args });
  }

  #handleRespawn(player) {
    if (!player.character) return;
    if (player.character.state !== 'dead' && player.character.health > 0) return;
    const spawn = this.world.pickSpawn();
    player.character.respawn(spawn);
    this.send(player.socket, {
      t: ServerMessage.SPAWN,
      player: this.publicPlayer(player),
      spawn: { position: player.character.position, rotation: { x: 0, y: (player.character.facing * 180) / Math.PI, z: 0 } },
    });
  }

  #handleInteract(player) {
    const character = player.character;
    if (!character) return;
    const near = this.world.physics.nearestWithin(
      character.position,
      14,
      (instance) => instance.className === 'Interactable' && instance.getProperty('enabled') !== false,
    );
    if (!near) return;
    const interactable = near.instance;
    this.world.events.fire('interacted', { instance: interactable, playerId: player.id, character });
    this.scriptHost?.fireEvent('interacted', this.scriptHost.wrap(interactable), this.scriptHost.wrapPlayer({
      id: player.id,
      username: player.username,
      displayName: player.displayName,
    }));
  }

  /** ------------------------------------------------------------- script context */
  buildScriptContext() {
    const realm = this;
    return {
      gameId: this.gameId,
      logger: this.log,
      onLog: (entry) => realm.broadcast({ t: ServerMessage.LOG, level: entry.level, message: entry.message }),
      onError: (entry) =>
        realm.broadcast({ t: ServerMessage.LOG, level: 'error', message: `${entry.where}: ${entry.message}` }),
      getPlayers: () =>
        [...realm.players.values()].map((player) => ({
          id: player.id,
          username: player.username,
          displayName: player.displayName,
        })),
      characterFor: (playerId) => realm.players.get(playerId)?.character ?? null,
      areFriends: (a, b) => Boolean(realm.services.areFriends?.(a, b)),
      sendGameMessage: (playerId, text) => {
        const target = realm.players.get(playerId);
        if (target?.socket) realm.send(target.socket, { t: ServerMessage.NOTIFY, message: String(text).slice(0, 500) });
      },
      kickPlayer: (playerId, reason) => realm.kickPlayer(playerId, reason),
      sendToClient: (playerId, name, args) => {
        const target = realm.players.get(playerId);
        if (target?.socket) realm.send(target.socket, { t: ServerMessage.REMOTE, n: name, a: args });
      },
      sendToAllClients: (name, args) => realm.broadcast({ t: ServerMessage.REMOTE, n: name, a: args }),
      sendToServer: (name, args) => realm.scriptHost?.emitServerRemote(name, 'client', args),
      openDataStore: (storeName) => realm.openDataStore(storeName),
      leaderboard: (storeName, field, limit) =>
        realm.services.playerData?.leaderboard?.({ gameId: realm.gameId, storeName, field, limit }) ?? [],
      economy: {
        getBalance: (playerId) => realm.services.economy?.getBalance?.(playerId) ?? 0,
        grant: (playerId, amount, reason) => realm.services.economy?.grant?.({ playerId, amount, reason, gameId: realm.gameId }) ?? 0,
        take: (playerId, amount, reason) => realm.services.economy?.take?.({ playerId, amount, reason, gameId: realm.gameId }) ?? 0,
        ownsProduct: (playerId, productId) => Boolean(realm.services.economy?.ownsProduct?.({ playerId, productId })),
        listProducts: (gameId, kind) => realm.services.economy?.listProducts?.({ gameId: gameId ?? realm.gameId, kind }) ?? [],
      },
      badges: {
        award: (playerId, badgeId) => realm.services.badges?.award?.({ playerId, badgeId, gameId: realm.gameId }) ?? { awarded: false },
        has: (playerId, badgeId) => Boolean(realm.services.badges?.has?.({ playerId, badgeId })),
        create: (name, description, iconAssetId) =>
          realm.services.badges?.create?.({ gameId: realm.gameId, name, description, iconAssetId }),
      },
    };
  }

  /**
   * Data stores handed to scripts. All access is scoped to this realm's game id and goes through
   * the platform service (quotas, size limits, isolation). Values are cached per player for the
   * duration of the session and flushed on leave/autosave.
   */
  openDataStore(storeName = 'default') {
    const realm = this;
    return {
      get(playerId) {
        const player = realm.players.get(String(playerId));
        // Reading a store for a player who just left (e.g. from a playerLeft handler) yields the
        // last known values rather than throwing.
        if (!player) return { ...(realm.playerDataCache.get(String(playerId))?.[storeName] ?? {}) };
        player.stores = player.stores ?? new Map();
        if (!player.stores.has(storeName)) {
          const existing = player.savedData?.[storeName];
          player.stores.set(storeName, existing && typeof existing === 'object' ? { ...existing } : {});
        }
        return { ...player.stores.get(storeName) };
      },
      set(playerId, values) {
        const player = realm.players.get(String(playerId));
        if (!player) {
          // Persisting for a departed player is a no-op rather than a script error.
          realm.log.warn('data store write for departed player', { playerId: String(playerId) });
          return false;
        }
        const payload = values && typeof values === 'object' ? values : {};
        const serialized = JSON.stringify(payload);
        if (serialized.length > ENGINE_LIMITS.maxDataStoreValueBytes) {
          throw new Error(`Saved data exceeds the ${ENGINE_LIMITS.maxDataStoreValueBytes / 1024}KB limit`);
        }
        player.stores = player.stores ?? new Map();
        player.stores.set(storeName, JSON.parse(serialized));
        player.savedData = player.savedData ?? {};
        player.savedData[storeName] = JSON.parse(serialized);
        player.dataDirty = true;
        realm.services.playerData?.markDirty?.({ gameId: realm.gameId, userId: player.id, storeName });
        return { ...player.stores.get(storeName) };
      },
      increment(playerId, key, amount = 1) {
        const values = this.get(playerId);
        values[String(key)] = (Number(values[String(key)]) || 0) + Number(amount);
        this.set(playerId, values);
        return values[String(key)];
      },
    };
  }

  /** Persists dirty player data (called on a timer and on leave). */
  async flushPlayerData() {
    if (!this.services.playerData) return 0;
    let saved = 0;
    for (const player of this.players.values()) {
      if (!player.dataDirty || player.isBot) continue;
      try {
        await this.services.playerData.save({
          gameId: this.gameId,
          userId: player.id,
          realmId: this.id,
          values: player.savedData ?? {},
        });
        player.dataDirty = false;
        saved += 1;
      } catch (error) {
        this.log.error('data flush failed', { error: error.message, userId: player.id });
      }
    }
    return saved;
  }

  /** Broadcasts a creator-defined UI update to clients (client scripts also run locally). */
  pushUI(playerId, tree) {
    const target = playerId ? this.players.get(playerId) : null;
    if (target?.socket) this.send(target.socket, { t: ServerMessage.UI, tree });
    else this.broadcast({ t: ServerMessage.UI, tree });
  }

  kickPlayer(userId, reason = 'Kicked by game logic') {
    const player = this.players.get(userId);
    if (!player) return false;
    this.send(player.socket, { t: ServerMessage.ERROR, code: 'kicked', message: reason });
    player.socket?.close?.(4003, 'kicked');
    this.removePlayer(userId, { reason: 'kicked' });
    return true;
  }

  /** ------------------------------------------------------------- lifecycle */
  get playerCount() {
    return this.players.size;
  }

  get isFull() {
    return this.players.size >= this.maxPlayers;
  }

  get snapshot() {
    return {
      id: this.id,
      gameId: this.gameId,
      gameName: this.gameName,
      versionId: this.versionId,
      versionNumber: this.versionNumber,
      mode: this.mode,
      region: this.region,
      status: this.status,
      playerCount: this.playerCount,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
      privateServerId: this.privateServerId,
      private: Boolean(this.privateServerId),
      joinCode: this.joinCode,
      startedAt: this.startedAt,
      uptimeSeconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      tickRate: TICK_RATE,
      metrics: { ...this.metrics, bandwidth: this.bandwidth.stats, worldStats: this.world?.stats ?? null },
    };
  }

  /** Heartbeat to the platform: registry row, active player counts, idle shutdown. */
  heartbeat() {
    this.services.onHeartbeat?.(this.snapshot);
    return this.snapshot;
  }

  maybeCheckIdle() {
    if (this.players.size > 0 || !this.lastEmptyAt) return;
    if (Date.now() - this.lastEmptyAt < this.idleShutdownSeconds * 1000) return;
    this.shutdown({ reason: 'idle' });
  }

  async shutdown({ reason = 'requested' } = {}) {
    if (this.status === 'stopped') return;
    this.status = 'draining';
    this.log.info(`realm shutting down (${reason})`);
    this.broadcast({ t: ServerMessage.STOP, reason });
    await this.flushPlayerData().catch(() => {});
    for (const userId of [...this.players.keys()]) {
      await this.removePlayer(userId, { reason: 'server_shutdown', persist: false }).catch(() => {});
    }
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.scriptHost?.dispose();
    this.world?.destroy();
    this.status = 'stopped';
    this.services.onRealmEvent?.({ type: 'stopped', realmId: this.id, reason });
    this.services.onHeartbeat?.(this.snapshot);
    return this.snapshot;
  }
}

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(max, Math.max(min, num));
}

/**
 * Default chat filter. Deliberately conservative and dictionary-based; deployments can inject a
 * stronger filter through `services.chatFilter`.
 */
const BLOCKED_PATTERNS = [
  /\b(free\s+(robux|credits|ktc))\b/i,
  /\b(password|passwd|login\s+details)\b/i,
  /\b(discord\.gg|t\.me|bit\.ly|tinyurl)\b/i,
  /\b\d{3}[-\s]?\d{3}[-\s]?\d{4}\b/,
  /[<>]{2,}/,
];

export function defaultChatFilter(text) {
  const clean = sanitiseChatText(text);
  let blocked = false;
  let output = clean;
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(output)) {
      blocked = true;
      output = output.replace(pattern, '####');
    }
  }
  // Collapse character spam ("heeeeeeyyyyy" -> "heeey").
  output = output.replace(/(.)\1{4,}/g, '$1$1$1');
  return { clean: output, blocked };
}

export default RealmServer;
