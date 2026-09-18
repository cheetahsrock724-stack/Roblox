/** Games, published versions, scripts, likes/favourites, servers and discovery queries. */
import { all, get, run, transaction } from '../db.js';
import { ids, hashString, sha256, stableStringify } from '@kinetiq/shared';

export function toGameSummary(row, extras = {}) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    genre: row.genre,
    tags: safeParse(row.tags, []),
    iconAssetId: row.icon_asset_id,
    thumbnailAssetId: row.thumbnail_asset_id,
    ownerUserId: row.owner_user_id,
    ownerGroupId: row.owner_group_id,
    ownerName: row.owner_name ?? null,
    maxPlayers: row.max_players,
    isPublic: Boolean(row.is_public),
    isPublished: Boolean(row.is_published),
    isFeatured: Boolean(row.is_featured),
    playCount: row.play_count,
    visitCount: row.visit_count,
    likeCount: row.like_count,
    dislikeCount: row.dislike_count,
    favoriteCount: row.favorite_count,
    activePlayers: row.active_players,
    peakPlayers: row.peak_players,
    currentVersionId: row.current_version_id,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    moderationStatus: row.moderation_status,
    allowPrivateServers: Boolean(row.allow_private_servers),
    privateServerPrice: row.private_server_price ?? 0,
    ...extras,
  };
}

export function toGameDetail(row, extras = {}) {
  const base = toGameSummary(row, extras);
  if (!base) return null;
  return {
    ...base,
    screenshots: safeParse(row.screenshots, []),
    settings: safeParse(row.settings, {}),
    allowCopying: Boolean(row.allow_copying),
  };
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'game';
}

export function ensureUniqueSlug(base) {
  let candidate = base;
  let suffix = 2;
  while (get('SELECT id FROM games WHERE slug = ?', [candidate])) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function createGame({
  ownerUserId = null,
  ownerGroupId = null,
  name,
  description = '',
  genre = 'Sandbox',
  tags = [],
  maxPlayers = 12,
  isPublic = false,
  settings = {},
}) {
  const id = ids.game();
  const slug = ensureUniqueSlug(slugify(name));
  run(
    `INSERT INTO games (id, owner_user_id, owner_group_id, slug, name, description, genre, tags, max_players, is_public, settings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ownerUserId,
      ownerGroupId,
      slug,
      String(name).slice(0, 80),
      String(description).slice(0, 4000),
      genre,
      JSON.stringify(tags),
      maxPlayers,
      isPublic ? 1 : 0,
      JSON.stringify(settings),
    ],
  );
  if (ownerUserId) run('UPDATE users SET is_developer = 1 WHERE id = ?', [ownerUserId]);
  return findById(id);
}

export function findById(id) {
  return get(
    `SELECT g.*, COALESCE(u.username, gr.name) AS owner_name
     FROM games g
     LEFT JOIN users u ON u.id = g.owner_user_id
     LEFT JOIN groups gr ON gr.id = g.owner_group_id
     WHERE g.id = ?`,
    [id],
  );
}

export function findBySlug(slug) {
  return get(
    `SELECT g.*, COALESCE(u.username, gr.name) AS owner_name
     FROM games g
     LEFT JOIN users u ON u.id = g.owner_user_id
     LEFT JOIN groups gr ON gr.id = g.owner_group_id
     WHERE g.slug = ?`,
    [slug],
  );
}

export function resolveGame(idOrSlug) {
  return findBySlug(idOrSlug) ?? findById(idOrSlug);
}

export function updateGame(gameId, patch) {
  const map = {
    name: 'name',
    description: 'description',
    genre: 'genre',
    maxPlayers: 'max_players',
    isPublic: 'is_public',
    isPublished: 'is_published',
    isFeatured: 'is_featured',
    iconAssetId: 'icon_asset_id',
    thumbnailAssetId: 'thumbnail_asset_id',
    allowPrivateServers: 'allow_private_servers',
    privateServerPrice: 'private_server_price',
    allowCopying: 'allow_copying',
    moderationStatus: 'moderation_status',
    slug: 'slug',
  };
  const fields = [];
  const params = [];
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    fields.push(`${column} = ?`);
    const value = patch[key];
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  if (patch.tags !== undefined) {
    fields.push('tags = ?');
    params.push(JSON.stringify(patch.tags));
  }
  if (patch.screenshots !== undefined) {
    fields.push('screenshots = ?');
    params.push(JSON.stringify(patch.screenshots));
  }
  if (patch.settings !== undefined) {
    fields.push('settings = ?');
    params.push(JSON.stringify(patch.settings));
  }
  if (!fields.length) return findById(gameId);
  fields.push(`updated_at = datetime('now')`);
  params.push(gameId);
  run(`UPDATE games SET ${fields.join(', ')} WHERE id = ?`, params);
  return findById(gameId);
}

export function deleteGame(gameId) {
  run('DELETE FROM games WHERE id = ?', [gameId]);
}

/** ------------------------------------------------------------------ versions */
export function createVersion({
  gameId,
  manifest,
  changelog = '',
  label = null,
  createdBy = null,
  published = false,
}) {
  const manifestJson = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  const contentHash = sha256(manifestJson);
  const parsed = typeof manifest === 'string' ? JSON.parse(manifest) : manifest;
  const scriptCount = Array.isArray(parsed.scripts) ? parsed.scripts.length : 0;
  const partCount = Number(parsed.stats?.parts ?? parsed.stats?.partCount ?? 0);
  return transaction(() => {
    const next = (get('SELECT MAX(version_number) AS n FROM game_versions WHERE game_id = ?', [gameId])?.n ?? 0) + 1;
    const id = ids.version();
    run(
      `INSERT INTO game_versions (id, game_id, version_number, label, changelog, manifest, content_hash,
        size_bytes, script_count, part_count, published, published_by, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        gameId,
        next,
        label,
        String(changelog).slice(0, 4000),
        manifestJson,
        contentHash,
        Buffer.byteLength(manifestJson),
        scriptCount,
        partCount,
        published ? 1 : 0,
        published ? createdBy : null,
        createdBy,
      ],
    );
    if (published) {
      run(
        `UPDATE games SET current_version_id = ?, is_published = 1, published_at = COALESCE(published_at, datetime('now')),
          updated_at = datetime('now') WHERE id = ?`,
        [id, gameId],
      );
    } else {
      run(`UPDATE games SET updated_at = datetime('now') WHERE id = ?`, [gameId]);
    }
    return getVersion(id);
  });
}

