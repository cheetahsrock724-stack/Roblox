/** Reports, moderation actions, appeals and the audit log. */
import { all, get, run, transaction } from '../db.js';
import { ids } from '@kinetiq/shared';

export function createReport({ reporterId = null, targetType, targetId, category, details = '' }) {
  const id = ids.report();
  run(
    `INSERT INTO reports (id, reporter_id, target_type, target_id, category, details) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, reporterId, targetType, targetId, category, String(details).slice(0, 2000)],
  );
  return getReport(id);
}

export function getReport(id) {
  return get(
    `SELECT r.*, u.username AS reporter_username FROM reports r LEFT JOIN users u ON u.id = r.reporter_id WHERE r.id = ?`,
    [id],
  );
}

export function listReports({ status = null, targetType = null, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (status) {
    conditions.push('r.status = ?');
    params.push(status);
  }
  if (targetType) {
    conditions.push('r.target_type = ?');
    params.push(targetType);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = all(
    `SELECT r.*, u.username AS reporter_username FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
     ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = get(`SELECT COUNT(*) AS n FROM reports r ${where}`, params)?.n ?? 0;
  return { rows, total };
}

export function updateReport(reportId, patch) {
  const fields = [];
  const params = [];
  for (const [key, column] of Object.entries({ status: 'status', assignedTo: 'assigned_to', resolution: 'resolution' })) {
    if (patch[key] === undefined) continue;
    fields.push(`${column} = ?`);
    params.push(patch[key]);
  }
  if (!fields.length) return getReport(reportId);
  fields.push(`updated_at = datetime('now')`);
  params.push(reportId);
  run(`UPDATE reports SET ${fields.join(', ')} WHERE id = ?`, params);
  return getReport(reportId);
}

export function openReportCount() {
  return get(`SELECT COUNT(*) AS n FROM reports WHERE status IN ('open','under_review')`)?.n ?? 0;
}

export function recordAction({
  moderatorId,
  targetType,
  targetId,
  action,
  reason = '',
  durationMinutes = null,
  reportId = null,
  metadata = {},
}) {
  const id = ids.moderation();
  const expiresAt =
    durationMinutes && durationMinutes > 0
      ? new Date(Date.now() + durationMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)
      : null;
  run(
    `INSERT INTO moderation_actions (id, moderator_id, target_type, target_id, action, reason, duration_minutes,
      expires_at, report_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      moderatorId,
      targetType,
      targetId,
      action,
      String(reason).slice(0, 1000),
      durationMinutes,
      expiresAt,
      reportId,
      JSON.stringify(metadata ?? {}),
    ],
  );
  return get('SELECT * FROM moderation_actions WHERE id = ?', [id]);
}

export function deactivateActions(targetType, targetId, actions) {
  const placeholders = actions.map(() => '?').join(', ');
  run(
    `UPDATE moderation_actions SET active = 0 WHERE target_type = ? AND target_id = ? AND action IN (${placeholders})`,
    [targetType, targetId, ...actions],
  );
}

export function moderationHistory({ targetType = null, targetId = null, moderatorId = null, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (targetType) {
    conditions.push('m.target_type = ?');
    params.push(targetType);
  }
  if (targetId) {
    conditions.push('m.target_id = ?');
    params.push(targetId);
  }
  if (moderatorId) {
    conditions.push('m.moderator_id = ?');
    params.push(moderatorId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = all(
    `SELECT m.*, u.username AS moderator_username FROM moderation_actions m
     LEFT JOIN users u ON u.id = m.moderator_id ${where}
     ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = get(`SELECT COUNT(*) AS n FROM moderation_actions m ${where}`, params)?.n ?? 0;
  return { rows, total };
}

/** Currently-active ban for a user, if any. */
export function activeBan(userId) {
  return get(
    `SELECT * FROM moderation_actions WHERE target_type = 'user' AND target_id = ? AND active = 1
      AND action IN ('ban_temporary','ban_permanent')
      AND (expires_at IS NULL OR expires_at > datetime('now'))
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
}

export function activeMute(userId) {
  return get(
    `SELECT * FROM moderation_actions WHERE target_type = 'user' AND target_id = ? AND active = 1
      AND action = 'mute' AND (expires_at IS NULL OR expires_at > datetime('now'))
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
}

export function createAppeal({ actionId, userId, body }) {
  const id = `apl_${ids.report().slice(4, 18)}`;
  run('INSERT INTO moderation_appeals (id, action_id, user_id, body) VALUES (?, ?, ?, ?)', [
    id,
    actionId,
    userId,
    String(body).slice(0, 4000),
  ]);
  return get('SELECT * FROM moderation_appeals WHERE id = ?', [id]);
}

export function listAppeals({ status = null, limit = 50 } = {}) {
  const where = status ? 'WHERE a.status = ?' : '';
  const params = status ? [status, limit] : [limit];
  return all(
    `SELECT a.*, u.username, m.action, m.reason, m.target_id AS action_target_id FROM moderation_appeals a
     JOIN users u ON u.id = a.user_id JOIN moderation_actions m ON m.id = a.action_id
     ${where} ORDER BY a.created_at DESC LIMIT ?`,
    params,
  );
}

export function reviewAppeal(appealId, { reviewerId, status, note = '' }) {
  run(
    `UPDATE moderation_appeals SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ?`,
    [status, reviewerId, String(note).slice(0, 1000), appealId],
  );
  return get('SELECT * FROM moderation_appeals WHERE id = ?', [appealId]);
}

export function audit({ actorId = null, action, targetType = null, targetId = null, metadata = {}, ip = null }) {
  run(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, metadata, ip) VALUES (?, ?, ?, ?, ?, ?)`,
    [actorId, action, targetType, targetId, JSON.stringify(metadata ?? {}), ip],
  );
}

export function auditLog({ limit = 100, offset = 0, action = null } = {}) {
  const where = action ? 'WHERE a.action = ?' : '';
  const params = action ? [action, limit, offset] : [limit, offset];
  return all(
    `SELECT a.*, u.username AS actor_username FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    params,
  );
}

export function moderationStats() {
  return {
    openReports: openReportCount(),
    totalReports: get('SELECT COUNT(*) AS n FROM reports')?.n ?? 0,
    activeBans: get(
      `SELECT COUNT(*) AS n FROM moderation_actions WHERE active = 1 AND action IN ('ban_temporary','ban_permanent')`,
    )?.n ?? 0,
    openAppeals: get(`SELECT COUNT(*) AS n FROM moderation_appeals WHERE status = 'open'`)?.n ?? 0,
    actionsToday: get(`SELECT COUNT(*) AS n FROM moderation_actions WHERE created_at > datetime('now','-1 day')`)?.n ?? 0,
  };
}
