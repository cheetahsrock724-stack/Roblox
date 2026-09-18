/** Assets, avatar catalogue items and inventory. */
import { all, get, run, transaction } from '../db.js';
import { ids } from '@kinetiq/shared';

export function createAsset({
  ownerUserId = null,
  ownerGroupId = null,
  name,
  description = '',
  assetType,
  mimeType = 'application/octet-stream',
  storageKey,
  sizeBytes = 0,
  hash,
  metadata = {},
  moderationStatus = 'approved',
  isPublic = true,
  isForSale = false,
  price = 0,
}) {
  const id = ids.asset();
  run(
    `INSERT INTO assets (id, owner_user_id, owner_group_id, name, description, asset_type, mime_type, storage_key,
      size_bytes, hash, metadata, moderation_status, is_public, is_for_sale, price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ownerUserId,
      ownerGroupId,
      String(name).slice(0, 120),
      String(description).slice(0, 1000),
      assetType,
      mimeType,
      storageKey,
      sizeBytes,
      hash,
      JSON.stringify(metadata ?? {}),
      moderationStatus,
      isPublic ? 1 : 0,
      isForSale ? 1 : 0,
      Math.max(0, Math.trunc(price)),
    ],
  );
  return getAsset(id);
}

export function getAsset(id) {
  return get('SELECT * FROM assets WHERE id = ?', [id]);
}

export function getAssetByHash(hash) {
  return get('SELECT * FROM assets WHERE hash = ?', [hash]);
}

export function listAssets({
  ownerUserId = null,
  ownerGroupId = null,
  assetType = null,
  moderationStatus = null,
  publicOnly = false,
  query = null,
  limit = 40,
  offset = 0,
} = {}) {
  const conditions = [];
  const params = [];
  if (ownerUserId) {
    conditions.push('owner_user_id = ?');
    params.push(ownerUserId);
  }
  if (ownerGroupId) {
    conditions.push('owner_group_id = ?');
    params.push(ownerGroupId);
  }
  if (assetType) {
    conditions.push('asset_type = ?');
    params.push(assetType);
  }
  if (moderationStatus) {
    conditions.push('moderation_status = ?');
    params.push(moderationStatus);
  }
  if (publicOnly) conditions.push(`is_public = 1 AND moderation_status = 'approved'`);
  if (query) {
    conditions.push('name LIKE ?');
    params.push(`%${query}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = all(
    `SELECT a.*, u.username AS owner_username FROM assets a LEFT JOIN users u ON u.id = a.owner_user_id
     ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = get(`SELECT COUNT(*) AS n FROM assets a ${where}`, params)?.n ?? 0;
  return { rows, total };
}

export function updateAsset(assetId, patch) {
  const fields = [];
  const params = [];
  const map = {
    name: 'name',
    description: 'description',
    moderationStatus: 'moderation_status',
    moderationNote: 'moderation_note',
    isPublic: 'is_public',
    isForSale: 'is_for_sale',
    price: 'price',
    metadata: 'metadata',
  };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    fields.push(`${column} = ?`);
    const value = patch[key];
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'object' ? JSON.stringify(value) : value);
  }
  if (!fields.length) return getAsset(assetId);
  fields.push(`updated_at = datetime('now')`);
  params.push(assetId);
  run(`UPDATE assets SET ${fields.join(', ')} WHERE id = ?`, params);
  return getAsset(assetId);
}

export function incrementAssetDownloads(assetId) {
  run('UPDATE assets SET downloads = downloads + 1 WHERE id = ?', [assetId]);
}

export function deleteAsset(assetId) {
  run('DELETE FROM assets WHERE id = ?', [assetId]);
}

export function linkGameAsset(gameId, assetId, usage = 'generic') {
  run('INSERT OR IGNORE INTO game_assets (game_id, asset_id, usage) VALUES (?, ?, ?)', [gameId, assetId, usage]);
}

export function gameAssets(gameId) {
  return all(
    'SELECT a.*, ga.usage FROM game_assets ga JOIN assets a ON a.id = ga.asset_id WHERE ga.game_id = ?',
    [gameId],
  );
}

export function publicAssetCount({ assetType = null } = {}) {
  const where = assetType ? `WHERE asset_type = ? AND is_public = 1` : 'WHERE is_public = 1';
  const params = assetType ? [assetType] : [];
  return get(`SELECT COUNT(*) AS n FROM assets ${where}`, params)?.n ?? 0;
}

/** -------------------------------------------------------------- avatar items */
export function createAvatarItem({
  creatorUserId = null,
  creatorGroupId = null,
  name,
  description = '',
  category,
  assetId = null,
  thumbnailAssetId = null,
  attachment = {},
  colors = [],
  price = 0,
  isForSale = true,
  isLimited = false,
  stock = null,
  moderationStatus = 'approved',
}) {
  const id = ids.item();
  run(
    `INSERT INTO avatar_items (id, creator_user_id, creator_group_id, name, description, category, asset_id,
      thumbnail_asset_id, attachment, colors, price, is_for_sale, is_limited, stock, moderation_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      creatorUserId,
      creatorGroupId,
      String(name).slice(0, 100),
      String(description).slice(0, 1000),
      category,
      assetId,
      thumbnailAssetId,
      JSON.stringify(attachment ?? {}),
      JSON.stringify(colors ?? []),
      Math.max(0, Math.trunc(price)),
      isForSale ? 1 : 0,
      isLimited ? 1 : 0,
      stock,
      moderationStatus,
    ],
  );
  return getAvatarItem(id);
}

export function getAvatarItem(id) {
  return get(
    `SELECT i.*, u.username AS creator_username, u.display_name AS creator_display_name
     FROM avatar_items i LEFT JOIN users u ON u.id = i.creator_user_id WHERE i.id = ?`,
    [id],
  );
}

export function listAvatarItems({ category = null, creatorUserId = null, query = null, forSale = null, limit = 40, offset = 0 } = {}) {
  const conditions = [`i.moderation_status = 'approved'`];
  const params = [];
  if (category) {
    conditions.push('i.category = ?');
    params.push(category);
  }
  if (creatorUserId) {
    conditions.push('i.creator_user_id = ?');
    params.push(creatorUserId);
  }
  if (forSale !== null) {
    conditions.push('i.is_for_sale = ?');
    params.push(forSale ? 1 : 0);
  }
  if (query) {
    conditions.push('i.name LIKE ?');
    params.push(`%${query}%`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const rows = all(
    `SELECT i.*, u.username AS creator_username FROM avatar_items i LEFT JOIN users u ON u.id = i.creator_user_id
     ${where} ORDER BY i.sales DESC, i.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = get(`SELECT COUNT(*) AS n FROM avatar_items i ${where}`, params)?.n ?? 0;
  return { rows, total };
}

export function updateAvatarItem(itemId, patch) {
  const fields = [];
  const params = [];
  const map = {
    name: 'name',
    description: 'description',
    price: 'price',
    isForSale: 'is_for_sale',
    moderationStatus: 'moderation_status',
    thumbnailAssetId: 'thumbnail_asset_id',
    attachment: 'attachment',
    colors: 'colors',
  };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    fields.push(`${column} = ?`);
    const value = patch[key];
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'object' ? JSON.stringify(value) : value);
  }
  if (!fields.length) return getAvatarItem(itemId);
  fields.push(`updated_at = datetime('now')`);
  params.push(itemId);
  run(`UPDATE avatar_items SET ${fields.join(', ')} WHERE id = ?`, params);
  return getAvatarItem(itemId);
}

export function recordItemSale(itemId) {
  run('UPDATE avatar_items SET sales = sales + 1 WHERE id = ?', [itemId]);
}

/** ------------------------------------------------------------------ inventory */
export function addToInventory(userId, kind, refId, { quantity = 1, acquiredVia = 'grant', metadata = {} } = {}) {
  const id = `inv_${ids.item().slice(4, 20)}`;
  run(
    `INSERT INTO inventory (id, user_id, kind, ref_id, quantity, acquired_via, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind, ref_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
    [id, userId, kind, refId, quantity, acquiredVia, JSON.stringify(metadata ?? {})],
  );
  return get('SELECT * FROM inventory WHERE user_id = ? AND kind = ? AND ref_id = ?', [userId, kind, refId]);
}

export function removeFromInventory(userId, kind, refId) {
  return run('DELETE FROM inventory WHERE user_id = ? AND kind = ? AND ref_id = ?', [userId, kind, refId]).changes > 0;
}

export function ownsItem(userId, kind, refId) {
  return Boolean(get('SELECT 1 AS x FROM inventory WHERE user_id = ? AND kind = ? AND ref_id = ?', [userId, kind, refId]));
}

export function listInventory(userId, { kind = null, limit = 200, offset = 0 } = {}) {
  const where = kind ? 'AND i.kind = ?' : '';
  const params = kind ? [userId, kind, limit, offset] : [userId, limit, offset];
  return all(
    `SELECT i.*, 
       (SELECT name FROM avatar_items ai WHERE ai.id = i.ref_id) AS item_name,
       (SELECT category FROM avatar_items ai WHERE ai.id = i.ref_id) AS item_category,
       (SELECT thumbnail_asset_id FROM avatar_items ai WHERE ai.id = i.ref_id) AS item_thumbnail,
       (SELECT name FROM badges b WHERE b.id = i.ref_id) AS badge_name,
       (SELECT description FROM badges b WHERE b.id = i.ref_id) AS badge_description,
       (SELECT name FROM assets a WHERE a.id = i.ref_id) AS asset_name,
       (SELECT asset_type FROM assets a WHERE a.id = i.ref_id) AS asset_type
     FROM inventory i WHERE i.user_id = ? ${where}
     ORDER BY i.acquired_at DESC LIMIT ? OFFSET ?`,
    params,
  );
}

export function inventoryCounts(userId) {
  return all('SELECT kind, COUNT(*) AS count FROM inventory WHERE user_id = ? GROUP BY kind', [userId]);
}
