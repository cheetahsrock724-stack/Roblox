/** Sessions and refresh-token rotation. Refresh tokens are stored hashed, never in plaintext. */
import { all, get, run, transaction } from '../db.js';
import { ids, token, sha256, nowSeconds } from '@kinetiq/shared';

const ACCESS_TTL_SECONDS = 60 * 60 * 6; // 6 hours
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function createSession(userId, { userAgent = '', ip = '' } = {}) {
  const id = ids.session();
  const refreshToken = token(32);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString().replace('T', ' ').slice(0, 19);
  run(
    `INSERT INTO sessions (id, user_id, refresh_hash, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, sha256(refreshToken), String(userAgent).slice(0, 300), String(ip).slice(0, 64), expiresAt],
  );
  return { id, refreshToken, expiresAt, ttl: ACCESS_TTL_SECONDS };
}

export function getSession(sessionId) {
  return get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
}

export function sessionUser(sessionId) {
  return get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')`,
    [sessionId],
  );
}

export function touchSession(sessionId) {
  run('UPDATE sessions SET last_used_at = datetime("now") WHERE id = ?', [sessionId]);
}

/** Rotates the refresh token; the old token is invalidated immediately (theft detection). */
export function rotateRefreshToken(sessionId, presentedRefreshToken, { ip = '', userAgent = '' } = {}) {
  return transaction(() => {
    const session = getSession(sessionId);
    if (!session) return { ok: false, reason: 'not_found' };
    if (session.revoked_at) return { ok: false, reason: 'revoked' };
    if (Date.parse(`${session.expires_at.replace(' ', 'T')}Z`) < Date.now()) return { ok: false, reason: 'expired' };
    if (session.refresh_hash !== sha256(String(presentedRefreshToken))) {
      // Presented a stale/incorrect refresh token: assume compromise and kill the session.
      run('UPDATE sessions SET revoked_at = datetime("now") WHERE id = ?', [sessionId]);
      return { ok: false, reason: 'mismatch' };
    }
    const next = token(32);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString().replace('T', ' ').slice(0, 19);
    run(
      `UPDATE sessions SET refresh_hash = ?, expires_at = ?, last_used_at = datetime('now'),
        ip = COALESCE(NULLIF(?, ''), ip), user_agent = COALESCE(NULLIF(?, ''), user_agent)
       WHERE id = ?`,
      [sha256(next), expiresAt, String(ip).slice(0, 64), String(userAgent).slice(0, 300), sessionId],
    );
    return { ok: true, refreshToken: next, expiresAt, userId: session.user_id };
  });
}

export function revokeSession(sessionId) {
  run('UPDATE sessions SET revoked_at = datetime("now") WHERE id = ?', [sessionId]);
}

export function revokeAllSessions(userId, { exceptSessionId = null } = {}) {
  if (exceptSessionId) {
    run('UPDATE sessions SET revoked_at = datetime("now") WHERE user_id = ? AND id != ?', [userId, exceptSessionId]);
  } else {
    run('UPDATE sessions SET revoked_at = datetime("now") WHERE user_id = ?', [userId]);
  }
}

export function listSessions(userId) {
  return all(
    `SELECT id, user_agent, ip, created_at, last_used_at, expires_at, revoked_at FROM sessions
     WHERE user_id = ? ORDER BY last_used_at DESC LIMIT 50`,
    [userId],
  );
}

export function purgeExpiredSessions() {
  const result = run(
    `DELETE FROM sessions WHERE expires_at < datetime('now', '-7 days') OR revoked_at < datetime('now', '-7 days')`,
  );
  return result.changes;
}

/** Password reset tokens. */
export function createPasswordReset(userId, ttlMinutes = 30) {
  const id = ids.session();
  const raw = token(24);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  run('INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)', [
    id,
    userId,
    sha256(raw),
    expiresAt,
  ]);
  return { token: raw, expiresAt, id };
}

export function consumePasswordReset(rawToken) {
  return transaction(() => {
    const row = get(
      `SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
      [sha256(String(rawToken))],
    );
    if (!row) return null;
    run('UPDATE password_resets SET used_at = datetime("now") WHERE id = ?', [row.id]);
    return row;
  });
}

export { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, nowSeconds };
