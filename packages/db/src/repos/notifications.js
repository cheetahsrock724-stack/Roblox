/** Notifications with per-user fan-out and read state. */
import { all, get, run } from '../db.js';
import { ids } from '@kinetiq/shared';

export function notify(userId, { kind, title, body = '', link = null, data = {} }) {
  const id = ids.notification();
  run(
    `INSERT INTO notifications (id, user_id, kind, title, body, link, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, kind, String(title).slice(0, 200), String(body).slice(0, 1000), link, JSON.stringify(data ?? {})],
  );
  return id;
}

export function listNotifications(userId, { limit = 30, unreadOnly = false } = {}) {
  const clause = unreadOnly ? 'AND read_at IS NULL' : '';
  return all(
    `SELECT * FROM notifications WHERE user_id = ? ${clause} ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    link: row.link,
    data: safeParse(row.data),
    readAt: row.read_at,
    createdAt: row.created_at,
  }));
}

export function unreadCount(userId) {
  return get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId])?.n ?? 0;
}

export function markRead(userId, notificationId) {
  run('UPDATE notifications SET read_at = datetime("now") WHERE user_id = ? AND id = ?', [userId, notificationId]);
}

export function markAllRead(userId) {
  run('UPDATE notifications SET read_at = datetime("now") WHERE user_id = ? AND read_at IS NULL', [userId]);
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
