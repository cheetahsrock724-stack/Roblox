/**
 * Persistent per-player game data.
 *
 * Isolation is enforced structurally: every row is keyed by (game_id, user_id, store_name) and
 * every API in this module requires a game id. A game can never read another game's rows because
 * the WHERE clause always includes the caller's game id.
 */
import { all, get, run, transaction } from '../db.js';
import { ENGINE_LIMITS, ValidationError } from '@kinetiq/shared';

const MAX_BYTES = ENGINE_LIMITS.maxDataStoreValueBytes;
const MAX_STORES_PER_GAME = 200;

export function readStore(gameId, userId, storeName = 'default') {
  const row = get(
    'SELECT * FROM player_game_data WHERE game_id = ? AND user_id = ? AND store_name = ?',
    [gameId, userId, storeName],
  );
  if (!row) return { values: {}, version: 0, updatedAt: null };
  return { values: safeParse(row.payload), version: row.version, updatedAt: row.updated_at };
}

export function writeStore(gameId, userId, storeName = 'default', values = {}) {
  const payload = JSON.stringify(values ?? {});
  if (Buffer.byteLength(payload) > MAX_BYTES) {
    throw new ValidationError(`Saved data exceeds the ${Math.floor(MAX_BYTES / 1024)}KB limit per key.`);
  }
  const existing = get(
    'SELECT version FROM player_game_data WHERE game_id = ? AND user_id = ? AND store_name = ?',
    [gameId, userId, storeName],
  );
  if (existing) {
    run(
      `UPDATE player_game_data SET payload = ?, version = version + 1, updated_at = datetime('now')
       WHERE game_id = ? AND user_id = ? AND store_name = ?`,
      [payload, gameId, userId, storeName],
    );
  } else {
    const storeCount =
      get('SELECT COUNT(DISTINCT store_name) AS n FROM player_game_data WHERE game_id = ?', [gameId])?.n ?? 0;
    if (storeCount >= MAX_STORES_PER_GAME) throw new ValidationError('Too many data stores for this game.');
    run(
      `INSERT INTO player_game_data (game_id, user_id, store_name, payload) VALUES (?, ?, ?, ?)`,
      [gameId, userId, storeName, payload],
    );
  }
  return readStore(gameId, userId, storeName);
}

export function patchStore(gameId, userId, storeName, patch) {
  return transaction(() => {
    const current = readStore(gameId, userId, storeName);
    return writeStore(gameId, userId, storeName, { ...current.values, ...patch });
  });
}

export function deleteStore(gameId, userId, storeName = 'default') {
  return (
    run('DELETE FROM player_game_data WHERE game_id = ? AND user_id = ? AND store_name = ?', [
      gameId,
      userId,
      storeName,
    ]).changes > 0
  );
}

export function storeNames(gameId, userId) {
  return all('SELECT store_name FROM player_game_data WHERE game_id = ? AND user_id = ?', [gameId, userId]).map(
    (row) => row.store_name,
  );
}

/** Leaderboards: ordered query across all players of a single game. */
export function leaderboard(gameId, { storeName = 'default', field = null, limit = 25, ascending = false } = {}) {
  const rows = all(
    `SELECT user_id, payload, updated_at FROM player_game_data WHERE game_id = ? AND store_name = ? LIMIT 5000`,
    [gameId, storeName],
  );
  const mapped = rows.map((row) => {
    const values = safeParse(row.payload);
    return {
      userId: row.user_id,
      value: field ? Number(values[field] ?? 0) : values,
      updatedAt: row.updated_at,
    };
  });
  if (field) {
    mapped.sort((a, b) => (ascending ? a.value - b.value : b.value - a.value));
  }
  return mapped.slice(0, limit);
}

export function bulkReadStores(gameId, userIds, storeName = 'default') {
  if (!userIds.length) return new Map();
  const placeholders = userIds.map(() => '?').join(',');
  const rows = all(
    `SELECT user_id, payload, version, updated_at FROM player_game_data
     WHERE game_id = ? AND store_name = ? AND user_id IN (${placeholders})`,
    [gameId, storeName, ...userIds],
  );
  const map = new Map();
  for (const row of rows) map.set(row.user_id, { values: safeParse(row.payload), version: row.version, updatedAt: row.updated_at });
  return map;
}

function safeParse(value) {
  try {
    return JSON.parse(value) ?? {};
  } catch {
    return {};
  }
}
