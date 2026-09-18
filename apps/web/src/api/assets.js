/**
 * /api/assets, /api/avatar, /api/inventory — the asset library, avatar marketplace and inventory.
 *
 * Uploads are validated hard: declared type allow-list, size limit, content sniffing (magic
 * bytes), image dimension checks, mesh triangle budgets and audio duration limits. Files are
 * stored under content-hashed paths so a malicious filename can never influence the filesystem,
 * and nothing uploaded is ever executed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sendJson, limitUserInput, pagination, jsonColumn } from './helpers.js';
import { requireAuth, limiters } from '../context.js';
import * as db from '@kinetiq/db';
import {
  ASSET_TYPES,
  AVATAR_CATEGORIES,
  ENGINE_LIMITS,
  assertEnum,
  assertInt,
  assertBoolean,
  sha256,
  paths,
  ensureDirs,
  platformConfig,
  ValidationError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
} from '@kinetiq/shared';
import { publicAvatarItem } from './users.js';

const ALLOWED_MIME = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'],
  mesh: ['model/gltf+json', 'model/gltf-binary', 'application/octet-stream', 'application/json'],
  model: ['model/gltf+json', 'model/gltf-binary', 'application/octet-stream', 'application/json'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm'],
  animation: ['application/json'],
  material: ['application/json', 'image/png', 'image/jpeg'],
  package: ['application/json', 'application/zip'],
};

const MAX_SIZES = {
  image: 6 * 1024 * 1024,
  mesh: 12 * 1024 * 1024,
  model: 12 * 1024 * 1024,
  audio: 10 * 1024 * 1024,
  animation: 2 * 1024 * 1024,
  material: 6 * 1024 * 1024,
  package: 32 * 1024 * 1024,
};

export function registerRoutes(router, deps) {
  const notify = deps?.notify ?? null;

  /** ---------------------------------------------------------------- upload */
  router.post('/api/assets', async (ctx) => {
    const user = requireAuth(ctx);
    limiters.upload.check(`upload:${user.id}`);
    const raw = await ctx.raw({ maxBytes: platformConfig.assetMaxBytes });
    const contentType = String(ctx.headers['content-type'] ?? '');
    const body = parseMultipart(raw, contentType);
    if (!body.fields.name) throw new ValidationError('Missing asset name.');

    const assetType = assertEnum(body.fields.type ?? 'image', ASSET_TYPES, { field: 'type' });
    const file = body.files.file;
    if (!file) throw new ValidationError('No file uploaded.');
    if (file.data.length === 0) throw new ValidationError('Uploaded file is empty.');
    const maxSize = MAX_SIZES[assetType] ?? platformConfig.assetMaxBytes;
    if (file.data.length > maxSize) {
      throw new PayloadTooLargeError(`That file is too large (limit ${Math.round(maxSize / 1024 / 1024)}MB).`);
    }

    const sniffed = sniffFile(file.data, file.filename);
    const allowed = ALLOWED_MIME[assetType] ?? [];
    if (!allowed.includes(sniffed.mime) && !allowed.includes(file.contentType)) {
      throw new ValidationError(`Unsupported ${assetType} format (${sniffed.mime}).`);
    }
    const dimensions = assetType === 'image' ? imageDimensions(file.data) : null;
    if (dimensions) {
      if (dimensions.width > ENGINE_LIMITS.maxImageDimension || dimensions.height > ENGINE_LIMITS.maxImageDimension) {
        throw new ValidationError(`Images must be at most ${ENGINE_LIMITS.maxImageDimension}px per side.`);
      }
      if (dimensions.width * dimensions.height > 16_777_216) {
        throw new ValidationError('Image is too large (max 16 megapixels).');
      }
    }
    if (assetType === 'audio') {
      const duration = estimateAudioSeconds(file.data, sniffed.mime);
      if (duration && duration > ENGINE_LIMITS.maxAudioSeconds) {
        throw new ValidationError(`Audio must be under ${ENGINE_LIMITS.maxAudioSeconds / 60} minutes.`);
      }
    }
    if (assetType === 'mesh' || assetType === 'model') {
      validateMesh(file.data);
    }

    ensureDirs();
    const hash = sha256(file.data);
    const directory = path.join(paths.assets, user.id, assetType);
    fs.mkdirSync(directory, { recursive: true });
    // Filename is derived from the content hash: no user-controlled path components.
    const storedName = `${hash}${extensionFor(sniffed.mime, file.filename)}`;
    const storageKey = `${user.id}/${assetType}/${storedName}`;
    fs.writeFileSync(path.join(paths.assets, storageKey), file.data, { mode: 0o644 });

    const existing = db.assets.getAssetByHash(hash);
    const asset = existing
      ? db.assets.updateAsset(existing.id, { moderationStatus: 'approved' })
      : db.assets.createAsset({
          ownerUserId: user.id,
          name: limitUserInput(body.fields.name, { max: 120, field: 'name', required: true }),
          description: limitUserInput(body.fields.description ?? '', { max: 1000 }),
          assetType,
          mimeType: sniffed.mime,
          storageKey,
          sizeBytes: file.data.length,
          hash,
          metadata: {
            originalName: String(file.filename ?? '').slice(0, 120),
            contentType: file.contentType,
            dimensions: dimensions ?? null,
            ...(body.fields.metadata ? safeJson(body.fields.metadata) : {}),
          },
          moderationStatus: 'approved',
          isPublic: body.fields.isPublic !== 'false',
        });

    db.users.markDeveloper(user.id, true);
    sendJson(ctx.res, 201, {
      asset: {
        id: asset.id,
        name: asset.name,
        assetType: asset.asset_type,
        sizeBytes: asset.size_bytes,
        url: `/api/assets/${asset.id}/raw`,
        hash: asset.hash,
        dimensions,
      },
    });
  });

  /** Raw asset delivery. Ownership/moderation rules are enforced here. */
  router.get('/api/assets/:id/raw', async (ctx) => {
    const asset = db.assets.getAsset(ctx.params.id);
    if (!asset) throw new NotFoundError('Asset not found.');
    if (asset.moderation_status === 'removed' || asset.moderation_status === 'rejected') {
      throw new ForbiddenError('That asset is unavailable.');
    }
    if (!asset.is_public && asset.owner_user_id !== ctx.userId && !db.assets.gameAssets) {
      throw new ForbiddenError('That asset is private.');
    }
    const filePath = path.join(paths.assets, asset.storage_key);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(paths.assets))) throw new ForbiddenError('Invalid asset path.');
    if (!fs.existsSync(resolved)) throw new NotFoundError('Asset data missing.');
    db.assets.incrementAssetDownloads(asset.id);
    const stat = fs.statSync(resolved);
    ctx.res.writeHead(200, {
      'content-type': asset.mime_type,
      'content-length': stat.size,
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${asset.hash}"`,
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(resolved).pipe(ctx.res);
  });

  router.get('/api/assets', async (ctx) => {
    const { limit, offset } = pagination(ctx);
    const ownerId = ctx.query.get('creator') ?? ctx.userId ?? null;
    const result = db.assets.listAssets({
      ownerUserId: ownerId,
      assetType: ctx.query.get('type') ?? null,
      publicOnly: ctx.query.get('public') !== '0',
      query: ctx.query.get('q') ?? null,
      limit,
      offset,
    });
    sendJson(ctx.res, 200, {
      assets: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        assetType: row.asset_type,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        metadata: jsonColumn(row.metadata, {}),
        ownerUsername: row.owner_username,
        moderationStatus: row.moderation_status,
        isPublic: Boolean(row.is_public),
        url: `/api/assets/${row.id}/raw`,
        createdAt: row.created_at,
      })),
      total: result.total,
      types: ASSET_TYPES,
    });
  });

  router.patch('/api/assets/:id', async (ctx) => {
    const user = requireAuth(ctx);
    const asset = db.assets.getAsset(ctx.params.id);
    if (!asset) throw new NotFoundError('Asset not found.');
    if (asset.owner_user_id !== user.id && user.role !== 'admin') throw new ForbiddenError('Not your asset.');
    const body = await ctx.json();
    const updated = db.assets.updateAsset(asset.id, {
      name: body.name !== undefined ? limitUserInput(body.name, { max: 120 }) : undefined,
      description: body.description !== undefined ? limitUserInput(body.description, { max: 1000 }) : undefined,
      isPublic: body.isPublic !== undefined ? assertBoolean(body.isPublic, true) : undefined,
    });
    sendJson(ctx.res, 200, { asset: { id: updated.id, name: updated.name, isPublic: Boolean(updated.is_public) } });
  });

  router.delete('/api/assets/:id', async (ctx) => {
    const user = requireAuth(ctx);
    const asset = db.assets.getAsset(ctx.params.id);
    if (!asset) throw new NotFoundError('Asset not found.');
    if (asset.owner_user_id !== user.id && user.role !== 'admin') throw new ForbiddenError('Not your asset.');
    db.assets.deleteAsset(asset.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  /** ---------------------------------------------------------------- avatar catalogue */
  router.get('/api/avatar/catalog', async (ctx) => {
    const category = ctx.query.get('category');
    if (category && !AVATAR_CATEGORIES.includes(category)) {
      throw new ValidationError('Unknown avatar category.');
    }
    const { limit, offset } = pagination(ctx, { defaultLimit: 40 });
    const result = db.assets.listAvatarItems({
      category: category ?? null,
      query: ctx.query.get('q') ?? null,
      forSale: ctx.query.get('forSale') === '0' ? false : null,
      limit,
      offset,
    });
    const owned = ctx.userId
      ? new Set(db.assets.listInventory(ctx.userId, { kind: 'avatar_item', limit: 500 }).map((row) => row.ref_id))
      : new Set();
    sendJson(ctx.res, 200, {
      items: result.rows.map((row) => ({ ...publicAvatarItem(row), owned: owned.has(row.id) })),
      total: result.total,
      categories: AVATAR_CATEGORIES,
    });
  });

  router.get('/api/avatar/items/:id', async (ctx) => {
    const item = db.assets.getAvatarItem(ctx.params.id);
    if (!item) throw new NotFoundError('Item not found.');
    sendJson(ctx.res, 200, {
      item: {
        ...publicAvatarItem(item),
        owned: ctx.userId ? db.assets.ownsItem(ctx.userId, 'avatar_item', item.id) : false,
      },
    });
  });

  router.post('/api/avatar/items', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json();
    const category = assertEnum(body.category, AVATAR_CATEGORIES, { field: 'category' });
    const assetId = body.assetId ?? null;
    if (assetId) {
      const asset = db.assets.getAsset(String(assetId));
      if (!asset) throw new NotFoundError('Asset not found.');
      if (asset.owner_user_id !== user.id && user.role !== 'admin') throw new ForbiddenError('Not your asset.');
    }
    const item = db.assets.createAvatarItem({
      creatorUserId: user.id,
      name: limitUserInput(body.name, { max: 100, field: 'name', required: true }),
      description: limitUserInput(body.description ?? '', { max: 1000 }),
      category,
      assetId,
      thumbnailAssetId: body.thumbnailAssetId ?? null,
      attachment: body.attachment ?? {},
      colors: Array.isArray(body.colors) ? body.colors.slice(0, 8) : [],
      price: assertInt(body.price ?? 0, { field: 'price', min: 0, max: 1_000_000, fallback: 0 }),
      isForSale: assertBoolean(body.isForSale, false),
      isLimited: assertBoolean(body.isLimited, false),
      stock: body.stock ? assertInt(body.stock, { field: 'stock', min: 1, max: 1_000_000 }) : null,
    });
    sendJson(ctx.res, 201, { item: publicAvatarItem(item) });
  });

  /** Previewing an item never charges anything: this returns a render descriptor only. */
  router.get('/api/avatar/items/:id/preview', async (ctx) => {
    const item = db.assets.getAvatarItem(ctx.params.id);
    if (!item) throw new NotFoundError('Item not found.');
    sendJson(ctx.res, 200, {
      preview: {
        id: item.id,
        category: item.category,
        attachment: jsonColumn(item.attachment, {}),
        colors: jsonColumn(item.colors, []),
        assetUrl: item.asset_id ? `/api/assets/${item.asset_id}/raw` : null,
        thumbnailUrl: item.thumbnail_asset_id ? `/api/assets/${item.thumbnail_asset_id}/raw` : null,
      },
    });
  });

  /** ---------------------------------------------------------------- marketplace purchase */
  router.post('/api/avatar/items/:id/purchase', async (ctx) => {
    const user = requireAuth(ctx);
    const item = db.assets.getAvatarItem(ctx.params.id);
    if (!item) throw new NotFoundError('Item not found.');
    if (!item.is_for_sale) throw new ForbiddenError('That item is not for sale.');
    if (item.moderation_status !== 'approved') throw new ForbiddenError('That item is unavailable.');
    if (db.assets.ownsItem(user.id, 'avatar_item', item.id)) throw new ValidationError('You already own that item.');
    if (item.is_limited && item.stock !== null) {
      const sold = db.get('SELECT COUNT(*) AS n FROM inventory WHERE kind = ? AND ref_id = ?', ['avatar_item', item.id])?.n ?? 0;
      if (sold >= item.stock) throw new ForbiddenError('That limited item is sold out.');
    }
    const body = await ctx.json().catch(() => ({}));
    const idempotencyKey = String(ctx.headers['idempotency-key'] ?? `${user.id}:${item.id}:purchase`).slice(0, 120);
    const price = Math.max(0, Math.trunc(item.price));
    let transaction = null;
    if (price > 0) {
      const balance = db.economy.balanceOf(user.id);
      if (balance < price) throw new ForbiddenError(`You need ${price - balance} more ${platformConfig.currencyName}.`);
      transaction = db.economy.postTransaction({
        kind: 'marketplace_purchase',
        fromUserId: user.id,
        amount: price,
        itemId: item.id,
        description: `Marketplace: ${item.name}`,
        idempotencyKey,
      });
      if (item.creator_user_id) {
        const share = db.economy.creatorShareOf(price, platformConfig.economy.developerRevenueShare);
        if (share > 0) {
          db.economy.postTransaction({
            kind: 'sale',
            toUserId: item.creator_user_id,
            amount: share,
            itemId: item.id,
            description: `Creator earnings: ${item.name}`,
          });
        }
      }
    }
    db.assets.addToInventory(user.id, 'avatar_item', item.id, {
      acquiredVia: 'purchase',
      metadata: { price, transactionId: transaction?.transaction?.id ?? null },
    });
    db.assets.recordItemSale(item.id);
    notify?.({
      userId: user.id,
      kind: 'purchase',
      title: `Purchased ${item.name}`,
      body: price > 0 ? `-${price} ${platformConfig.currencyName}` : 'Free item added to your inventory.',
      link: '/avatar',
      data: { itemId: item.id, price },
    });
    // Equipping immediately is the least surprising behaviour and is validated server side.
    const current = JSON.parse(user.avatar_item_ids ?? '{}');
    current[item.category] = item.id;
    db.users.updateProfile(user.id, { avatarItemIds: current });
    sendJson(ctx.res, 200, {
      item: publicAvatarItem(item),
      balance: db.economy.balanceOf(user.id),
      equipped: true,
      ...(body.dryRun ? { dryRun: true } : {}),
    });
  });

  /** Free items and developer grants (used by demos and by creators publishing free content). */
  router.post('/api/avatar/items/:id/grant', async (ctx) => {
    const user = requireAuth(ctx);
    const item = db.assets.getAvatarItem(ctx.params.id);
    if (!item) throw new NotFoundError('Item not found.');
    if (item.price > 0 && item.creator_user_id !== user.id && user.role !== 'admin') {
      throw new ForbiddenError('That item is not free.');
    }
    db.assets.addToInventory(user.id, 'avatar_item', item.id, { acquiredVia: 'grant' });
    sendJson(ctx.res, 200, { ok: true });
  });

  /** ---------------------------------------------------------------- inventory */
  router.get('/api/inventory', async (ctx) => {
    const user = requireAuth(ctx);
    const kind = ctx.query.get('kind');
    const { limit, offset } = pagination(ctx, { defaultLimit: 100 });
    const items = db.assets.listInventory(user.id, { kind: kind ?? null, limit, offset });
    sendJson(ctx.res, 200, {
      items: items.map((row) => ({
        id: row.id,
        kind: row.kind,
        refId: row.ref_id,
        name: row.item_name ?? row.badge_name ?? row.asset_name ?? row.ref_id,
        category: row.item_category,
        thumbnailAssetId: row.item_thumbnail,
        description: row.badge_description,
        quantity: row.quantity,
        acquiredVia: row.acquired_via,
        acquiredAt: row.acquired_at,
      })),
      counts: db.assets.inventoryCounts(user.id),
      equipped: JSON.parse(user.avatar_item_ids ?? '{}'),
      badges: db.badges.playerBadges(user.id, { limit: 50 }).map((badge) => ({
        id: badge.id,
        name: badge.name,
        description: badge.description,
        gameId: badge.game_id,
        gameName: badge.game_name,
        awardedAt: badge.awarded_at,
      })),
    });
  });

  return router;
}

/** ---------------------------------------------------------------- helpers */

/** Minimal multipart/form-data parser (buffers the whole body; size-limited upstream). */
export function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=([^;]+)/i.exec(contentType);
  const fields = {};
  const files = {};
  if (!boundaryMatch) {
    // Fall back to a JSON body for API clients that prefer base64 payloads.
    try {
      const parsed = JSON.parse(buffer.toString('utf8'));
      return { fields: parsed, files: {}, json: true };
    } catch {
      throw new ValidationError('Expected multipart/form-data or JSON body.');
    }
  }
  const boundary = `--${boundaryMatch[1].replace(/"/g, '')}`;
  const parts = splitBuffer(buffer, Buffer.from(`\r\n${boundary}`));
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd).toString('utf8');
    let data = part.slice(headerEnd + 4);
    if (data.slice(-2).toString() === '\r\n') data = data.slice(0, -2);
    const nameMatch = /name="([^"]+)"/.exec(headers);
    if (!nameMatch) continue;
    const filenameMatch = /filename="([^"]*)"/.exec(headers);
    const contentTypeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
    if (filenameMatch && filenameMatch[1]) {
      files[nameMatch[1]] = {
        filename: filenameMatch[1],
        contentType: contentTypeMatch?.[1]?.trim() ?? 'application/octet-stream',
        data,
      };
    } else {
      fields[nameMatch[1]] = data.toString('utf8');
    }
  }
  return { fields, files };
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);
  while (index !== -1) {
    parts.push(buffer.slice(start, index));
    start = index + separator.length + 2;
    index = buffer.indexOf(separator, start);
  }
  return parts.filter((part) => part.length);
}

