/**
 * RealmManager — matchmaking, realm lifecycle and the platform-side services a realm needs.
 *
 * Matchmaking algorithm (`findOrCreate`):
 *   1. reuse a running realm for the same game+version that has capacity (fullest first, which
 *      keeps players together and lets empty servers idle out)
 *   2. otherwise start a new realm, wait until it reports ready, then admit the player
 *   3. issue a short-lived, signed join token bound to (user, game, realm)
 *
 * Realms run in-process by default (one command to start the platform). `REALM_REMOTE` mode can
 * point the platform at standalone realm hosts; the interface is identical.
 */
import { WebSocketServer } from 'ws';
import { RealmServer } from '@kinetiq/server';
import * as db from '@kinetiq/db';
import { validateFrame, PROTOCOL_LIMITS } from '@kinetiq/networking';
import {
  ids,
  token,
  signJoinToken,
  verifyJoinToken,
  platformConfig,
  createLogger,
  ENGINE_LIMITS,
  nowSeconds,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  RateLimitError,
} from '@kinetiq/shared';

const log = createLogger('realm-manager');

export class RealmManager {
  constructor({ notify = null, chatFilter = null } = {}) {
    /** @type {Map<string, RealmServer>} */
    this.realms = new Map();
    /** @type {Map<string, {token: string, expiresAt: number}>} */
    this.joinTokens = new Map();
    this.notify = notify;
    this.chatFilter = chatFilter;
    this.starting = new Map();
    this.lastReconcile = 0;
    this.stats = { realmsStarted: 0, realmsStopped: 0, joins: 0, players: 0 };
  }

  /** Platform services injected into every realm (data, economy, badges, moderation). */
  buildServices(realmInfo) {
    return {
      chatFilter: this.chatFilter ?? undefined,
      playerData: {
        load: async ({ gameId, userId }) => db.data.readStore(gameId, userId, 'default'),
        save: async ({ gameId, userId, values }) => db.data.writeStore(gameId, userId, 'default', values ?? {}),
        leaderboard: ({ gameId, storeName, field, limit }) =>
          db.data.leaderboard(gameId, { storeName, field, limit }).map((row) => ({ ...row, userId: row.userId })),
        markDirty: () => {},
      },
      economy: {
        getBalance: (playerId) => db.economy.balanceOf(playerId),
        grant: ({ playerId, amount, reason, gameId }) => {
          // Server-authoritative: only the realm's own game can be the source of a grant.
          db.economy.grantCredits(playerId, Math.max(0, Math.trunc(amount)), 'adjustment', {
            description: String(reason || 'Game reward').slice(0, 120),
            gameId,
          });
          return db.economy.balanceOf(playerId);
        },
        take: ({ playerId, amount, reason, gameId }) => {
          db.economy.spendCredits(playerId, Math.max(0, Math.trunc(amount)), 'purchase', {
            description: String(reason || 'Game charge').slice(0, 120),
            gameId,
          });
          return db.economy.balanceOf(playerId);
        },
        ownsProduct: ({ playerId, productId }) => db.economy.ownsProduct(String(productId), playerId),
        listProducts: ({ gameId, kind }) =>
          db.economy.listProducts(gameId, { kind }).map((product) => ({
            id: product.id,
            name: product.name,
            price: product.price,
            kind: product.kind,
            description: product.description,
          })),
      },
      badges: {
        award: ({ playerId, badgeId, gameId }) => {
          const result = db.badges.awardBadge(String(badgeId), playerId, { gameId });
          if (result.awarded) {
            this.notify?.({
              userId: playerId,
              kind: 'badge_earned',
              title: `Badge earned: ${result.badge.name}`,
              body: result.badge.description ?? '',
              link: `/badges/${badgeId}`,
              data: { badgeId },
            });
          }
          return result;
        },
        has: ({ playerId, badgeId }) => db.badges.hasBadge(playerId, String(badgeId)),
        create: ({ gameId, name, description, iconAssetId }) => {
          const badge = db.badges.createBadge({
            gameId,
            creatorUserId: realmInfo.ownerUserId,
            name,
            description,
            iconAssetId,
          });
          return { id: badge.id, name: badge.name };
        },
      },
      areFriends: (a, b) => db.social.areFriends(a, b),
      onPlayerJoin: ({ gameId, userId, realmId }) => {
        this.stats.joins += 1;
        db.users.setPresence(userId, 'playing', { gameId, realmId });
        db.users.touchActivity(userId);
      },
      onPlayerLeave: ({ gameId, userId, realmId, playtimeSeconds }) => {
        db.users.setPresence(userId, 'online');
        if (playtimeSeconds) db.users.addPlaytime(userId, playtimeSeconds);
        void gameId;
        void realmId;
      },
      onChat: ({ gameId, userId, username, text, blocked }) => {
        try {
          db.social.recordGameChat({
            gameId,
            serverId: realmInfo.id,
            userId,
            username,
            body: text,
            filteredBody: blocked ? text : null,
          });
        } catch (error) {
          log.warn('failed to record chat', { error: error.message });
        }
      },
      onHeartbeat: (snapshot) => this.handleHeartbeat(snapshot),
      onRealmEvent: (event) => {
        if (event.type === 'started') this.stats.realmsStarted += 1;
        if (event.type === 'stopped') {
          this.stats.realmsStopped += 1;
          this.realms.delete(event.realmId);
        }
      },
    };
  }

