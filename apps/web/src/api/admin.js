/**
 * /api/admin — the operations dashboard. Every endpoint here is gated by `requireRole`, so hiding
 * the UI is never the only protection: an attacker with a normal session gets 403 from the API.
 */
import { sendJson, limitUserInput, pagination } from './helpers.js';
import { requireRole } from '../context.js';
import * as db from '@kinetiq/db';
import {
  assertEnum,
  assertInt,
  NotFoundError,
  ValidationError,
  platformConfig,
  ASSET_MODERATION,
} from '@kinetiq/shared';

export function registerRoutes(router, deps) {
  const { realms, notify } = deps;

  router.get('/api/admin/overview', async (ctx) => {
    requireRole(ctx, 'moderator');
    const stats = db.games.platformStats();
    const counts = db.servers.serverCounts();
    const live = [...(realms?.realms?.values?.() ?? [])].map((realm) => realm.snapshot);
    sendJson(ctx.res, 200, {
      platform: {
        name: platformConfig.platformName,
        currency: platformConfig.currencyName,
        version: '0.1.0',
        env: process.env.NODE_ENV ?? 'development',
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      stats: {
        ...stats,
        servers: counts.running + live.length,
        playersInServers: counts.players,
        newUsersToday: db.get(`SELECT COUNT(*) AS n FROM users WHERE created_at > datetime('now','-1 day')`)?.n ?? 0,
        activeToday:
          db.get(`SELECT COUNT(*) AS n FROM users WHERE last_login_at > datetime('now','-1 day')`)?.n ?? 0,
      },
      moderation: db.moderation.moderationStats(),
      realms: live,
    });
  });

  router.get('/api/admin/users', async (ctx) => {
    requireRole(ctx, 'moderator');
    const { limit, offset } = pagination(ctx, { defaultLimit: 50 });
    const result = db.users.listUsers({
      limit,
      offset,
      role: ctx.query.get('role') ?? null,
      status: ctx.query.get('status') ?? null,
      query: ctx.query.get('q') ?? null,
    });
    sendJson(ctx.res, 200, {
      users: result.rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        email: ctx.user.role === 'admin' ? row.email : undefined,
        role: row.role,
        status: row.status,
        statusReason: row.status_reason,
        statusUntil: row.status_until,
        presence: row.presence,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
        loginCount: row.login_count,
        balance: db.economy.balanceOf(row.id),
        isDeveloper: Boolean(row.is_developer),
      })),
      total: result.total,
    });
  });

  router.get('/api/admin/users/:id', async (ctx) => {
    requireRole(ctx, 'moderator');
    const user = db.users.findById(ctx.params.id);
    if (!user) throw new NotFoundError('User not found.');
    sendJson(ctx.res, 200, {
      user: {
        ...db.users.toPublicUser(user, { includePrivate: ctx.user.role === 'admin' }),
        status: user.status,
        statusReason: user.status_reason,
        balance: db.economy.balanceOf(user.id),
        sessions: db.sessions.listSessions(user.id).length,
      },
      games: db.games.discover({ ownerUserId: user.id, publishedOnly: false, includeUnlisted: true, limit: 25 }).rows.map(
        (row) => db.games.toGameSummary(row),
      ),
      transactions: db.economy.transactionHistory(user.id, { limit: 25 }).map((row) => ({
        id: row.id,
        kind: row.kind,
        amount: row.amount,
        direction: row.from_user_id === user.id ? 'out' : 'in',
        description: row.description,
        createdAt: row.created_at,
      })),
      moderation: db.moderation.moderationHistory({ targetType: 'user', targetId: user.id, limit: 25 }).rows.map((row) => ({
        id: row.id,
        action: row.action,
        reason: row.reason,
        active: Boolean(row.active),
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      })),
      reports: db.moderation.listReports({ limit: 25 }).rows
        .filter((row) => row.target_type === 'user' && row.target_id === user.id)
        .map((row) => ({ id: row.id, category: row.category, status: row.status, createdAt: row.created_at })),
    });
  });

  router.post('/api/admin/users/:id/role', async (ctx) => {
    requireRole(ctx, 'admin');
    const body = await ctx.json();
    const role = assertEnum(body.role, ['user', 'moderator', 'admin'], { field: 'role' });
    const target = db.users.findById(ctx.params.id);
    if (!target) throw new NotFoundError('User not found.');
    if (target.id === ctx.user.id) throw new ValidationError('You cannot change your own role.');
    db.users.setRole(target.id, role);
    db.moderation.audit({
      actorId: ctx.user.id,
      action: 'role_change',
      targetType: 'user',
      targetId: target.id,
      metadata: { from: target.role, to: role },
      ip: ctx.ip,
    });
    notify?.({
      userId: target.id,
      kind: 'moderation',
      title: 'Your account role changed',
      body: `You are now ${role === 'user' ? 'a regular user' : `a ${role}`}.`,
      link: '/home',
    });
    sendJson(ctx.res, 200, { role });
  });

  router.get('/api/admin/games', async (ctx) => {
    requireRole(ctx, 'moderator');
    const { limit, offset } = pagination(ctx, { defaultLimit: 50 });
    const result = db.games.discover({
      publishedOnly: false,
      includeUnlisted: true,
      search: ctx.query.get('q') ?? null,
      limit,
      offset,
      sort: 'updated',
    });
    sendJson(ctx.res, 200, {
      games: result.rows.map((row) => ({
        ...db.games.toGameSummary(row),
        versions: db.games.listVersions(row.id, { limit: 3 }).length,
        reportCount: db.get('SELECT COUNT(*) AS n FROM reports WHERE target_type = ? AND target_id = ?', ['game', row.id])?.n ?? 0,
      })),
      total: result.total,
    });
  });

  router.get('/api/admin/assets', async (ctx) => {
    requireRole(ctx, 'moderator');
    const { limit, offset } = pagination(ctx, { defaultLimit: 50 });
    const result = db.assets.listAssets({
      moderationStatus: ctx.query.get('status') ?? null,
      limit,
      offset,
      assetType: ctx.query.get('type') ?? null,
    });
    sendJson(ctx.res, 200, {
      assets: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        assetType: row.asset_type,
        sizeBytes: row.size_bytes,
        moderationStatus: row.moderation_status,
        ownerUsername: row.owner_username,
        createdAt: row.created_at,
        url: `/api/assets/${row.id}/raw`,
      })),
      total: result.total,
      statuses: ASSET_MODERATION,
    });
  });

  router.get('/api/admin/transactions', async (ctx) => {
    requireRole(ctx, 'moderator');
    const { limit, offset } = pagination(ctx, { defaultLimit: 100 });
    const result = db.economy.allTransactions({ limit, offset, kind: ctx.query.get('kind') ?? null });
    sendJson(ctx.res, 200, {
      transactions: result.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        amount: row.amount,
        fromUsername: row.from_username,
        toUsername: row.to_username,
        gameName: row.game_name,
        description: row.description,
        createdAt: row.created_at,
      })),
      total: result.total,
      totals: {
        creditsMoved: db.get('SELECT COALESCE(SUM(amount),0) AS n FROM transactions')?.n ?? 0,
        transactionCount: db.get('SELECT COUNT(*) AS n FROM transactions')?.n ?? 0,
        balances: db.get('SELECT COALESCE(SUM(balance),0) AS n FROM currency_balances')?.n ?? 0,
      },
    });
  });

  router.get('/api/admin/servers', async (ctx) => {
    requireRole(ctx, 'moderator');
    const live = [...(realms?.realms?.values?.() ?? [])].map((realm) => realm.snapshot);
    const rows = db.all(
      `SELECT * FROM game_servers ORDER BY started_at DESC LIMIT 100`,
    ).map((row) => ({
      id: row.id,
      gameId: row.game_id,
      status: row.status,
      region: row.region,
      playerCount: row.current_players,
      maxPlayers: row.max_players,
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      endedAt: row.ended_at,
      error: row.error,
      live: live.some((entry) => entry.id === row.id),
    }));
    sendJson(ctx.res, 200, { servers: rows, live, counts: db.servers.serverCounts() });
  });

  router.post('/api/admin/servers/:id/stop', async (ctx) => {
    requireRole(ctx, 'admin');
    const realm = realms?.getRealm(ctx.params.id);
    if (!realm) throw new NotFoundError('That realm is not running in this process.');
    const body = await ctx.json().catch(() => ({}));
    const snapshot = await realm.shutdown({ reason: limitUserInput(body.reason ?? 'admin_request', { max: 100 }) });
    db.moderation.audit({
      actorId: ctx.user.id,
      action: 'realm_stop',
      targetType: 'server',
      targetId: ctx.params.id,
      metadata: { reason: body.reason ?? 'admin_request' },
      ip: ctx.ip,
    });
    sendJson(ctx.res, 200, { server: snapshot });
  });

  /** Broadcast a platform-wide notice (maintenance windows, events). */
  router.post('/api/admin/broadcast', async (ctx) => {
    requireRole(ctx, 'admin');
    const body = await ctx.json();
    const title = limitUserInput(body.title, { max: 120, field: 'title', required: true });
    const messageBody = limitUserInput(body.body ?? '', { max: 1000 });
    const audience = assertEnum(body.audience ?? 'all', ['all', 'developers', 'moderators'], {
      field: 'audience',
      fallback: 'all',
    });
    const limit = assertInt(body.limit ?? 5000, { field: 'limit', min: 1, max: 50_000, fallback: 5000 });
    const where =
      audience === 'developers'
        ? 'WHERE is_developer = 1'
        : audience === 'moderators'
          ? `WHERE role IN ('moderator','admin')`
          : '';
    const users = db.all(`SELECT id FROM users ${where} LIMIT ?`, [limit]);
    for (const user of users) {
      db.notifications.notify(user.id, {
        kind: 'system',
        title,
        body: messageBody,
        link: '/home',
      });
    }
    db.moderation.audit({
      actorId: ctx.user.id,
      action: 'broadcast',
      targetType: 'platform',
      metadata: { audience, count: users.length },
      ip: ctx.ip,
    });
    sendJson(ctx.res, 200, { sent: users.length });
  });

  /** Feature flag / platform meta store. */
  router.get('/api/admin/flags', async (ctx) => {
    requireRole(ctx, 'admin');
    const rows = db.all('SELECT key, value, updated_at FROM platform_meta ORDER BY key');
    sendJson(ctx.res, 200, {
      flags: rows.map((row) => ({ key: row.key, value: safeJson(row.value), updatedAt: row.updated_at })),
    });
  });

  router.put('/api/admin/flags/:key', async (ctx) => {
    requireRole(ctx, 'admin');
    const body = await ctx.json();
    const key = String(ctx.params.key).slice(0, 60);
    if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(key)) throw new ValidationError('Invalid flag key.');
    db.run(
      `INSERT INTO platform_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [key, JSON.stringify(body.value ?? null)],
    );
    db.moderation.audit({
      actorId: ctx.user.id,
      action: 'flag_set',
      targetType: 'flag',
      targetId: key,
      metadata: { value: body.value ?? null },
      ip: ctx.ip,
    });
    sendJson(ctx.res, 200, { key, value: body.value ?? null });
  });

  void dependenciesGuard;
  return router;
}

const dependenciesGuard = { notify: null };

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export default registerRoutes;