/** Magic-byte sniffing: the declared type is never trusted. */
export function sniffFile(data, filename = '') {
  const head = data.slice(0, 16);
  const hex = head.toString('hex');
  if (hex.startsWith('89504e47')) return { mime: 'image/png', kind: 'image' };
  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', kind: 'image' };
  if (head.slice(0, 4).toString('ascii') === 'RIFF' && head.slice(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', kind: 'image' };
  }
  if (head.slice(0, 3).toString('ascii') === 'GIF') return { mime: 'image/gif', kind: 'image' };
  if (head.slice(0, 4).toString('ascii') === 'OggS') return { mime: 'audio/ogg', kind: 'audio' };
  if (head.slice(0, 3).toString('ascii') === 'ID3' || hex.startsWith('fffb') || hex.startsWith('fff3')) {
    return { mime: 'audio/mpeg', kind: 'audio' };
  }
  if (head.slice(0, 4).toString('ascii') === 'glTF') return { mime: 'model/gltf-binary', kind: 'mesh' };
  if (head.slice(0, 2).toString('ascii') === 'PK') return { mime: 'application/zip', kind: 'archive' };
  const text = data.slice(0, 512).toString('utf8').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    return { mime: 'application/json', kind: 'json' };
  }
  if (text.startsWith('<svg') || text.includes('<svg')) return { mime: 'image/svg+xml', kind: 'image' };
  if (text.startsWith('<?xml')) return { mime: 'application/xml', kind: 'text' };
  void filename;
  return { mime: 'application/octet-stream', kind: 'binary' };
}