  /** Persists realm status into the database and updates the game's public player count. */
  handleHeartbeat(snapshot) {
    try {
      const existing = db.servers.getServer(snapshot.id);
      if (!existing) return;
      db.servers.heartbeat(snapshot.id, {
        currentPlayers: snapshot.playerCount,
        status: snapshot.status === 'running' ? 'running' : snapshot.status === 'draining' ? 'draining' : 'stopped',
      });
      const stats = db.servers.serverCounts();
      const gamePlayers = db
        .all(
          `SELECT COALESCE(SUM(current_players), 0) AS n FROM game_servers WHERE game_id = ? AND status = 'running'`,
          [snapshot.gameId],
        )[0]?.n;
      if (gamePlayers !== undefined) db.games.setActivePlayers(snapshot.gameId, gamePlayers);
      this.stats.players = stats.players;
    } catch (error) {
      log.warn('heartbeat handling failed', { error: error.message });
    }
  }

  /** ------------------------------------------------------------- matchmaking */
  async findOrCreate({ gameId, userId, versionId = null, privateServerId = null, joinCode = null, maxPlayers = null }) {
    const game = db.games.findById(gameId);
    if (!game) throw new NotFoundError('Game not found.');
    if (!game.is_published || game.moderation_status === 'removed') {
      throw new ForbiddenError('That game is not currently playable.');
    }
    const version = versionId
      ? db.games.getVersion(versionId)
      : db.games.currentVersion(gameId);
    if (!version) throw new NotFoundError('No published version for this game.');

    // 1. Reuse an existing realm with capacity.
    const candidates = [...this.realms.values()].filter(
      (realm) =>
        realm.gameId === gameId &&
        realm.status === 'running' &&
        realm.versionId === version.id &&
        realm.players.size < realm.maxPlayers &&
        (privateServerId ? realm.privateServerId === privateServerId : !realm.privateServerId),
    );
    if (candidates.length) {
      candidates.sort((a, b) => b.players.size - a.players.size);
      return { realm: candidates[0], reused: true, version };
    }

    // 2. Start a new realm (dedupe concurrent requests for the same game).
    const startKey = `${gameId}:${version.id}:${privateServerId ?? 'public'}`;
    if (this.starting.has(startKey)) {
      const realm = await this.starting.get(startKey);
      if (realm && realm.players.size < realm.maxPlayers) return { realm, reused: true, version };
    }
    const promise = this.startRealm({ game, version, privateServerId, joinCode, maxPlayers });
    this.starting.set(startKey, promise);
    try {
      const realm = await promise;
      return { realm, reused: false, version };
    } finally {
      this.starting.delete(startKey);
    }
  }

  async startRealm({ game, version, privateServerId = null, joinCode = null, maxPlayers = null, mode = 'live' }) {
    const bundle = JSON.parse(version.manifest);
    const realmId = ids.realm();
    const gameMax = maxPlayers ?? game.max_players ?? platformConfig.games.defaultMaxPlayers;
    db.servers.registerServer({
      // The registry row uses the same id as the realm so heartbeats and joins line up.
      id: realmId,
      gameId: game.id,
      versionId: version.id,
      region: 'local',
      host: 'in-process',
      port: 0,
      maxPlayers: gameMax,
      privateServerId,
      joinPath: `/realm/${realmId}`,
      metadata: { versionNumber: version.version_number },
    });

    const realm = new RealmServer({
      id: realmId,
      gameId: game.id,
      gameName: game.name,
      versionId: version.id,
      versionNumber: version.version_number,
      bundle,
      maxPlayers: gameMax,
      privateServerId,
      joinCode,
      idleShutdownSeconds: platformConfig.games.serverIdleShutdownSeconds,
      mode,
      services: this.buildServices({ id: realmId, ownerUserId: game.owner_user_id }),
      logger: log.child(`realm-${realmId.slice(-6)}`),
    });
    // The DB row id must match the realm id so heartbeats update the right row.
    realm.id = realmId;
    this.realms.set(realmId, realm);
    await realm.start();
    db.servers.updateServer(realmId, { status: 'running', pid: process.pid });
    log.info('realm started', { realmId, game: game.slug, version: version.version_number });
    return realm;
  }