export function getVersion(versionId) {
  return get('SELECT * FROM game_versions WHERE id = ?', [versionId]);
}

export function listVersions(gameId, { limit = 30 } = {}) {
  return all('SELECT * FROM game_versions WHERE game_id = ? ORDER BY version_number DESC LIMIT ?', [gameId, limit]);
}

export function currentVersion(gameId) {
  const game = get('SELECT current_version_id FROM games WHERE id = ?', [gameId]);
  if (!game?.current_version_id) return null;
  return getVersion(game.current_version_id);
}

export function publishVersion(gameId, versionId, { userId = null, changelog = null } = {}) {
  return transaction(() => {
    const version = getVersion(versionId);
    if (!version || version.game_id !== gameId) return null;
    if (changelog) run('UPDATE game_versions SET changelog = ? WHERE id = ?', [changelog, versionId]);
    run('UPDATE game_versions SET published = 1, published_by = ? WHERE id = ?', [userId, versionId]);
    run(
      `UPDATE games SET current_version_id = ?, is_published = 1, moderation_status = 'approved',
        published_at = COALESCE(published_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`,
      [versionId, gameId],
    );
    return getVersion(versionId);
  });
}

export function rollbackToVersion(gameId, versionId) {
  return publishVersion(gameId, versionId, { changelog: 'Rollback' });
}

