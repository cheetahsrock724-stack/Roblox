/** Game server (realm) registry: lifecycle, capacity, heartbeats and join history. */
import { all, get, run, transaction } from '../db.js';
import { ids } from '@kinetiq/shared';

export function registerServer({
  gameId,
  versionId,
  region = 'local',
  host = '127.0.0.1',
  port = 0,
  maxPlayers = 12,
  privateServerId = null,
  joinPath = null,
  metadata = {},
}) {
  const id = ids.realm();
  run(
    `INSERT INTO game_servers (id, game_id, version_id, region, host, port, max_players, private_server_id, join_path, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?)`,
    [id, gameId, versionId, region, host, port, maxPlayers, privateServerId, joinPath, JSON.stringify(metadata ?? {})],
  );
  return getServer(id);
}

export function getServer(id) {
  return get('SELECT * FROM game_servers WHERE id = ?', [id]);
}

export function updateServer(id, patch) {
  const fields = [];
  const params = [];
  const map = {
    status: 'status',
    currentPlayers: 'current_players',
    maxPlayers: 'max_players',
    port: 'port',
    host: 'host',
    pid: 'pid',
    error: 'error',
    joinPath: 'join_path',
    metadata: 'metadata',
  };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    fields.push(`${column} = ?`);
    params.push(typeof patch[key] === 'object' ? JSON.stringify(patch[key]) : patch[key]);
  }
  if (!fields.length) return getServer(id);
  params.push(id);
  run(`UPDATE game_servers SET ${fields.join(', ')} WHERE id = ?`, params);
  return getServer(id);
}

export function heartbeat(serverId, { currentPlayers, status = 'running' } = {}) {
  run(
    `UPDATE game_servers SET last_heartbeat_at = datetime('now'), status = ?,
      current_players = COALESCE(?, current_players) WHERE id = ?`,
    [status, currentPlayers ?? null, serverId],
  );
}

export function stopServer(serverId, { error = null } = {}) {
  run(
    `UPDATE game_servers SET status = 'stopped', current_players = 0, ended_at = datetime('now'), error = ?
     WHERE id = ?`,
    [error, serverId],
  );
}

export function runningServersFor(gameId, { region = null } = {}) {
  const conditions = [`game_id = ?`, `status IN ('running','starting')`, `ended_at IS NULL`];
  const params = [gameId];
  if (region) {
    conditions.push('region = ?');
    params.push(region);
  }
  return all(`SELECT * FROM game_servers WHERE ${conditions.join(' AND ')} ORDER BY current_players ASC`, params);
}

/** Matchmaking core: pick the fullest server that still has room. */
export function findJoinableServer(gameId, { excludePrivate = true } = {}) {
  return get(
    `SELECT * FROM game_servers
     WHERE game_id = ? AND status = 'running' AND ended_at IS NULL
       ${excludePrivate ? 'AND private_server_id IS NULL' : ''}
       AND current_players < max_players
     ORDER BY current_players DESC, started_at ASC LIMIT 1`,
    [gameId],
  );
}

export function findPrivateServer(joinCode) {
  return get('SELECT * FROM private_servers WHERE join_code = ? AND active = 1', [joinCode]);
}

export function recordJoin(serverId, userId, sessionTokenHash = null) {
  const id = `jn_${ids.realm().slice(4, 20)}`;
  run('INSERT INTO server_joins (id, server_id, user_id, session_token_hash) VALUES (?, ?, ?, ?)', [
    id,
    serverId,
    userId,
    sessionTokenHash,
  ]);
  return id;
}

export function recordLeave(serverId, userId, durationSeconds = 0) {
  run(
    `UPDATE server_joins SET left_at = datetime('now'), duration_seconds = ?
     WHERE id = (SELECT id FROM server_joins WHERE server_id = ? AND user_id = ? AND left_at IS NULL
                 ORDER BY joined_at DESC LIMIT 1)`,
    [Math.max(0, Math.floor(durationSeconds)), serverId, userId],
  );
}

export function activePlayersOnServer(serverId) {
  return get('SELECT COUNT(*) AS n FROM server_joins WHERE server_id = ? AND left_at IS NULL', [serverId])?.n ?? 0;
}

export function staleServers(secondsWithoutHeartbeat = 45) {
  return all(
    `SELECT * FROM game_servers WHERE ended_at IS NULL AND status != 'stopped'
       AND (last_heartbeat_at IS NULL OR last_heartbeat_at < datetime('now', ?))`,
    [`-${Math.floor(secondsWithoutHeartbeat)} seconds`],
  );
}

export function serverCounts() {
  return {
    running: get(`SELECT COUNT(*) AS n FROM game_servers WHERE status = 'running'`)?.n ?? 0,
    starting: get(`SELECT COUNT(*) AS n FROM game_servers WHERE status = 'starting'`)?.n ?? 0,
    players: get(`SELECT COALESCE(SUM(current_players), 0) AS n FROM game_servers WHERE status = 'running'`)?.n ?? 0,
    total: get('SELECT COUNT(*) AS n FROM game_servers')?.n ?? 0,
  };
}

/** Private servers */
export function createPrivateServer({ gameId, ownerUserId, name = 'Private server', maxPlayers = 12, pricePaid = 0, joinCode }) {
  const id = ids.privateServer();
  run(
    `INSERT INTO private_servers (id, game_id, owner_user_id, name, join_code, max_players, price_paid)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, gameId, ownerUserId, String(name).slice(0, 60), joinCode, maxPlayers, pricePaid],
  );
  run('INSERT OR IGNORE INTO private_server_members (private_server_id, user_id) VALUES (?, ?)', [id, ownerUserId]);
  return getPrivateServer(id);
}

export function getPrivateServer(id) {
  return get('SELECT * FROM private_servers WHERE id = ?', [id]);
}

export function listPrivateServers(gameId, { ownerUserId = null, limit = 25 } = {}) {
  const where = ownerUserId ? 'AND owner_user_id = ?' : '';
  const params = ownerUserId ? [gameId, ownerUserId, limit] : [gameId, limit];
  return all(
    `SELECT p.*, (SELECT COUNT(*) FROM private_server_members m WHERE m.private_server_id = p.id) AS member_count
     FROM private_servers p WHERE p.game_id = ? AND p.active = 1 ${where} ORDER BY p.created_at DESC LIMIT ?`,
    params,
  );
}

export function privateServerMember(privateServerId, userId) {
  return get('SELECT * FROM private_server_members WHERE private_server_id = ? AND user_id = ?', [
    privateServerId,
    userId,
  ]);
}

export function addPrivateServerMember(privateServerId, userId) {
  run('INSERT OR IGNORE INTO private_server_members (private_server_id, user_id) VALUES (?, ?)', [
    privateServerId,
    userId,
  ]);
}

export function removePrivateServerMember(privateServerId, userId) {
  return (
    run('DELETE FROM private_server_members WHERE private_server_id = ? AND user_id = ?', [privateServerId, userId])
      .changes > 0
  );
}

export function deactivatePrivateServer(privateServerId) {
  run('UPDATE private_servers SET active = 0 WHERE id = ?', [privateServerId]);
}

export function setGameActivePlayers(gameId, activePlayers) {
  run('UPDATE games SET active_players = ?, peak_players = MAX(peak_players, ?) WHERE id = ?', [
    Math.max(0, Math.floor(activePlayers)),
    Math.max(0, Math.floor(activePlayers)),
    gameId,
  ]);
}