  /**
   * Starts an editor play-test realm from any version (draft or published). Play-test realms are
   * not matchmade into and idle out quickly, but they run the exact same server as a live realm.
   */
  async startPlaytest({ game, version, userId, maxPlayers = 8 }) {
    const bundle = JSON.parse(version.manifest);
    const realmId = ids.realm();
    const limit = Math.max(1, Math.min(platformConfig.games.maxMaxPlayers, Number(maxPlayers) || 8));
    db.servers.registerServer({
      id: realmId,
      gameId: game.id,
      versionId: version.id,
      region: 'local',
      host: 'in-process',
      port: 0,
      maxPlayers: limit,
      privateServerId: null,
      joinPath: `/realm/${realmId}`,
      metadata: { playtest: true, startedBy: userId, versionNumber: version.version_number },
    });
    const realm = new RealmServer({
      id: realmId,
      gameId: game.id,
      gameName: game.name,
      versionId: version.id,
      versionNumber: version.version_number,
      bundle,
      maxPlayers: limit,
      idleShutdownSeconds: 300,
      mode: 'playtest',
      services: this.buildServices({ id: realmId, ownerUserId: game.owner_user_id }),
      logger: log.child(`playtest-${realmId.slice(-6)}`),
    });
    realm.id = realmId;
    this.realms.set(realmId, realm);
    this.playtests = (this.playtests ?? new Map()).set(realmId, { userId, gameId: game.id, startedAt: Date.now() });
    await realm.start();
    db.servers.updateServer(realmId, { status: 'running', pid: process.pid });
    log.info('play-test realm started', { realmId, game: game.slug, version: version.version_number, userId });
    return realm;
  }

