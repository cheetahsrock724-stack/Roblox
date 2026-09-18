/**
 * /api/reports + /api/moderation — user reporting and the moderator action surface.
 *
 * Ordinary users can only *create* reports. Every moderation action requires the moderator or
 * admin role, is validated server side, is written to the immutable audit log, and notifies the
 * affected user so the appeals flow can start.
 */
import { sendJson, limitUserInput, pagination } from './helpers.js';
import { requireAuth, requireRole, hasRole } from '../context.js';
import * as db from '@kinetiq/db';
import {
  REPORT_CATEGORIES,
  MODERATION_ACTIONS,
  assertEnum,
  assertInt,
  platformConfig,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from '@kinetiq/shared';

export function registerRoutes(router, deps) {
  const { notify, realms } = deps;

  /** ---------------------------------------------------------------- reporting */
  router.post('/api/reports', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json();
    const targetType = assertEnum(body.targetType, ['user', 'game', 'asset', 'message', 'group'], {
      field: 'targetType',
    });
    const category = assertEnum(body.category, REPORT_CATEGORIES, { field: 'category' });
    const targetId = String(body.targetId ?? '');
    if (!targetId) throw new ValidationError('Missing target.');

    // Verify the target exists so reports cannot be used to pollute the queue.
    const exists =
      targetType === 'user'
        ? Boolean(db.users.findById(targetId))
        : targetType === 'game'
          ? Boolean(db.games.findById(targetId))
          : targetType === 'asset'
            ? Boolean(db.assets.getAsset(targetId))
            : targetType === 'group'
              ? Boolean(db.groups.getGroup(targetId))
              : Boolean(db.get('SELECT id FROM messages WHERE id = ?', [targetId]));
    if (!exists) throw new NotFoundError('That content no longer exists.');

    const recent = db.get(
      `SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > datetime('now', '-1 hour')`,
      [user.id],
    )?.n;
    if ((recent ?? 0) > 20) throw new ConflictError('You have submitted a lot of reports recently. Try again later.');

    const report = db.moderation.createReport({
      reporterId: user.id,
      targetType,
      targetId,
      category,
      details: limitUserInput(body.details ?? '', { max: 2000 }),
    });
    sendJson(ctx.res, 201, { report: { id: report.id, status: report.status, createdAt: report.created_at } });
  });

  router.get('/api/reports/mine', async (ctx) => {
    const user = requireAuth(ctx);
    sendJson(ctx.res, 200, {
      reports: db.all(
        'SELECT id, target_type, target_id, category, status, created_at, resolution FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 50',
        [user.id],
      ).map((row) => ({
        id: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        category: row.category,
        status: row.status,
        resolution: row.resolution,
        createdAt: row.created_at,
      })),
    });
  });

  /** ---------------------------------------------------------------- moderation queue */
  router.get('/api/moderation/reports', async (ctx) => {
    requireRole(ctx, 'moderator');
    const { limit, offset } = pagination(ctx, { defaultLimit: 50 });
    const status = ctx.query.get('status') ?? null;
    const result = db.moderation.listReports({ status, limit, offset });
    sendJson(ctx.res, 200, {
      reports: result.rows.map((row) => ({
        id: row.id,
        reporterId: row.reporter_id,
        reporterUsername: row.reporter_username,
        targetType: row.target_type,
        targetId: row.target_id,
        category: row.category,
        details: row.details,
        status: row.status,
        assignedTo: row.assigned_to,
        resolution: row.resolution,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      total: result.total,
      stats: db.moderation.moderationStats(),
    });
  });

  router.post('/api/moderation/reports/:id', async (ctx) => {
    const moderator = requireRole(ctx, 'moderator');
    const report = db.moderation.getReport(ctx.params.id);
    if (!report) throw new NotFoundError('Report not found.');
    const body = await ctx.json();
    const status = assertEnum(body.status ?? 'under_review', ['open', 'under_review', 'actioned', 'dismissed', 'appealed'], {
      field: 'status',
      fallback: 'under_review',
    });
    const updated = db.moderation.updateReport(report.id, {
      status,
      assignedTo: moderator.id,
      resolution: body.resolution ? limitUserInput(body.resolution, { max: 2000 }) : undefined,
    });
    db.moderation.audit({
      actorId: moderator.id,
      action: 'report_update',
      targetType: 'report',
      targetId: report.id,
      metadata: { status },
      ip: ctx.ip,
    });
    sendJson(ctx.res, 200, { report: { id: updated.id, status: updated.status, resolution: updated.resolution } });
  });

  /** ---------------------------------------------------------------- actions */
  router.post('/api/moderation/actions', async (ctx) => {
    const moderator = requireRole(ctx, 'moderator');
    const body = await ctx.json();
    const action = assertEnum(body.action, MODERATION_ACTIONS, { field: 'action' });
    const targetType = assertEnum(body.targetType, ['user', 'game', 'asset', 'group', 'message'], { field: 'targetType' });
    const targetId = String(body.targetId ?? '');
    if (!targetId) throw new ValidationError('Missing target.');
    const reason = limitUserInput(body.reason ?? '', { max: 1000, field: 'reason' });

    // Role separation: destructive platform actions are admin-only.
    const adminOnly = ['ban_permanent', 'reset_password', 'republish_game', 'restore_asset'];
    if (adminOnly.includes(action) && !hasRole(moderator, 'admin')) {
      throw new ForbiddenError('Only administrators can take that action.');
    }
    if (targetType === 'user' && targetId === moderator.id) {
      throw new ForbiddenError('You cannot moderate your own account.');
    }

    let durationMinutes = null;
    if (action === 'ban_temporary') {
      durationMinutes = assertInt(body.durationMinutes ?? 1440, { field: 'durationMinutes', min: 5, max: 525_600 });
    }
    if (action === 'mute') {
      durationMinutes = assertInt(body.durationMinutes ?? 60, { field: 'durationMinutes', min: 1, max: 525_600 });
    }

    const target = resolveTarget(targetType, targetId);
    if (!target) throw new NotFoundError('Target not found.');

    const record = db.moderation.recordAction({
      moderatorId: moderator.id,
      targetType,
      targetId,
      action,
      reason,
      durationMinutes,
      reportId: body.reportId ?? null,
      metadata: { previousState: summariseTarget(targetType, target) },
    });

    applyAction({ action, targetType, target, durationMinutes, reason, realms, notify });

    db.moderation.audit({
      actorId: moderator.id,
      action: `moderation:${action}`,
      targetType,
      targetId,
      metadata: { durationMinutes, reason: reason.slice(0, 200) },
      ip: ctx.ip,
    });

    sendJson(ctx.res, 201, {
      action: {
        id: record.id,
        action: record.action,
        targetType: record.target_type,
        targetId: record.target_id,
        reason: record.reason,
        expiresAt: record.expires_at,
        createdAt: record.created_at,
      },
    });
  });

  router.get('/api/moderation/history', async (ctx) => {
    requireRole(ctx, 'moderator');
    const { limit, offset } = pagination(ctx, { defaultLimit: 100 });
    const result = db.moderation.moderationHistory({
      targetType: ctx.query.get('targetType') ?? null,
      targetId: ctx.query.get('targetId') ?? null,
      moderatorId: ctx.query.get('moderatorId') ?? null,
      limit,
      offset,
    });
    sendJson(ctx.res, 200, {
      actions: result.rows.map((row) => ({
        id: row.id,
        moderatorId: row.moderator_id,
        moderatorUsername: row.moderator_username,
        targetType: row.target_type,
        targetId: row.target_id,
        action: row.action,
        reason: row.reason,
        durationMinutes: row.duration_minutes,
        expiresAt: row.expires_at,
        active: Boolean(row.active),
        createdAt: row.created_at,
      })),
      total: result.total,
    });
  });

  router.get('/api/moderation/audit', async (ctx) => {
    requireRole(ctx, 'admin');
    const { limit, offset } = pagination(ctx, { defaultLimit: 100 });
    sendJson(ctx.res, 200, {
      entries: db.moderation.auditLog({ limit, offset, action: ctx.query.get('action') ?? null }).map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        actorUsername: row.actor_username,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        metadata: safeJson(row.metadata),
        ip: row.ip,
        createdAt: row.created_at,
      })),
    });
  });

  /** ---------------------------------------------------------------- appeals */
  router.post('/api/moderation/appeals', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json();
    const actionId = String(body.actionId ?? '');
    const rows = db.moderation.moderationHistory({ targetType: 'user', targetId: user.id, limit: 50 }).rows;
    const action = rows.find((row) => row.id === actionId);
    if (!action) throw new NotFoundError('That moderation action is not on your account.');
    const existing = db.get(
      `SELECT id FROM moderation_appeals WHERE action_id = ? AND status = 'open'`,
      [actionId],
    );
    if (existing) throw new ConflictError('You already have an open appeal for that action.');
    const appeal = db.moderation.createAppeal({
      actionId,
      userId: user.id,
      body: limitUserInput(body.body, { max: 4000, field: 'body', required: true }),
    });
    sendJson(ctx.res, 201, { appeal: { id: appeal.id, status: appeal.status, createdAt: appeal.created_at } });
  });

  router.get('/api/moderation/appeals', async (ctx) => {
    const user = requireAuth(ctx);
    const mine = hasRole(user, 'moderator') ? null : user.id;
    const appeals = db.moderation.listAppeals({ status: ctx.query.get('status') ?? null, limit: 100 });
    sendJson(ctx.res, 200, {
      appeals: appeals
        .filter((row) => (mine ? row.user_id === mine : true))
        .map((row) => ({
          id: row.id,
          userId: row.user_id,
          username: row.username,
          actionId: row.action_id,
          action: row.action,
          reason: row.reason,
          body: row.body,
          status: row.status,
          reviewNote: row.review_note,
          createdAt: row.created_at,
          reviewedAt: row.reviewed_at,
        })),
    });
  });

  router.post('/api/moderation/appeals/:id', async (ctx) => {
    const moderator = requireRole(ctx, 'admin');
    const body = await ctx.json();
    const status = assertEnum(body.status, ['approved', 'denied', 'open'], { field: 'status' });
    const appeal = db.moderation.reviewAppeal(ctx.params.id, {
      reviewerId: moderator.id,
      status,
      note: limitUserInput(body.note ?? '', { max: 2000 }),
    });
    if (status === 'approved') {
      // Approved appeals undo the underlying sanction (ban/mute/unpublish).
      const action = db.get('SELECT * FROM moderation_actions WHERE id = ?', [appeal.action_id]);
      if (action) {
        db.moderation.deactivateActions(action.target_type, action.target_id, [
          'ban_temporary',
          'ban_permanent',
          'mute',
          'unpublish_game',
          'remove_asset',
        ]);
        if (action.target_type === 'user') {
          db.users.setSanction(action.target_id, { status: 'active', reason: null, until: null });
          notify?.({
            userId: action.target_id,
            kind: 'moderation',
            title: 'Your appeal was approved',
            body: limitUserInput(body.note ?? 'The action on your account has been lifted.', { max: 500 }),
            link: '/settings',
          });
        }
        if (action.target_type === 'game') {
          db.games.updateGame(action.target_id, { isPublished: true, moderationStatus: 'approved' });
        }
        if (action.target_type === 'asset') {
          db.assets.updateAsset(action.target_id, { moderationStatus: 'approved' });
        }
      }
    }
    db.moderation.audit({
      actorId: moderator.id,
      action: 'appeal_review',
      targetType: 'appeal',
      targetId: appeal.id,
      metadata: { status },
      ip: ctx.ip,
    });
    sendJson(ctx.res, 200, { appeal: { id: appeal.id, status: appeal.status } });
  });

  /** A moderator's own view of active sanctions against the caller (for the appeal form). */
  router.get('/api/moderation/my-sanctions', async (ctx) => {
    const user = requireAuth(ctx);
    const rows = db.moderation.moderationHistory({ targetType: 'user', targetId: user.id, limit: 50 }).rows;
    sendJson(ctx.res, 200, {
      sanctions: rows
        .filter((row) => ['ban_temporary', 'ban_permanent', 'mute', 'warn'].includes(row.action))
        .map((row) => ({
          id: row.id,
          action: row.action,
          reason: row.reason,
          expiresAt: row.expires_at,
          active: Boolean(row.active),
          createdAt: row.created_at,
        })),
    });
  });

  return router;
}

