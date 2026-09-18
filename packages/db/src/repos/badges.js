/** Creator-defined badges and player awards. */
import { all, get, run, transaction } from '../db.js';
import { ids } from '@kinetiq/shared';

export function createBadge({ gameId = null, creatorUserId = null, name, description = '', iconAssetId = null }) {
  const id = ids.badge();
  run(
    `INSERT INTO badges (id, game_id, creator_user_id, name, description, icon_asset_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, gameId, creatorUserId, String(name).slice(0, 80), String(description).slice(0, 500), iconAssetId],
  );
  return getBadge(id);
}

export function getBadge(id) {
  return get(
    `SELECT b.*, g.name AS game_name, u.username AS creator_username FROM badges b
     LEFT JOIN games g ON g.id = b.game_id LEFT JOIN users u ON u.id = b.creator_user_id WHERE b.id = ?`,
    [id],
  );
}

export function listBadges({ gameId = null, creatorUserId = null, activeOnly = true, limit = 50 } = {}) {
  const conditions = [];
  const params = [];
  if (gameId) {
    conditions.push('b.game_id = ?');
    params.push(gameId);
  }
  if (creatorUserId) {
    conditions.push('b.creator_user_id = ?');
    params.push(creatorUserId);
  }
  if (activeOnly) conditions.push('b.is_active = 1');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return all(
    `SELECT b.*, g.name AS game_name FROM badges b LEFT JOIN games g ON g.id = b.game_id
     ${where} ORDER BY b.created_at DESC LIMIT ?`,
    [...params, limit],
  );
}

export function updateBadge(badgeId, patch) {
  const fields = [];
  const params = [];
  for (const [key, column] of Object.entries({
    name: 'name',
    description: 'description',
    iconAssetId: 'icon_asset_id',
    isActive: 'is_active',
  })) {
    if (patch[key] === undefined) continue;
    fields.push(`${column} = ?`);
    params.push(typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0) : patch[key]);
  }
  if (!fields.length) return getBadge(badgeId);
  params.push(badgeId);
  run(`UPDATE badges SET ${fields.join(', ')} WHERE id = ?`, params);
  return getBadge(badgeId);
}

export function awardBadge(badgeId, userId, { gameId = null } = {}) {
  return transaction(() => {
    const badge = getBadge(badgeId);
    if (!badge) return { awarded: false, reason: 'unknown_badge' };
    const existing = get('SELECT 1 AS x FROM player_badges WHERE user_id = ? AND badge_id = ?', [userId, badgeId]);
    if (existing) return { awarded: false, reason: 'already_awarded', badge };
    run('INSERT INTO player_badges (user_id, badge_id, game_id) VALUES (?, ?, ?)', [userId, badgeId, gameId ?? badge.game_id]);
    run('UPDATE badges SET award_count = award_count + 1 WHERE id = ?', [badgeId]);
    run(
      `INSERT INTO inventory (id, user_id, kind, ref_id, acquired_via) VALUES (?, ?, 'badge', ?, 'badge_award')
       ON CONFLICT (user_id, kind, ref_id) DO NOTHING`,
      [`inv_${ids.item().slice(4, 20)}`, userId, badgeId],
    );
    return { awarded: true, badge };
  });
}

export function playerBadges(userId, { limit = 100 } = {}) {
  return all(
    `SELECT b.*, pb.awarded_at, g.name AS game_name FROM player_badges pb
     JOIN badges b ON b.id = pb.badge_id
     LEFT JOIN games g ON g.id = b.game_id
     WHERE pb.user_id = ? ORDER BY pb.awarded_at DESC LIMIT ?`,
    [userId, limit],
  );
}

export function badgeAwards(badgeId, { limit = 100 } = {}) {
  return all(
    `SELECT u.id, u.username, u.display_name, pb.awarded_at FROM player_badges pb
     JOIN users u ON u.id = pb.user_id WHERE pb.badge_id = ? ORDER BY pb.awarded_at DESC LIMIT ?`,
    [badgeId, limit],
  );
}

export function hasBadge(userId, badgeId) {
  return Boolean(get('SELECT 1 AS x FROM player_badges WHERE user_id = ? AND badge_id = ?', [userId, badgeId]));
}
