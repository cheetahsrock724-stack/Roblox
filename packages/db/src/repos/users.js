/** User records: creation, lookup, profile updates, privacy, presence, sanctions. */
import { all, get, run, transaction } from '../db.js';
import { ids, hashPassword, verifyPassword, nowSeconds } from '@kinetiq/shared';
import { PRIVACY_KEYS, PRIVACY_VALUES, NOTIFICATION_KINDS } from '@kinetiq/shared';

export const DEFAULT_PRIVACY = {
  whoCanMessage: 'everyone',
  whoCanJoin: 'friends',
  whoCanSeeInventory: 'everyone',
  whoCanFriendRequest: 'everyone',
  whoCanInvite: 'friends',
  whoCanSeeActivity: 'friends',
};

export const DEFAULT_SETTINGS = {
  graphics: 'auto',
  musicVolume: 0.6,
  sfxVolume: 0.8,
  chatVisible: true,
  reducedMotion: false,
  theme: 'dark',
};

function parseJson(value, fallback) {
  if (value === null || value === undefined) return { ...fallback };
  if (typeof value === 'object') return value;
  try {
    return { ...fallback, ...JSON.parse(value) };
  } catch {
    return { ...fallback };
  }
}

export function normalisePrivacy(raw) {
  const parsed = parseJson(raw, DEFAULT_PRIVACY);
  const out = {};
  for (const key of PRIVACY_KEYS) {
    const value = parsed[key];
    out[key] = PRIVACY_VALUES.includes(value) ? value : DEFAULT_PRIVACY[key];
  }
  return out;
}

export function toPublicUser(row, { includePrivate = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarItemIds: parseJson(row.avatar_item_ids, {}),
    avatarColors: parseJson(row.avatar_colors, {}),
    avatarImageId: row.avatar_image_id ?? null,
    createdAt: row.created_at,
    presence: row.presence,
    presenceGameId: row.presence_game_id ?? null,
    isDeveloper: Boolean(row.is_developer),
    isVerifiedCreator: Boolean(row.is_verified_creator),
    role: row.role,
  };
  if (includePrivate) {
    base.email = row.email ?? null;
    base.emailVerified = Boolean(row.email_verified);
    base.privacy = normalisePrivacy(row.privacy);
    base.settings = parseJson(row.settings, DEFAULT_SETTINGS);
    base.status = row.status;
    base.statusReason = row.status_reason ?? null;
    base.statusUntil = row.status_until ?? null;
    base.lastLoginAt = row.last_login_at ?? null;
    base.loginCount = row.login_count;
    base.totalPlaytimeSeconds = row.total_playtime_seconds ?? 0;
  }
  return base;
}

/** Compact user card used inside lists (friends, search results, members). */
export function toUserCard(row, extras = {}) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    presence: row.presence,
    presenceGameId: row.presence_game_id ?? null,
    avatarItemIds: parseJson(row.avatar_item_ids, {}),
    avatarColors: parseJson(row.avatar_colors, {}),
    ...extras,
  };
}

