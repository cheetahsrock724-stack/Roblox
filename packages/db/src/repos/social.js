/** Friends, friend requests, followers, blocks, direct messages. */
import { all, get, run, transaction } from '../db.js';
import { ids } from '@kinetiq/shared';

function orderPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

export function areFriends(a, b) {
  const [x, y] = orderPair(a, b);
  return Boolean(get('SELECT 1 AS x FROM friends WHERE user_a_id = ? AND user_b_id = ?', [x, y]));
}

export function isBlocked(blockerId, blockedId) {
  return Boolean(get('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]));
}

export function blockedEitherWay(a, b) {
  return isBlocked(a, b) || isBlocked(b, a);
}

export function sendFriendRequest(fromUserId, toUserId, message = '') {
  if (fromUserId === toUserId) return { ok: false, reason: 'self' };
  if (areFriends(fromUserId, toUserId)) return { ok: false, reason: 'already_friends' };
  if (blockedEitherWay(fromUserId, toUserId)) return { ok: false, reason: 'blocked' };
  return transaction(() => {
    const reverse = get(
      `SELECT * FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'`,
      [toUserId, fromUserId],
    );
    if (reverse) {
      // The other side already asked; accept instead of creating a mirror request.
      return { ok: true, autoAccepted: true, requestId: reverse.id };
    }
    const existing = get(
      `SELECT * FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?`,
      [fromUserId, toUserId],
    );
    if (existing && existing.status === 'pending') return { ok: false, reason: 'already_requested', requestId: existing.id };
    const id = ids.user().replace('usr', 'frq');
    if (existing) {
      run(
        `UPDATE friend_requests SET status = 'pending', message = ?, created_at = datetime('now'), responded_at = NULL
         WHERE id = ?`,
        [String(message).slice(0, 200), existing.id],
      );
      return { ok: true, requestId: existing.id };
    }
    run(
      `INSERT INTO friend_requests (id, from_user_id, to_user_id, message) VALUES (?, ?, ?, ?)`,
      [id, fromUserId, toUserId, String(message).slice(0, 200)],
    );
    return { ok: true, requestId: id };
  });
}

export function respondToFriendRequest(requestId, userId, accept) {
  return transaction(() => {
    const request = get('SELECT * FROM friend_requests WHERE id = ?', [requestId]);
    if (!request) return { ok: false, reason: 'not_found' };
    if (request.to_user_id !== userId) return { ok: false, reason: 'forbidden' };
    if (request.status !== 'pending') return { ok: false, reason: 'already_handled' };
    run(`UPDATE friend_requests SET status = ?, responded_at = datetime('now') WHERE id = ?`, [
      accept ? 'accepted' : 'declined',
      requestId,
    ]);
    if (accept) {
      addFriend(request.from_user_id, request.to_user_id);
    }
    return { ok: true, accepted: Boolean(accept), fromUserId: request.from_user_id };
  });
}

export function cancelFriendRequest(requestId, userId) {
  const request = get('SELECT * FROM friend_requests WHERE id = ?', [requestId]);
  if (!request || request.from_user_id !== userId) return false;
  run(`UPDATE friend_requests SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?`, [requestId]);
  return true;
}

export function addFriend(a, b) {
  const [x, y] = orderPair(a, b);
  run('INSERT OR IGNORE INTO friends (user_a_id, user_b_id) VALUES (?, ?)', [x, y]);
  return true;
}

export function removeFriend(a, b) {
  const [x, y] = orderPair(a, b);
  const result = run('DELETE FROM friends WHERE user_a_id = ? AND user_b_id = ?', [x, y]);
  return result.changes > 0;
}

export function listFriends(userId, { limit = 200, offset = 0 } = {}) {
  return all(
    `SELECT u.*, f.created_at AS friends_since FROM friends f
     JOIN users u ON u.id = CASE WHEN f.user_a_id = ? THEN f.user_b_id ELSE f.user_a_id END
     WHERE (f.user_a_id = ? OR f.user_b_id = ?) AND u.status != 'deleted'
     ORDER BY (u.presence != 'offline') DESC, u.presence, u.username
     LIMIT ? OFFSET ?`,
    [userId, userId, userId, limit, offset],
  );
}

export function friendIds(userId) {
  return all(
    `SELECT CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END AS id FROM friends
     WHERE user_a_id = ? OR user_b_id = ?`,
    [userId, userId, userId],
  ).map((row) => row.id);
}

export function friendCount(userId) {
  return (
    get('SELECT COUNT(*) AS n FROM friends WHERE user_a_id = ? OR user_b_id = ?', [userId, userId])?.n ?? 0
  );
}

export function incomingRequests(userId) {
  return all(
    `SELECT r.*, u.username AS from_username, u.display_name AS from_display_name, u.presence AS from_presence
     FROM friend_requests r JOIN users u ON u.id = r.from_user_id
     WHERE r.to_user_id = ? AND r.status = 'pending'
     ORDER BY r.created_at DESC`,
    [userId],
  );
}

export function outgoingRequests(userId) {
  return all(
    `SELECT r.*, u.username AS to_username, u.display_name AS to_display_name, u.presence AS to_presence
     FROM friend_requests r JOIN users u ON u.id = r.to_user_id
     WHERE r.from_user_id = ? AND r.status = 'pending'
     ORDER BY r.created_at DESC`,
    [userId],
  );
}

export function pendingRequestBetween(a, b) {
  return get(
    `SELECT * FROM friend_requests WHERE status = 'pending' AND
     ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
    [a, b, b, a],
  );
}

export function follow(followerId, targetId) {
  if (followerId === targetId) return false;
  run('INSERT OR IGNORE INTO followers (follower_id, target_id) VALUES (?, ?)', [followerId, targetId]);
  return true;
}

export function unfollow(followerId, targetId) {
  return run('DELETE FROM followers WHERE follower_id = ? AND target_id = ?', [followerId, targetId]).changes > 0;
}

export function followers(targetId, { limit = 100, offset = 0 } = {}) {
  return all(
    `SELECT u.*, f.created_at AS followed_at FROM followers f JOIN users u ON u.id = f.follower_id
     WHERE f.target_id = ? ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    [targetId, limit, offset],
  );
}

export function following(followerId, { limit = 100, offset = 0 } = {}) {
  return all(
    `SELECT u.*, f.created_at AS followed_at FROM followers f JOIN users u ON u.id = f.target_id
     WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    [followerId, limit, offset],
  );
}

export function followerCount(userId) {
  return get('SELECT COUNT(*) AS n FROM followers WHERE target_id = ?', [userId])?.n ?? 0;
}

export function followingCount(userId) {
  return get('SELECT COUNT(*) AS n FROM followers WHERE follower_id = ?', [userId])?.n ?? 0;
}

export function isFollowing(followerId, targetId) {
  return Boolean(get('SELECT 1 AS x FROM followers WHERE follower_id = ? AND target_id = ?', [followerId, targetId]));
}

/** Messages: direct user-to-user and persisted game chat logs for moderation. */
export function directThread(a, b) {
  const [x, y] = orderPair(a, b);
  let thread = get(
    `SELECT t.* FROM message_threads t
     JOIN thread_participants p1 ON p1.thread_id = t.id AND p1.user_id = ?
     JOIN thread_participants p2 ON p2.thread_id = t.id AND p2.user_id = ?
     WHERE t.kind = 'direct' LIMIT 1`,
    [x, y],
  );
  if (!thread) {
    const id = ids.message().replace('msg', 'thr');
    run(`INSERT INTO message_threads (id, kind) VALUES (?, 'direct')`, [id]);
    run('INSERT INTO thread_participants (thread_id, user_id) VALUES (?, ?)', [id, x]);
    run('INSERT INTO thread_participants (thread_id, user_id) VALUES (?, ?)', [id, y]);
    thread = get('SELECT * FROM message_threads WHERE id = ?', [id]);
  }
  return thread;
}

export function postDirectMessage(fromUserId, toUserId, body, { filteredBody = null } = {}) {
  return transaction(() => {
    const thread = directThread(fromUserId, toUserId);
    const id = ids.message();
    run(
      `INSERT INTO messages (id, thread_id, sender_id, recipient_id, kind, body, body_filtered)
       VALUES (?, ?, ?, ?, 'direct', ?, ?)`,
      [id, thread.id, fromUserId, toUserId, String(body).slice(0, 2000), filteredBody],
    );
    run('UPDATE message_threads SET updated_at = datetime("now") WHERE id = ?', [thread.id]);
    return get('SELECT * FROM messages WHERE id = ?', [id]);
  });
}

export function listThread(threadId, { limit = 50, offset = 0 } = {}) {
  return all(
    `SELECT m.*, u.username AS sender_username, u.display_name AS sender_display_name
     FROM messages m LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.thread_id = ? ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
    [threadId, limit, offset],
  );
}

export function listThreads(userId, { limit = 40 } = {}) {
  return all(
    `SELECT t.id, t.updated_at, p.last_read_at,
       (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.sender_id != ?) AS message_count,
       (SELECT m2.body FROM messages m2 WHERE m2.thread_id = t.id ORDER BY m2.created_at DESC LIMIT 1) AS last_body,
       (SELECT m3.sender_id FROM messages m3 WHERE m3.thread_id = t.id ORDER BY m3.created_at DESC LIMIT 1) AS last_sender_id,
       (SELECT u.username FROM thread_participants tp2 JOIN users u ON u.id = tp2.user_id
         WHERE tp2.thread_id = t.id AND tp2.user_id != ? LIMIT 1) AS other_username,
       (SELECT tp3.user_id FROM thread_participants tp3 WHERE tp3.thread_id = t.id AND tp3.user_id != ? LIMIT 1) AS other_user_id
     FROM message_threads t
     JOIN thread_participants p ON p.thread_id = t.id AND p.user_id = ?
     ORDER BY t.updated_at DESC LIMIT ?`,
    [userId, userId, userId, userId, limit],
  );
}

export function markThreadRead(threadId, userId) {
  run('UPDATE thread_participants SET last_read_at = datetime("now") WHERE thread_id = ? AND user_id = ?', [
    threadId,
    userId,
  ]);
  run(
    'UPDATE messages SET read_at = datetime("now") WHERE thread_id = ? AND recipient_id = ? AND read_at IS NULL',
    [threadId, userId],
  );
}

export function recordGameChat({ gameId, serverId, userId, username, body, filteredBody = null }) {
  const id = ids.message();
  run(
    `INSERT INTO messages (id, sender_id, kind, body, body_filtered, game_id, server_id, moderation_state)
     VALUES (?, ?, 'game', ?, ?, ?, ?, 'visible')`,
    [id, userId, `${username}: ${String(body).slice(0, 500)}`, filteredBody, gameId, serverId],
  );
  if (filteredBody) run('UPDATE messages SET moderation_state = ? WHERE id = ?', ['filtered', id]);
  return id;
}

export function recentGameChat(gameId, { limit = 100 } = {}) {
  return all('SELECT * FROM messages WHERE game_id = ? ORDER BY created_at DESC LIMIT ?', [gameId, limit]);
}

export function blockUser(blockerId, blockedId) {
  run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', [blockerId, blockedId]);
  removeFriend(blockerId, blockedId);
}

export function unblockUser(blockerId, blockedId) {
  run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]);
}

export function blockedUsers(blockerId) {
  return all(
    `SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
    [blockerId],
  );
}

export function mutualFriendIds(a, b) {
  const aFriends = new Set(friendIds(a));
  return friendIds(b).filter((id) => aFriends.has(id));
}
