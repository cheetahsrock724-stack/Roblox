/** /api/users — profiles, privacy settings, presence, search, avatar configuration. */
import { sendJson, limitUserInput, pagination, jsonColumn } from './helpers.js';
import { requireAuth, hasRole } from '../context.js';
import * as db from '@kinetiq/db';
import {
  assertEnum,
  assertBoolean,
  PRIVACY_KEYS,
  PRIVACY_VALUES,
  AVATAR_CATEGORIES,
  NotFoundError,
  ForbiddenError,
  ValidationError,
} from '@kinetiq/shared';

export function registerRoutes(router) {
  /** Full profile view with the viewer's relationship to that user. */
  router.get('/api/users/:id', async (ctx) => {
    const target =
      ctx.params.id.startsWith('usr_') || ctx.params.id.length > 20
        ? db.users.findById(ctx.params.id)
        : db.users.findByUsername(ctx.params.id);
    if (!target || target.status === 'deleted') throw new NotFoundError('User not found.');

    const viewerId = ctx.userId ?? null;
    const isSelf = viewerId === target.id;
    const friendship = viewerId ? db.social.areFriends(viewerId, target.id) : false;
    const pending = viewerId && !friendship ? db.social.pendingRequestBetween(viewerId, target.id) : null;
    const privacy = db.users.normalisePrivacy(target.privacy);
    const canSeeInventory =
      isSelf ||
      hasRole(ctx.user, 'moderator') ||
      privacy.whoCanSeeInventory === 'everyone' ||
      (privacy.whoCanSeeInventory === 'friends' && friendship);

    const games = db.games.discover({ ownerUserId: target.id, publishedOnly: true, limit: 12 });
    const favorites = db.games.favoriteGames(target.id, { limit: 12 });

    sendJson(ctx.res, 200, {
      user: {
        ...db.users.toPublicUser(target, { includePrivate: isSelf }),
        bio: target.bio,
        followerCount: db.social.followerCount(target.id),
        followingCount: db.social.followingCount(target.id),
        friendCount: db.social.friendCount(target.id),
        badges: db.badges.playerBadges(target.id, { limit: 24 }).map((badge) => ({
          id: badge.id,
          name: badge.name,
          description: badge.description,
          iconAssetId: badge.icon_asset_id,
          gameId: badge.game_id,
          gameName: badge.game_name,
          awardedAt: badge.awarded_at,
        })),
        games: games.rows.map((row) => db.games.toGameSummary(row)),
        favorites: favorites.map((row) => db.games.toGameSummary(row)),
        inventoryVisible: canSeeInventory,
        isSelf,
        isFriend: friendship,
        followRequest: pending
          ? { id: pending.id, direction: pending.from_user_id === viewerId ? 'outgoing' : 'incoming' }
          : null,
        following: viewerId ? db.social.isFollowing(viewerId, target.id) : false,
      },
    });
  });

  /** Search across users, games, groups and avatar items in one call. */
  router.get('/api/search', async (ctx) => {
    const query = (ctx.query.get('q') ?? '').trim();
    const kind = ctx.query.get('type') ?? 'all';
    if (query.length < 2) {
      sendJson(ctx.res, 200, { query, users: [], games: [], groups: [], items: [] });
      return;
    }
    const limit = Math.min(30, Number(ctx.query.get('limit') ?? 12) || 12);
    const response = { query, users: [], games: [], groups: [], items: [] };
    if (kind === 'all' || kind === 'games') {
      response.games = db.games
        .discover({ search: query, limit, sort: 'popular' })
        .rows.map((row) => db.games.toGameSummary(row));
    }
    if (kind === 'all' || kind === 'users') {
      response.users = db.users.searchUsers(query, { limit }).map((row) => db.users.toUserCard(row));
    }
    if (kind === 'all' || kind === 'groups') {
      response.groups = db.groups.listGroups({ query, limit }).map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        memberCount: row.member_count,
        emblemAssetId: row.emblem_asset_id,
      }));
    }
    if (kind === 'all' || kind === 'items') {
      response.items = db.assets.listAvatarItems({ query, limit }).rows.map((row) => publicAvatarItem(row));
    }
    sendJson(ctx.res, 200, response);
  });

  /** Users the viewer can join right now (friends playing publicly). */
  router.get('/api/users/friends/playing', async (ctx) => {
    const user = requireAuth(ctx);
    const friends = db.social.listFriends(user.id);
    const friendIds = friends.map((row) => row.id);
    const presence = friendIds.length
      ? db.all(
          `SELECT id, username, display_name, presence, presence_game_id FROM users
           WHERE id IN (${friendIds.map(() => '?').join(',')}) AND presence = 'playing'`,
          friendIds,
        )
      : [];
    const games = new Map();
    for (const row of presence) {
      if (!row.presence_game_id) continue;
      const game = db.games.findById(row.presence_game_id);
      if (!game || !game.is_published || !game.is_public) continue;
      if (!games.has(game.id)) games.set(game.id, { game: db.games.toGameSummary(game), players: [] });
      games.get(game.id).players.push({ id: row.id, username: row.username, displayName: row.display_name });
    }
    sendJson(ctx.res, 200, { entries: [...games.values()] });
  });

  /** Update own profile, avatar and settings. */
  router.patch('/api/users/me', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json();
    const patch = {};
    if (body.displayName !== undefined) patch.displayName = limitUserInput(body.displayName, { max: 32, field: 'displayName' });
    if (body.bio !== undefined) patch.bio = limitUserInput(body.bio, { max: 500, field: 'bio' });
    if (body.settings !== undefined) patch.settings = body.settings;
    if (body.avatarImageId !== undefined) patch.avatarImageId = body.avatarImageId || null;

    // Avatar colours are validated to hex values only.
    if (body.avatarColors !== undefined) {
      const colors = {};
      for (const [key, value] of Object.entries(body.avatarColors ?? {})) {
        if (!/^#[0-9a-fA-F]{6}$/.test(String(value))) throw new ValidationError(`Invalid colour for ${key}.`);
        colors[String(key).slice(0, 24)] = String(value).toLowerCase();
      }
      patch.avatarColors = colors;
    }
    // Equipped items must be owned by the player.
    if (body.avatarItemIds !== undefined) {
      const equipped = {};
      for (const [category, itemId] of Object.entries(body.avatarItemIds ?? {})) {
        if (!AVATAR_CATEGORIES.includes(category)) throw new ValidationError(`Unknown avatar category "${category}".`);
        if (!itemId) continue;
        if (!db.assets.ownsItem(user.id, 'avatar_item', itemId)) {
          throw new ForbiddenError('You do not own that item.');
        }
        const item = db.assets.getAvatarItem(itemId);
        if (!item || item.category !== category) throw new ValidationError('Item does not match that category.');
        equipped[category] = itemId;
      }
      patch.avatarItemIds = equipped;
    }
    const updated = db.users.updateProfile(user.id, patch);
    sendJson(ctx.res, 200, { user: db.users.toPublicUser(updated, { includePrivate: true }) });
  });

  /** Privacy controls: who can message, join, see inventory, invite, see activity. */
  router.patch('/api/users/me/privacy', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json();
    const patch = {};
    for (const key of PRIVACY_KEYS) {
      if (body[key] === undefined) continue;
      patch[key] = assertEnum(body[key], PRIVACY_VALUES, { field: key });
    }
    const privacy = db.users.updatePrivacy(user.id, patch);
    sendJson(ctx.res, 200, { privacy });
  });

  router.get('/api/users/me/privacy', async (ctx) => {
    const user = requireAuth(ctx);
    sendJson(ctx.res, 200, { privacy: db.users.normalisePrivacy(user.privacy) });
  });

  /** Presence heartbeat from the website (keeps "online" accurate without a socket). */
  router.post('/api/users/me/presence', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json().catch(() => ({}));
    const presence = assertEnum(body.presence ?? 'online', ['offline', 'online', 'creating', 'playing'], {
      field: 'presence',
      fallback: 'online',
    });
    db.users.setPresence(user.id, presence, { gameId: body.gameId ?? null });
    sendJson(ctx.res, 200, { ok: true, presence });
  });

  /** Blocking and unblocking. */
  router.post('/api/users/:id/block', async (ctx) => {
    const user = requireAuth(ctx);
    const target = db.users.findById(ctx.params.id);
    if (!target) throw new NotFoundError('User not found.');
    const body = await ctx.json().catch(() => ({}));
    if (assertBoolean(body.blocked, true)) db.social.blockUser(user.id, target.id);
    else db.social.unblockUser(user.id, target.id);
    sendJson(ctx.res, 200, { ok: true, blocked: assertBoolean(body.blocked, true) });
  });

  router.get('/api/users/me/blocks', async (ctx) => {
    const user = requireAuth(ctx);
    sendJson(ctx.res, 200, { users: db.social.blockedUsers(user.id).map((row) => db.users.toUserCard(row)) });
  });

  /** A user's inventory (respecting privacy settings). */
  router.get('/api/users/:id/inventory', async (ctx) => {
    const target = db.users.findById(ctx.params.id);
    if (!target) throw new NotFoundError('User not found.');
    const viewerId = ctx.userId ?? null;
    const isSelf = viewerId === target.id;
    const privacy = db.users.normalisePrivacy(target.privacy);
    const friendship = viewerId ? db.social.areFriends(viewerId, target.id) : false;
    const allowed =
      isSelf ||
      hasRole(ctx.user, 'moderator') ||
      privacy.whoCanSeeInventory === 'everyone' ||
      (privacy.whoCanSeeInventory === 'friends' && friendship);
    if (!allowed) throw new ForbiddenError('That inventory is private.');
    const { limit, offset } = pagination(ctx, { defaultLimit: 60 });
    const items = db.assets.listInventory(target.id, { limit, offset });
    sendJson(ctx.res, 200, {
      items: items.map((row) => ({
        id: row.id,
        kind: row.kind,
        refId: row.ref_id,
        name: row.item_name ?? row.badge_name ?? row.asset_name ?? row.ref_id,
        category: row.item_category,
        thumbnailAssetId: row.item_thumbnail,
        description: row.badge_description,
        acquiredAt: row.acquired_at,
        acquiredVia: row.acquired_via,
        quantity: row.quantity,
      })),
      counts: db.assets.inventoryCounts(target.id),
    });
  });

  return router;
}

export function publicAvatarItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    creatorUserId: row.creator_user_id,
    creatorUsername: row.creator_username ?? null,
    assetId: row.asset_id,
    thumbnailAssetId: row.thumbnail_asset_id,
    colors: jsonColumn(row.colors, []),
    attachment: jsonColumn(row.attachment, {}),
    price: row.price,
    isForSale: Boolean(row.is_for_sale),
    isLimited: Boolean(row.is_limited),
    sales: row.sales,
    moderationStatus: row.moderation_status,
    createdAt: row.created_at,
  };
}

export default registerRoutes;