  /** Issues a signed, short-lived join token for a specific user+realm. */
  issueJoinToken({ realmId, userId, gameId, ttlSeconds = 120 }) {
    const value = signJoinToken({ realmId, userId, gameId, nonce: token(6) }, ttlSeconds);
    this.joinTokens.set(`${realmId}:${userId}`, { token: value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return { token: value, expiresAt: Date.now() + ttlSeconds * 1000, realmId, ttlSeconds };
  }

  verifyJoinToken(joinToken, { realmId, userId = null } = {}) {
    const payload = verifyJoinToken(joinToken);
    if (!payload) throw new ForbiddenError('Join token is invalid or expired.');
    if (realmId && payload.realmId !== realmId) throw new ForbiddenError('Join token does not match this server.');
    if (userId && payload.userId !== userId) throw new ForbiddenError('Join token does not belong to this account.');
    return payload;
  }

  getRealm(realmId) {
    return this.realms.get(realmId) ?? null;
  }

  /** Live realm list for a game (used by the game page's server browser). */
  listRealms(gameId, { includePrivate = false } = {}) {
    return [...this.realms.values()]
      .filter((realm) => realm.gameId === gameId)
      .filter((realm) => (includePrivate ? true : !realm.privateServerId))
      .map((realm) => realm.snapshot)
      .sort((a, b) => b.playerCount - a.playerCount);
  }

  /** Removes stale database rows for realms this process no longer owns. */
  reconcile() {
    try {
      const stale = db.servers.staleServers(60);
      for (const row of stale) {
        if (!this.realms.has(row.id)) {
          db.servers.stopServer(row.id, { error: 'heartbeat lost' });
        }
      }
      const now = Date.now();
      for (const [key, entry] of this.joinTokens) {
        if (entry.expiresAt < now) this.joinTokens.delete(key);
      }
      const counts = db.servers.serverCounts();
      this.stats.players = counts.players;
    } catch (error) {
      log.warn('reconcile failed', { error: error.message });
    }
  }

  async shutdownAll() {
    await Promise.all([...this.realms.values()].map((realm) => realm.shutdown({ reason: 'platform_shutdown' }).catch(() => {})));
    this.realms.clear();
  }

  /**
   * WebSocket handling for the client. Uses the `ws` server in `noServer` mode so the same HTTP
   * port serves the API, the website, the editor and gameplay.
   */
  attachWebSocketServer(httpServer) {
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });
    httpServer.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head).catch((error) => {
        log.warn('upgrade failed', { error: error.message });
        socket.destroy();
      });
    });
    return this.wss;
  }

  async handleUpgrade(request, socket, head) {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const match = /^\/realm\/([a-z0-9_]+)/.exec(url.pathname);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const realmId = match[1];
    const realm = this.getRealm(realmId);
    if (!realm) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    let payload;
    try {
      payload = this.verifyJoinToken(url.searchParams.get('token') ?? '', { realmId });
    } catch (error) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (realm.isFull) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = db.users.findById(payload.userId);
    if (!user || user.status === 'banned') {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const ban = db.moderation.activeBan(user.id);
    if (ban) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (db.social.isBlocked(user.id, realm.gameId)) {
      // eslint-disable-next-line no-console
      log.debug('blocked user attempted to join a game');
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleConnection(ws, { realm, user, payload }).catch((error) => {
        log.warn('connection handling failed', { error: error.message });
        ws.close(1011, 'server error');
      });
    });
  }

  async handleConnection(ws, { realm, user, payload }) {
    const avatar = user.avatar_item_ids ? JSON.parse(user.avatar_item_ids) : {};
    const result = await realm.addPlayer({
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      avatar: {
        items: avatar,
        headColor: parseColors(user.avatar_colors).headColor,
        torsoColor: parseColors(user.avatar_colors).torsoColor,
        armColor: parseColors(user.avatar_colors).armColor,
        legColor: parseColors(user.avatar_colors).legColor,
      },
      socket: ws,
    });
    if (!result.ok) {
      ws.close(4004, result.reason);
      return;
    }
    const player = result.player;
    const serverTime = nowSeconds();
    // The welcome frame carries everything the client needs to render the first frames, including
    // the world chunks around the spawn point (streaming starts immediately).
    const scene = realm.bundle.world;
    const spawnPosition = player.character.position;
    const chunkRadius = realm.bundle.config?.streaming?.radiusStuds ?? 512;
    const chunkIds = Object.keys(scene.chunks ?? {}).filter((id) => {
      if (id === 'c_global') return true;
      const center = scene.chunks[id].bounds?.center ?? [0, 0, 0];
      const dx = center[0] - spawnPosition.x;
      const dz = center[2] - spawnPosition.z;
      return Math.hypot(dx, dz) <= chunkRadius + 128;
    });
    realm.send(ws, {
      t: 'welcome',
      protocol: 1,
      realm: realm.snapshot,
      game: { id: realm.gameId, name: realm.gameName, version: realm.versionNumber },
      player: { id: user.id, username: user.username, displayName: user.display_name },
      spawn: { position: spawnPosition, rotation: { x: 0, y: (player.character.facing * 180) / Math.PI, z: 0 } },
      config: realm.bundle.config,
      metadata: realm.bundle.metadata,
      chunks: chunkIds.length ? chunkIds : Object.keys(scene.chunks ?? {}),
      mode: realm.mode,
      serverTime,
      // Client scripts run in the player's own sandbox; the realm only ships their source.
      clientScripts: realm.clientScripts ?? [],
      // Screen UI authored in the world (UI service), flattened for the shared UI renderer.
      ui: realm.collectUiInstances(),
      // Startup output (and any earlier errors) so the client/editor console is never empty.
      logs: (realm.logHistory ?? []).slice(-100),
      playerData: player.savedData ?? {},
    });
    for (const other of realm.players.values()) {
      if (other.id === user.id) continue;
      realm.send(ws, {
        t: 'spawn',
        player: realm.publicPlayer(other),
        spawn: {
          position: other.character.position,
          rotation: { x: 0, y: (other.character.facing * 180) / Math.PI, z: 0 },
        },
      });
    }
    log.info('player joined realm', { realm: realm.id, userId: user.id, players: realm.players.size });

    let closed = false;
    const heartbeats = setInterval(() => {
      realm.heartbeat();
    }, 10_000);
    heartbeats.unref?.();

    ws.on('message', (data) => {
      if (data.length > PROTOCOL_LIMITS.maxFrameBytes) {
        ws.close(4009, 'frame too large');
        return;
      }
      const text = data.toString('utf8');
      const validation = validateFrame(text);
      if (!validation.ok) {
        realm.send(ws, { t: 'error', code: validation.error });
        return;
      }
      realm.handleMessage(player, text).catch((error) => {
        log.warn('message handling failed', { error: error.message });
      });
    });

    ws.on('close', () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeats);
      realm.removePlayer(user.id, { reason: 'disconnected' }).catch(() => {});
      log.info('player left realm', { realm: realm.id, userId: user.id });
    });

    ws.on('error', (error) => log.warn('socket error', { error: error.message }));
    ws.on('pong', () => {
      player.lastPongAt = Date.now();
    });
  }
}

function parseColors(raw) {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    return {
      headColor: parsed.headColor,
      torsoColor: parsed.torsoColor,
      armColor: parsed.armColor,
      legColor: parsed.legColor,
      shirtColor: parsed.shirt,
      pantsColor: parsed.pants,
    };
  } catch {
    return {};
  }
}

export default RealmManager;