export function createUser({ username, displayName, email, password, role = 'user', bio = '', emailVerified = false }) {
  const id = ids.user();
  const passwordHash = hashPassword(password);
  transaction(() => {
    run(
      `INSERT INTO users (id, username, display_name, email, email_verified, password_hash, role, bio, privacy, settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        username,
        displayName || username,
        email ?? null,
        emailVerified ? 1 : 0,
        passwordHash,
        role,
        bio,
        JSON.stringify(DEFAULT_PRIVACY),
        JSON.stringify(DEFAULT_SETTINGS),
      ],
    );
    run('INSERT INTO currency_balances (user_id, balance) VALUES (?, 0)', [id]);
  });
  return findById(id);
}

export function findById(id) {
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

export function findByUsername(username) {
  return get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [username]);
}

export function findByEmail(email) {
  return get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [email]);
}

export function usernameExists(username) {
  return Boolean(findByUsername(username));
}

export function emailExists(email) {
  return Boolean(findByEmail(email));
}

export function authenticate(username, password) {
  const user = findByUsername(username);
  if (!user) return { ok: false, reason: 'invalid_credentials' };
  if (user.status === 'deleted') return { ok: false, reason: 'invalid_credentials' };
  const valid = verifyPassword(password, user.password_hash);
  if (!valid) return { ok: false, reason: 'invalid_credentials', user };
  return { ok: true, user };
}

export function recordLoginSuccess(userId, ip) {
  run(
    `UPDATE users SET last_login_at = datetime('now'), login_count = login_count + 1, failed_login_count = 0,
      locked_until = NULL, updated_at = datetime('now') WHERE id = ?`,
    [userId],
  );
  run('INSERT INTO login_attempts (username, ip, successful) VALUES (?, ?, 1)', [userId, ip ?? null]);
}

export function recordLoginFailure(username, ip) {
  run('INSERT INTO login_attempts (username, ip, successful) VALUES (?, ?, 0)', [username, ip ?? null]);
  const user = findByUsername(username);
  if (!user) return { locked: false, attempts: 1 };
  const attempts = user.failed_login_count + 1;
  run('UPDATE users SET failed_login_count = ? WHERE id = ?', [attempts, user.id]);
  return { locked: false, attempts };
}

export function lockAccount(userId, minutes) {
  run(`UPDATE users SET locked_until = datetime('now', '+' || ? || ' minutes') WHERE id = ?`, [minutes, userId]);
}

export function isLocked(user) {
  if (!user?.locked_until) return false;
  return Date.parse(`${user.locked_until.replace(' ', 'T')}Z`) > Date.now();
}

export function updatePassword(userId, password) {
  run('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?', [
    hashPassword(password),
    userId,
  ]);
}

export function updateProfile(userId, { displayName, bio, avatarItemIds, avatarColors, avatarImageId, settings }) {
  const fields = [];
  const params = [];
  if (displayName !== undefined) {
    fields.push('display_name = ?');
    params.push(displayName);
  }
  if (bio !== undefined) {
    fields.push('bio = ?');
    params.push(bio);
  }
  if (avatarItemIds !== undefined) {
    fields.push('avatar_item_ids = ?');
    params.push(JSON.stringify(avatarItemIds));
  }
  if (avatarColors !== undefined) {
    fields.push('avatar_colors = ?');
    params.push(JSON.stringify(avatarColors));
  }
  if (avatarImageId !== undefined) {
    fields.push('avatar_image_id = ?');
    params.push(avatarImageId);
  }
  if (settings !== undefined) {
    fields.push('settings = ?');
    params.push(JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }));
  }
  if (!fields.length) return findById(userId);
  fields.push('updated_at = datetime(\'now\')');
  params.push(userId);
  run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
  return findById(userId);
}

export function updatePrivacy(userId, privacy) {
  const merged = { ...normalisePrivacy(get('SELECT privacy FROM users WHERE id = ?', [userId])?.privacy), ...privacy };
  const clean = normalisePrivacy(merged);
  run('UPDATE users SET privacy = ?, updated_at = datetime(\'now\') WHERE id = ?', [JSON.stringify(clean), userId]);
  return clean;
}

export function setPresence(userId, presence, { gameId = null, realmId = null } = {}) {
  run(
    `UPDATE users SET presence = ?, presence_game_id = ?, presence_realm_id = ?, presence_updated_at = datetime('now')
     WHERE id = ?`,
    [presence, gameId, realmId, userId],
  );
}

/** Marks users offline when their heartbeat goes stale (called by a periodic sweep). */
export function sweepStalePresence(olderThanSeconds = 90) {
  const result = run(
    `UPDATE users SET presence = 'offline', presence_game_id = NULL, presence_realm_id = NULL
     WHERE presence != 'offline' AND (presence_updated_at IS NULL OR presence_updated_at < datetime('now', ?))`,
    [`-${Math.floor(olderThanSeconds)} seconds`],
  );
  return result.changes;
}

export function setSanction(userId, { status, reason, until = null }) {
  run('UPDATE users SET status = ?, status_reason = ?, status_until = ?, updated_at = datetime(\'now\') WHERE id = ?', [
    status,
    reason ?? null,
    until,
    userId,
  ]);
}

export function setRole(userId, role) {
  run('UPDATE users SET role = ?, updated_at = datetime(\'now\') WHERE id = ?', [role, userId]);
}

export function markDeveloper(userId, isDeveloper = true) {
  run('UPDATE users SET is_developer = ? WHERE id = ?', [isDeveloper ? 1 : 0, userId]);
}

export function setAvatarImage(userId, assetId) {
  run('UPDATE users SET avatar_image_id = ?, updated_at = datetime(\'now\') WHERE id = ?', [assetId, userId]);
}

export function addPlaytime(userId, seconds) {
  run('UPDATE users SET total_playtime_seconds = total_playtime_seconds + ? WHERE id = ?', [
    Math.max(0, Math.floor(seconds)),
    userId,
  ]);
}

export function searchUsers(query, { limit = 20, offset = 0 } = {}) {
  const like = `%${String(query).replace(/[%_]/g, (m) => `\\${m}`)}%`;
  return all(
    `SELECT * FROM users
     WHERE status != 'deleted' AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
     ORDER BY (username = ? COLLATE NOCASE) DESC, presence != 'offline' DESC, username ASC
     LIMIT ? OFFSET ?`,
    [like, like, query, limit, offset],
  );
}

export function listUsers({ limit = 50, offset = 0, role = null, status = null, query = null } = {}) {
  const conditions = [];
  const params = [];
  if (role) {
    conditions.push('role = ?');
    params.push(role);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (query) {
    conditions.push('(username LIKE ? OR display_name LIKE ?)');
    params.push(`%${query}%`, `%${query}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = all(`SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const total = get(`SELECT COUNT(*) AS n FROM users ${where}`, params)?.n ?? 0;
  return { rows, total };
}

export function userCount() {
  return get('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
}

export function countActiveSince(seconds) {
  return (
    get(`SELECT COUNT(*) AS n FROM users WHERE last_login_at > datetime('now', ?)`, [`-${seconds} seconds`])?.n ?? 0
  );
}

export function touchActivity(userId) {
  run('UPDATE users SET presence_updated_at = datetime(\'now\') WHERE id = ?', [userId]);
}

export { NOTIFICATION_KINDS, nowSeconds };