export function replaceScripts(versionId, gameId, scripts = []) {
  transaction(() => {
    run('DELETE FROM game_scripts WHERE version_id = ?', [versionId]);
    for (const script of scripts) {
      run(
        `INSERT INTO game_scripts (id, version_id, game_id, name, kind, source, run_on_load)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          script.id ?? `scr_${hashString(`${versionId}:${script.name}`).toString(36)}`,
          versionId,
          gameId,
          script.name,
          script.kind ?? 'server',
          script.source ?? '',
          script.runOnLoad === false ? 0 : 1,
        ],
      );
    }
  });
}

export function listScripts(versionId) {
  return all('SELECT * FROM game_scripts WHERE version_id = ? ORDER BY kind, name', [versionId]).map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    source: row.source,
    runOnLoad: Boolean(row.run_on_load),
  }));
}

/** ------------------------------------------------------------------ engagement */
export function setLike(gameId, userId, value) {
  return transaction(() => {
    if (value === 0) {
      run('DELETE FROM game_likes WHERE game_id = ? AND user_id = ?', [gameId, userId]);
    } else {
      run(
        `INSERT INTO game_likes (game_id, user_id, value) VALUES (?, ?, ?)
         ON CONFLICT (game_id, user_id) DO UPDATE SET value = excluded.value`,
        [gameId, userId, value],
      );
    }
    recalculateLikes(gameId);
    return get('SELECT value FROM game_likes WHERE game_id = ? AND user_id = ?', [gameId, userId])?.value ?? 0;
  });
}

export function recalculateLikes(gameId) {
  const likes = get('SELECT COUNT(*) AS n FROM game_likes WHERE game_id = ? AND value = 1', [gameId])?.n ?? 0;
  const dislikes = get('SELECT COUNT(*) AS n FROM game_likes WHERE game_id = ? AND value = -1', [gameId])?.n ?? 0;
  run('UPDATE games SET like_count = ?, dislike_count = ? WHERE id = ?', [likes, dislikes, gameId]);
  return { likes, dislikes };
}

export function setFavorite(gameId, userId, favorite = true) {
  return transaction(() => {
    if (favorite) {
      run('INSERT OR IGNORE INTO game_favorites (game_id, user_id) VALUES (?, ?)', [gameId, userId]);
    } else {
      run('DELETE FROM game_favorites WHERE game_id = ? AND user_id = ?', [gameId, userId]);
    }
    const count = get('SELECT COUNT(*) AS n FROM game_favorites WHERE game_id = ?', [gameId])?.n ?? 0;
    run('UPDATE games SET favorite_count = ? WHERE id = ?', [count, gameId]);
    return favorite;
  });
}

export function getEngagement(gameId, userId) {
  if (!userId) return { liked: 0, favorited: false };
  return {
    liked: get('SELECT value FROM game_likes WHERE game_id = ? AND user_id = ?', [gameId, userId])?.value ?? 0,
    favorited: Boolean(get('SELECT 1 AS x FROM game_favorites WHERE game_id = ? AND user_id = ?', [gameId, userId])),
  };
}

export function favoriteGames(userId, { limit = 24, offset = 0 } = {}) {
  return all(
    `SELECT g.*, f.created_at AS favorited_at FROM game_favorites f
     JOIN games g ON g.id = f.game_id
     WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset],
  );
}

export function recordPlay(gameId, userId, { seconds = 0 } = {}) {
  transaction(() => {
    run('UPDATE games SET play_count = play_count + 1, visit_count = visit_count + 1 WHERE id = ?', [gameId]);
    if (userId) {
      run(
        `INSERT INTO player_stats (user_id, game_id, visits, playtime_seconds, last_played_at)
         VALUES (?, ?, 1, ?, datetime('now'))
         ON CONFLICT (user_id, game_id) DO UPDATE SET
           visits = visits + 1,
           playtime_seconds = playtime_seconds + excluded.playtime_seconds,
           last_played_at = datetime('now')`,
        [userId, gameId, Math.max(0, Math.floor(seconds))],
      );
      run('INSERT INTO game_stats_daily (game_id, day, plays) VALUES (?, date(\'now\'), 1)\n           ON CONFLICT (game_id, day) DO UPDATE SET plays = plays + 1', [gameId]);
    }
  });
}

export function recentlyPlayed(userId, { limit = 12 } = {}) {
  return all(
    `SELECT g.*, ps.last_played_at, ps.playtime_seconds, ps.visits FROM player_stats ps
     JOIN games g ON g.id = ps.game_id
     WHERE ps.user_id = ? AND g.is_published = 1
     ORDER BY ps.last_played_at DESC LIMIT ?`,
    [userId, limit],
  );
}

export function setActivePlayers(gameId, activePlayers) {
  const value = Math.max(0, Math.floor(activePlayers));
  run(
    `UPDATE games SET active_players = ?, peak_players = MAX(peak_players, ?) WHERE id = ?`,
    [value, value, gameId],
  );
}

/** ------------------------------------------------------------------ discovery */
const SORTS = {
  popular: 'g.play_count DESC, g.active_players DESC',
  most_played: 'g.active_players DESC, g.play_count DESC',
  trending: `(g.active_players * 3 + g.favorite_count * 2 + g.like_count) DESC, g.updated_at DESC`,
  new: 'g.published_at DESC, g.created_at DESC',
  updated: 'g.updated_at DESC',
  recommended: `(CASE WHEN g.active_players > 0 THEN 1000 ELSE 0 END + g.like_count * 2 + g.favorite_count * 3
                 + (g.play_count / 50.0)) DESC`,
};

export function discover({
  sort = 'popular',
  genre = null,
  search = null,
  ownerUserId = null,
  ownerGroupId = null,
  publishedOnly = true,
  includeUnlisted = false,
  multiplayerOnly = false,
  limit = 24,
  offset = 0,
} = {}) {
  const conditions = [];
  const params = [];
  if (publishedOnly) conditions.push('g.is_published = 1');
  if (!includeUnlisted) conditions.push('g.is_public = 1');
  if (genre) {
    conditions.push('g.genre = ?');
    params.push(genre);
  }
  if (ownerUserId) {
    conditions.push('g.owner_user_id = ?');
    params.push(ownerUserId);
  }
  if (ownerGroupId) {
    conditions.push('g.owner_group_id = ?');
    params.push(ownerGroupId);
  }
  if (multiplayerOnly) conditions.push('g.max_players > 1');
  if (search) {
    conditions.push('(g.name LIKE ? OR g.description LIKE ? OR g.tags LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  conditions.push(`g.moderation_status != 'removed'`);
  const where = `WHERE ${conditions.join(' AND ')}`;
  const order = SORTS[sort] ?? SORTS.popular;
  const rows = all(
    `SELECT g.*, COALESCE(u.username, gr.name) AS owner_name
     FROM games g
     LEFT JOIN users u ON u.id = g.owner_user_id
     LEFT JOIN groups gr ON gr.id = g.owner_group_id
     ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = get(`SELECT COUNT(*) AS n FROM games g ${where}`, params)?.n ?? 0;
  return { rows, total };
}

export function genreCounts({ publishedOnly = true } = {}) {
  const where = publishedOnly ? 'WHERE is_published = 1 AND is_public = 1' : '';
  return all(`SELECT genre, COUNT(*) AS count, SUM(active_players) AS players FROM games ${where} GROUP BY genre`);
}

export function recommendationsFor(game, { limit = 8 } = {}) {
  return all(
    `SELECT g.*, COALESCE(u.username, gr.name) AS owner_name FROM games g
     LEFT JOIN users u ON u.id = g.owner_user_id
     LEFT JOIN groups gr ON gr.id = g.owner_group_id
     WHERE g.id != ? AND g.is_published = 1 AND g.is_public = 1
       AND (g.genre = ? OR g.tags LIKE ?)
     ORDER BY (g.genre = ?) DESC, (g.active_players * 2 + g.like_count) DESC
     LIMIT ?`,
    [game.id, game.genre, `%${game.genre}%`, game.genre, limit],
  );
}

export function platformStats() {
  return {
    games: get('SELECT COUNT(*) AS n FROM games WHERE is_published = 1')?.n ?? 0,
    players: get('SELECT COUNT(*) AS n FROM users')?.n ?? 0,
    activePlayers: get('SELECT COALESCE(SUM(active_players), 0) AS n FROM games')?.n ?? 0,
    visits: get('SELECT COALESCE(SUM(visit_count), 0) AS n FROM games')?.n ?? 0,
    servers: get(`SELECT COUNT(*) AS n FROM game_servers WHERE status = 'running'`)?.n ?? 0,
    online: get(`SELECT COUNT(*) AS n FROM users WHERE presence != 'offline'`)?.n ?? 0,
  };
}

/** Hash of a manifest, used to detect "changed since publish". */
export function manifestHash(manifest) {
  return sha256(stableStringify(manifest));
}

export { SORTS as DISCOVER_SORTS_INTERNAL };
export { safeParse as parseJsonColumn };