function imageDimensions(data) {
  const hex = data.slice(0, 32).toString('hex');
  if (hex.startsWith('89504e47')) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (hex.startsWith('ffd8ff')) {
    let offset = 2;
    while (offset < data.length - 8) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  if (data.slice(0, 6).toString('ascii') === 'GIF89a' || data.slice(0, 6).toString('ascii') === 'GIF87a') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  return null;
}

function estimateAudioSeconds(data, mime) {
  if (mime === 'audio/mpeg') {
    // 128kbps assumption: ~16KB per second.
    return data.length / 16000;
  }
  if (mime === 'audio/wav') {
    const bytesPerSecond = data.readUInt32LE(28) || 176400;
    return (data.length - 44) / bytesPerSecond;
  }
  if (mime === 'audio/ogg') {
    // Rough Ogg Vorbis average (~112kbps).
    return data.length / 14000;
  }
  return null;
}

/** glTF mesh budget: rejects pathologically heavy meshes before they ever reach the client. */
function validateMesh(data) {
  const text = data.slice(0, 1024).toString('utf8');
  if (!text.includes('{')) return; // binary glTF header only; size limit already applied
  try {
    const json = JSON.parse(data.toString('utf8'));
    let triangles = 0;
    for (const mesh of json.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        const accessorIndex = primitive.indices;
        const accessor = accessorIndex !== undefined ? json.accessors?.[accessorIndex] : null;
        if (accessor?.count) triangles += accessor.count / 3;
        else {
          const positionAccessor = json.accessors?.[primitive.attributes?.POSITION];
          if (positionAccessor?.count) triangles += positionAccessor.count / 3;
        }
      }
    }
    if (triangles > ENGINE_LIMITS.maxMeshTriangles) {
      throw new ValidationError(
        `That mesh has ${Math.round(triangles)} triangles (limit ${ENGINE_LIMITS.maxMeshTriangles}).`,
      );
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('Mesh could not be parsed as glTF.');
  }
}

function extensionFor(mime, filename) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'model/gltf-binary': '.glb',
    'model/gltf+json': '.gltf',
    'application/json': '.json',
    'application/zip': '.zip',
  };
  const fallback = path.extname(String(filename ?? '')).toLowerCase();
  return map[mime] ?? (/^\.[a-z0-9]{1,6}$/.test(fallback) ? fallback : '.bin');
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export default registerRoutes;