function resolveTarget(targetType, targetId) {
  switch (targetType) {
    case 'user':
      return db.users.findById(targetId);
    case 'game':
      return db.games.findById(targetId);
    case 'asset':
      return db.assets.getAsset(targetId);
    case 'group':
      return db.groups.getGroup(targetId);
    case 'message':
      return db.get('SELECT * FROM messages WHERE id = ?', [targetId]);
    default:
      return null;
  }
}

function summariseTarget(targetType, target) {
  if (!target) return null;
  if (targetType === 'game') return { isPublished: Boolean(target.is_published), moderationStatus: target.moderation_status };
  if (targetType === 'asset') return { moderationStatus: target.moderation_status };
  if (targetType === 'user') return { status: target.status, role: target.role };
  return {};
}

/** Applies a moderation action to platform state (never to UI only). */
function applyAction({ action, targetType, target, durationMinutes, reason, realms, notify }) {
  const expiresAt = durationMinutes
    ? new Date(Date.now() + durationMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)
    : null;

  switch (action) {
    case 'warn':
      if (targetType === 'user') {
        db.notifications.notify(target.id, {
          kind: 'moderation',
          title: 'Warning issued',
          body: reason || 'A moderator has issued a warning on your account.',
          link: '/settings',
        });
      }
      break;
    case 'mute':
      // Mute is enforced by checking active mutes before chat/message endpoints.
      if (targetType === 'user') {
        notify?.({
          userId: target.id,
          kind: 'moderation',
          title: 'You have been muted',
          body: `${reason} ${expiresAt ? `Until ${expiresAt}.` : ''}`.trim(),
          link: '/settings',
        });
      }
      break;
    case 'ban_temporary':
    case 'ban_permanent':
      if (targetType === 'user') {
        db.users.setSanction(target.id, { status: 'banned', reason, until: expiresAt });
        db.sessions.revokeAllSessions(target.id);
        for (const realm of realms?.realms?.values?.() ?? []) {
          if (realm.players.has(target.id)) realm.kickPlayer(target.id, `Banned: ${reason}`);
        }
        notify?.({
          userId: target.id,
          kind: 'moderation',
          title: 'Your account was banned',
          body: `${reason} ${expiresAt ? `Until ${expiresAt}.` : 'This ban is permanent.'}`.trim(),
          link: '/settings',
        });
      }
      break;
    case 'unban':
      if (targetType === 'user') {
        db.moderation.deactivateActions('user', target.id, ['ban_temporary', 'ban_permanent']);
        db.users.setSanction(target.id, { status: 'active', reason: null, until: null });
        db.notifications.notify(target.id, {
          kind: 'moderation',
          title: 'Your ban was lifted',
          body: reason || 'Welcome back.',
          link: '/home',
        });
      }
      break;
    case 'kick':
      if (targetType === 'user') {
        for (const realm of realms?.realms?.values?.() ?? []) {
          if (realm.players.has(target.id)) realm.kickPlayer(target.id, reason || 'Kicked by a moderator');
        }
      }
      break;
    case 'remove_asset':
      if (targetType === 'asset') {
        db.assets.updateAsset(target.id, { moderationStatus: 'removed', moderationNote: reason });
        if (target.owner_user_id) {
          notify?.({
            userId: target.owner_user_id,
            kind: 'moderation',
            title: 'An asset was removed',
            body: reason,
            link: '/creator/assets',
          });
        }
      }
      break;
    case 'restore_asset':
      if (targetType === 'asset') db.assets.updateAsset(target.id, { moderationStatus: 'approved' });
      break;
    case 'unpublish_game':
      if (targetType === 'game') {
        db.games.updateGame(target.id, { isPublished: false, moderationStatus: 'removed' });
        for (const realm of realms?.realms?.values?.() ?? []) {
          if (realm.gameId === target.id) realm.shutdown({ reason: 'game_unpublished' });
        }
        if (target.owner_user_id) {
          notify?.({
            userId: target.owner_user_id,
            kind: 'moderation',
            title: 'A game was unpublished',
            body: reason,
            link: '/creator',
          });
        }
      }
      break;
    case 'republish_game':
      if (targetType === 'game') db.games.updateGame(target.id, { isPublished: true, moderationStatus: 'approved' });
      break;
    case 'reset_password':
      if (targetType === 'user') {
        db.sessions.revokeAllSessions(target.id);
        db.notifications.notify(target.id, {
          kind: 'moderation',
          title: 'Password reset required',
          body: 'An administrator requires you to reset your password.',
          link: '/reset',
        });
      }
      break;
    case 'note':
      db.notifications.notify(target.id, {
        kind: 'moderation',
        title: 'Moderator note',
        body: reason || 'A note was added to your account.',
        link: '/settings',
      });
      break;
    default:
      break;
  }
  void platformConfig;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export default registerRoutes;
