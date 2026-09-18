/**
 * /api/servers + /api/matchmaking — the Play button.
 *
 *   POST /api/games/:id/join   → matchmaking picks or starts a realm, returns a signed join token
 *                               and the websocket URL the client should connect to.
 *   POST /api/matchmaking/quickjoin → join a friend's server or any public server of a game.
 */
import { sendJson, limitUserInput, assertInt } from './helpers.js';
import { requireAuth, limiters } from '../context.js';
import * as db from '@kinetiq/db';
import {
  assertEnum,
  platformConfig,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  nowSeconds,
} from '@kinetiq/shared';
import { privateServerPublic } from './games.js';

export function registerRoutes(router, deps) {
  const { realms, notify } = deps;

  /** Matchmaking entry point used by the website Play button and the game client. */
  router.post('/api/games/:id/join', async (ctx) => {
    const user = requireAuth(ctx);
    limiters.matchmaking.check(`join:${user.id}`);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Game not found.');
    if (!game.is_published || game.moderation_status === 'removed') {
      throw new ForbiddenError('That game is not currently playable.');
    }
    const body = await ctx.json().catch(() => ({}));

    // Bans are enforced server side before any realm is allocated.
    const ban = db.moderation.activeBan(user.id);
    if (ban) throw new ForbiddenError(`You are banned from playing${ban.expires_at ? ` until ${ban.expires_at}` : ''}.`);

    const privacy = db.users.normalisePrivacy(user.privacy);
    void privacy;

    let privateServer = null;
    let joinCode = body.joinCode ? String(body.joinCode).slice(0, 32) : null;
    if (body.privateServerId) {
      privateServer = db.servers.getPrivateServer(String(body.privateServerId));
      if (!privateServer || privateServer.game_id !== game.id) throw new NotFoundError('Private server not found.');
      if (privateServer.owner_user_id !== user.id && !db.servers.privateServerMember(privateServer.id, user.id)) {
        throw new ForbiddenError('You are not a member of that private server.');
      }
      joinCode = privateServer.join_code;
    } else if (joinCode) {
      privateServer = db.servers.findPrivateServer(joinCode);
      if (!privateServer || privateServer.game_id !== game.id) throw new NotFoundError('That server code is not valid.');
      db.servers.addPrivateServerMember(privateServer.id, user.id);
    }

    const versionId = body.versionId ? String(body.versionId) : null;
    const { realm, reused, version } = await realms.findOrCreate({
      gameId: game.id,
      userId: user.id,
      versionId,
      privateServerId: privateServer?.id ?? null,
      joinCode: joinCode ?? null,
      maxPlayers: assertInt(body.maxPlayers ?? privateServer?.max_players ?? game.max_players, {
        field: 'maxPlayers',
        min: 1,
        max: platformConfig.games.maxMaxPlayers,
        fallback: game.max_players,
      }),
    });

    if (!reused) {
      notify?.({
        userId: user.id,
        kind: 'system',
        title: `Your server is ready`,
        body: `${game.name} — a new server was started for you.`,
        link: `/games/${game.slug}`,
      });
    }

    const { token, expiresAt, ttlSeconds } = realms.issueJoinToken({
      realmId: realm.id,
      userId: user.id,
      gameId: game.id,
    });
    db.servers.recordJoin(realm.id, user.id);
    db.games.recordPlay(game.id, user.id);

    sendJson(ctx.res, 200, {
      serverId: realm.id,
      gameId: game.id,
      versionId: version.id,
      versionNumber: version.version_number,
      reused,
      players: realm.playerCount,
      maxPlayers: realm.maxPlayers,
      region: realm.region,
      joinToken: token,
      joinTokenExpiresAt: expiresAt,
      joinTokenTtlSeconds: ttlSeconds,
      // Relative URL on purpose: the client resolves it against whatever host served this page,
      // so the same build works on localhost and behind the preview proxy.
      connectUrl: `/realm/${realm.id}?token=${encodeURIComponent(token)}`,
      privateServer: privateServer ? privateServerPublic(privateServer) : null,
      issuedAt: nowSeconds(),
    });
  });

  /** Quick join: prefer a friend's server, otherwise the busiest public server. */
  router.post('/api/matchmaking/quickjoin', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json().catch(() => ({}));
    const friendId = body.friendId ? String(body.friendId) : null;
    if (friendId) {
      const friend = db.users.findById(friendId);
      if (!friend) throw new NotFoundError('User not found.');
      if (!db.social.areFriends(user.id, friendId)) throw new ForbiddenError('You are not friends with that player.');
      const friendPrivacy = db.users.normalisePrivacy(friend.privacy);
      if (friendPrivacy.whoCanJoin === 'nobody') throw new ForbiddenError('That player does not allow joins.');
      if (friendPrivacy.whoCanJoin === 'friends' && !db.social.areFriends(user.id, friendId)) {
        throw new ForbiddenError('That player only allows friends to join.');
      }
      if (!friend.presence_game_id || friend.presence === 'offline') throw new ConflictErrorLike('That player is not in a game.');
      const game = db.games.findById(friend.presence_game_id);
      if (!game) throw new NotFoundError('That game is unavailable.');
      const realm = [...realms.realms.values()].find(
        (entry) => entry.gameId === game.id && [...entry.players.keys()].includes(friendId),
      );
      if (!realm) throw new ConflictErrorLike('That server is no longer running.');
      const { token, expiresAt, ttlSeconds } = realms.issueJoinToken({
        realmId: realm.id,
        userId: user.id,
        gameId: game.id,
      });
      db.servers.recordJoin(realm.id, user.id);
      sendJson(ctx.res, 200, {
        serverId: realm.id,
        gameId: game.id,
        game: db.games.toGameSummary(game),
        joinedFriend: { id: friend.id, username: friend.username, displayName: friend.display_name },
        joinToken: token,
        joinTokenExpiresAt: expiresAt,
        joinTokenTtlSeconds: ttlSeconds,
        connectUrl: `/realm/${realm.id}?token=${encodeURIComponent(token)}`,
      });
      return;
    }

    const sort = assertEnum(body.sort ?? 'most_played', ['most_played', 'popular', 'trending', 'recommended'], {
      field: 'sort',
      fallback: 'most_played',
    });
    const candidates = db.games.discover({ sort, limit: 25, multiplayerOnly: true }).rows;
    for (const game of candidates) {
      const live = realms.listRealms(game.id).find((realm) => realm.playerCount < realm.maxPlayers);
      if (!live) continue;
      const realm = realms.getRealm(live.id);
      const { token, expiresAt, ttlSeconds } = realms.issueJoinToken({
        realmId: realm.id,
        userId: user.id,
        gameId: game.id,
      });
      db.servers.recordJoin(realm.id, user.id);
      db.games.recordPlay(game.id, user.id);
      sendJson(ctx.res, 200, {
        serverId: realm.id,
        gameId: game.id,
        game: db.games.toGameSummary(game),
        joinToken: token,
        joinTokenExpiresAt: expiresAt,
        joinTokenTtlSeconds: ttlSeconds,
        connectUrl: `/realm/${realm.id}?token=${encodeURIComponent(token)}`,
      });
      return;
    }
    // Nothing running: pick the top multiplayer game and start a fresh realm.
    const game = candidates[0] ?? db.games.discover({ sort: 'recommended', limit: 1 }).rows[0];
    if (!game) throw new NotFoundError('No games are available to join right now.');
    const { realm } = await realms.findOrCreate({ gameId: game.id, userId: user.id });
    const { token, expiresAt, ttlSeconds } = realms.issueJoinToken({
      realmId: realm.id,
      userId: user.id,
      gameId: game.id,
    });
    db.servers.recordJoin(realm.id, user.id);
    db.games.recordPlay(game.id, user.id);
    sendJson(ctx.res, 200, {
      serverId: realm.id,
      gameId: game.id,
      game: db.games.toGameSummary(game),
      joinToken: token,
      joinTokenExpiresAt: expiresAt,
      joinTokenTtlSeconds: ttlSeconds,
      connectUrl: `/realm/${realm.id}?token=${encodeURIComponent(token)}`,
    });
  });

  /** Platform-wide server status (used by the admin panel and developer console). */
  router.get('/api/servers', async (ctx) => {
    const live = [...realms.realms.values()].map((realm) => realm.snapshot);
    sendJson(ctx.res, 200, {
      servers: live,
      counts: db.servers.serverCounts(),
      inProcess: live.length,
      region: 'local',
    });
  });

  router.get('/api/servers/:id', async (ctx) => {
    const realm = realms.getRealm(ctx.params.id);
    if (realm) {
      sendJson(ctx.res, 200, { server: realm.snapshot });
      return;
    }
    const row = db.servers.getServer(ctx.params.id);
    if (!row) throw new NotFoundError('Server not found.');
    sendJson(ctx.res, 200, {
      server: {
        id: row.id,
        gameId: row.game_id,
        region: row.region,
        status: row.status,
        playerCount: row.current_players,
        maxPlayers: row.max_players,
        startedAt: row.started_at,
      },
    });
  });

  /** Create a private server (paid with platform currency when a price is set). */
  router.post('/api/games/:id/private-servers', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Game not found.');
    if (!game.allow_private_servers) throw new ForbiddenError('This game does not allow private servers.');
    const body = await ctx.json().catch(() => ({}));
    const price = game.private_server_price ?? 0;
    if (price > 0) {
      const balance = db.economy.balanceOf(user.id);
      if (balance < price) throw new ForbiddenError(`You need ${price - balance} more ${platformConfig.currencyName}.`);
      db.economy.spendCredits(user.id, price, 'private_server_purchase', {
        gameId: game.id,
        description: `Private server: ${game.name}`,
      });
      if (game.owner_user_id) {
        const share = db.economy.creatorShareOf(price, platformConfig.economy.developerRevenueShare);
        if (share > 0) {
          db.economy.postTransaction({
            kind: 'sale',
            toUserId: game.owner_user_id,
            amount: share,
            gameId: game.id,
            description: `Private server revenue: ${game.name}`,
          });
        }
      }
    }
    const joinCode = generateJoinCode();
    const privateServer = db.servers.createPrivateServer({
      gameId: game.id,
      ownerUserId: user.id,
      name: limitUserInput(body.name ?? `${game.name} — private`, { max: 60 }),
      maxPlayers: assertInt(body.maxPlayers ?? game.max_players, {
        field: 'maxPlayers',
        min: 1,
        max: platformConfig.games.maxMaxPlayers,
        fallback: game.max_players,
      }),
      pricePaid: price,
      joinCode,
    });
    sendJson(ctx.res, 201, { privateServer: privateServerPublic(privateServer) });
  });

  router.get('/api/games/:id/private-servers', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Game not found.');
    const servers = db.servers.listPrivateServers(game.id, { ownerUserId: user.id });
    sendJson(ctx.res, 200, { privateServers: servers.map(privateServerPublic) });
  });

  router.post('/api/private-servers/:id/members', async (ctx) => {
    const user = requireAuth(ctx);
    const server = db.servers.getPrivateServer(ctx.params.id);
    if (!server) throw new NotFoundError('Private server not found.');
    if (server.owner_user_id !== user.id) throw new ForbiddenError('Only the owner can manage members.');
    const body = await ctx.json();
    const target = db.users.findByUsername(String(body.username ?? ''));
    if (!target) throw new NotFoundError('User not found.');
    if (body.remove) db.servers.removePrivateServerMember(server.id, target.id);
    else db.servers.addPrivateServerMember(server.id, target.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.delete('/api/private-servers/:id', async (ctx) => {
    const user = requireAuth(ctx);
    const server = db.servers.getPrivateServer(ctx.params.id);
    if (!server) throw new NotFoundError('Private server not found.');
    if (server.owner_user_id !== user.id) throw new ForbiddenError('Only the owner can delete this server.');
    db.servers.deactivatePrivateServer(server.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  /** Graceful shutdown request (owner or staff); used by the admin panel. */
  router.post('/api/servers/:id/shutdown', async (ctx) => {
    const user = requireAuth(ctx);
    const realm = realms.getRealm(ctx.params.id);
    if (!realm) throw new NotFoundError('Server not found.');
    const game = db.games.findById(realm.gameId);
    const isOwner = game && game.owner_user_id === user.id;
    if (!isOwner && user.role !== 'admin') throw new ForbiddenError('Not allowed.');
    const body = await ctx.json().catch(() => ({}));
    const snapshot = await realm.shutdown({ reason: limitUserInput(body.reason ?? 'owner_request', { max: 100 }) });
    sendJson(ctx.res, 200, { ok: true, server: snapshot });
  });

  return router;
}

/** Readable join codes (no ambiguous characters) so players can share them verbally. */
function generateJoinCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 4; j += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (i < 2) out += '-';
  }
  return out;
}

class ConflictErrorLike extends Error {
  constructor(message) {
    super(message);
    this.status = 409;
    this.code = 'conflict';
  }
}

export default registerRoutes;
