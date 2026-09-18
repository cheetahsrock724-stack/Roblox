/**
 * /api/games — discovery, game pages, engagement, versions, publishing and creator projects.
 *
 * Publishing is the bridge between the editor and the platform: the editor uploads a project
 * bundle, the server validates it, stores an immutable version, and (on publish) makes it the
 * game's current version.
 */
import { sendJson, limitUserInput, pagination, jsonColumn } from './helpers.js';
import { requireAuth, hasRole } from '../context.js';
import * as db from '@kinetiq/db';
import {
  GAME_CATEGORIES,
  DISCOVER_SORTS,
  assertEnum,
  assertInt,
  assertBoolean,
  assertString,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ENGINE_LIMITS,
  platformConfig,
} from '@kinetiq/shared';
import { buildVersionBundle, projectStats, validateBundle, createEmptyProject, PROJECT_FORMAT } from '@kinetiq/engine';

export function registerRoutes(router, deps) {
  const notify = deps?.notify ?? null;
  const realms = deps?.realms ?? null;

  /** ---------------------------------------------------------------- discovery */
  router.get('/api/games', async (ctx) => {
    const sort = assertEnum(ctx.query.get('sort') ?? 'popular', DISCOVER_SORTS, { field: 'sort', fallback: 'popular' });
    const genre = ctx.query.get('genre');
    const search = ctx.query.get('q') ?? ctx.query.get('search');
    const { limit, offset } = pagination(ctx);
    const multiplayerOnly = ctx.query.get('multiplayer') === '1';
    const ownerId = ctx.query.get('creator');
    const result = db.games.discover({
      sort,
      genre: genre && GAME_CATEGORIES.includes(genre) ? genre : null,
      search: search ? String(search).slice(0, 80) : null,
      ownerUserId: ownerId,
      multiplayerOnly,
      limit,
      offset,
    });
    sendJson(ctx.res, 200, {
      games: result.rows.map((row) => db.games.toGameSummary(row)),
      total: result.total,
      sort,
      genre: genre ?? null,
      categories: GAME_CATEGORIES,
      genres: db.games.genreCounts(),
    });
  });

  /** Home page: one call returns everything the landing page renders. */
  router.get('/api/home', async (ctx) => {
    const userId = ctx.userId ?? null;
    const featured = db.games.discover({ sort: 'popular', limit: 6, includeUnlisted: true });
    const recommended = db.games.discover({ sort: 'recommended', limit: 8 });
    const popular = db.games.discover({ sort: 'most_played', limit: 8 });
    const trending = db.games.discover({ sort: 'trending', limit: 8 });
    const newest = db.games.discover({ sort: 'new', limit: 8 });
    const updated = db.games.discover({ sort: 'updated', limit: 8 });
    const recent = userId ? db.games.recentlyPlayed(userId, { limit: 8 }) : [];

    let friendsPlaying = [];
    if (userId) {
      const friendRows = db.social.listFriends(userId);
      const friendIds = friendRows.map((row) => row.id);
      if (friendIds.length) {
        const playing = db.all(
          `SELECT id, username, display_name, presence_game_id FROM users
           WHERE presence = 'playing' AND presence_game_id IS NOT NULL
             AND id IN (${friendIds.map(() => '?').join(',')})`,
          friendIds,
        );
        friendsPlaying = playing
          .map((row) => {
            const game = db.games.findById(row.presence_game_id);
            if (!game || !game.is_public) return null;
            return {
              user: { id: row.id, username: row.username, displayName: row.display_name },
              game: db.games.toGameSummary(game),
            };
          })
          .filter(Boolean);
      }
    }

    sendJson(ctx.res, 200, {
      featured: featured.rows.map((row) => db.games.toGameSummary(row)),
      recommended: recommended.rows.map((row) => db.games.toGameSummary(row)),
      popular: popular.rows.map((row) => db.games.toGameSummary(row)),
      trending: trending.rows.map((row) => db.games.toGameSummary(row)),
      new: newest.rows.map((row) => db.games.toGameSummary(row)),
      updated: updated.rows.map((row) => db.games.toGameSummary(row)),
      recentlyPlayed: recent.map((row) => db.games.toGameSummary(row)),
      friendsPlaying,
      categories: GAME_CATEGORIES,
      genres: db.games.genreCounts(),
      stats: db.games.platformStats(),
    });
  });

  /** ---------------------------------------------------------------- game page */
  router.get('/api/games/:idOrSlug', async (ctx) => {
    const game = db.games.resolveGame(ctx.params.idOrSlug);
    if (!game) throw new NotFoundError('Game not found.');
    const isOwner = ctx.userId === game.owner_user_id;
    if (!game.is_published && !isOwner && !hasRole(ctx.user, 'moderator')) {
      throw new NotFoundError('Game not found.');
    }
    const engagement = db.games.getEngagement(game.id, ctx.userId ?? null);
    const versions = db.games.listVersions(game.id, { limit: 10 });
    const similar = db.games.recommendationsFor(game, { limit: 6 });
    const products = db.economy.listProducts(game.id);
    const badges = db.badges.listBadges({ gameId: game.id, limit: 24 });
    const privateServers = ctx.userId
      ? db.servers.listPrivateServers(game.id, { ownerUserId: ctx.userId })
      : [];

    const creator = db.users.findById(game.owner_user_id);
    const liveVersion = game.current_version_id ? db.games.getVersion(game.current_version_id) : null;
    sendJson(ctx.res, 200, {
      game: {
        ...db.games.toGameDetail(game),
        // Version number of the live release (the id alone is not human readable).
        currentVersion: liveVersion?.version_number ?? 0,
        currentVersionContentHash: liveVersion?.content_hash ?? null,
        creator: creator
          ? { id: creator.id, username: creator.username, displayName: creator.display_name, verified: Boolean(creator.is_verified_creator) }
          : null,
        isOwner,
        engagement,
        versions: versions.map((version) => ({
          id: version.id,
          versionNumber: version.version_number,
          label: version.label,
          changelog: version.changelog,
          published: Boolean(version.published),
          createdAt: version.created_at,
          stats: jsonColumn(version.manifest, {})?.stats ?? null,
        })),
        similar: similar.map((row) => db.games.toGameSummary(row)),
        products: products.map((product) => ({
          id: product.id,
          kind: product.kind,
          name: product.name,
          description: product.description,
          price: product.price,
          iconAssetId: product.icon_asset_id,
        })),
        badges: badges.map((badge) => ({
          id: badge.id,
          name: badge.name,
          description: badge.description,
          iconAssetId: badge.icon_asset_id,
          awardCount: badge.award_count,
        })),
        privateServers: privateServers.map(privateServerPublic),
        serverCount: deps.realms ? deps.realms.listRealms(game.id, { includePrivate: isOwner }).length : 0,
      },
    });
  });

  /**
   * The client's entry point for a playable release: the world scene, gameplay config and the
   * client scripts for one immutable version. Published versions are public; drafts are owner-only.
   */
  router.get('/api/games/:id/release', async (ctx) => {
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Game not found.');
    const isOwner = ctx.userId === game.owner_user_id;
    if (!game.is_published && !isOwner && !hasRole(ctx.user, 'moderator')) throw new NotFoundError('Game not found.');
    const requested = ctx.query.get('version');
    const version = requested ? db.games.getVersion(requested) : db.games.currentVersion(game.id);
    if (!version || version.game_id !== game.id) throw new NotFoundError('No published version.');
    if (!version.published && !isOwner && !hasRole(ctx.user, 'moderator')) {
      throw new ForbiddenError('That version is not published.');
    }
    const bundle = JSON.parse(version.manifest);
    sendJson(ctx.res, 200, {
      game: db.games.toGameSummary(db.games.findById(game.id)),
      version: { id: version.id, versionNumber: version.version_number, contentHash: version.content_hash },
      world: bundle.world,
      config: bundle.config ?? {},
      metadata: bundle.metadata ?? {},
      // Client scripts are delivered to the sandbox in the player's own client.
      clientScripts: (bundle.scripts ?? [])
        .filter((script) => script.kind === 'client' && !script.disabled)
        .map((script) => ({ id: script.id ?? script.name, name: script.name, source: script.source })),
    });
  });

  /** Live server browser for a game. */
  router.get('/api/games/:id/servers', async (ctx) => {
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Game not found.');
    const isOwner = ctx.userId === game.owner_user_id;
    const live = deps.realms?.listRealms(game.id, { includePrivate: isOwner }) ?? [];
    const rows = db.servers.runningServersFor(game.id);
    const servers = live.length
      ? live
      : rows.map((row) => ({
          id: row.id,
          gameId: row.game_id,
          region: row.region,
          status: row.status,
          playerCount: row.current_players,
          maxPlayers: row.max_players,
          startedAt: row.started_at ? Date.parse(`${row.started_at.replace(' ', 'T')}Z`) : null,
          privateServerId: row.private_server_id,
          joinCode: null,
        }));
    sendJson(ctx.res, 200, { servers, totalPlayers: servers.reduce((sum, server) => sum + server.playerCount, 0) });
  });

  /** ---------------------------------------------------------------- engagement */
  router.post('/api/games/:id/like', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Game not found.');
    const body = await ctx.json().catch(() => ({}));
    const value = assertInt(body.value ?? 1, { field: 'value', min: -1, max: 1, fallback: 1 });
    const result = db.games.setLike(game.id, user.id, value);
    sendJson(ctx.res, 200, {
      liked: result === 1,
      disliked: result === -1,
      ...db.games.recalculateLikes(game.id),
    });
  });

  router.post('/api/games/:id/favorite', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Game not found.');
    const body = await ctx.json().catch(() => ({}));
    const favorite = assertBoolean(body.favorite, true);
    db.games.setFavorite(game.id, user.id, favorite);
    sendJson(ctx.res, 200, { favorited: favorite, favoriteCount: db.games.findById(game.id).favorite_count });
  });

  /** ---------------------------------------------------------------- creator: projects */
  router.get('/api/creator/projects', async (ctx) => {
    const user = requireAuth(ctx);
    const { limit, offset } = pagination(ctx, { defaultLimit: 40 });
    const result = db.games.discover({
      ownerUserId: user.id,
      publishedOnly: false,
      includeUnlisted: true,
      limit,
      offset,
      sort: 'updated',
    });
    sendJson(ctx.res, 200, {
      projects: result.rows.map((row) => ({
        ...db.games.toGameSummary(row),
        versions: db.games.listVersions(row.id, { limit: 5 }).map((version) => ({
          id: version.id,
          versionNumber: version.version_number,
          published: Boolean(version.published),
          createdAt: version.created_at,
          label: version.label,
        })),
      })),
      total: result.total,
    });
  });

  router.post('/api/creator/projects', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json();
    const name = limitUserInput(body.name ?? 'Untitled Game', { max: 80, field: 'name', required: true });
    const game = db.games.createGame({
      ownerUserId: user.id,
      name,
      description: limitUserInput(body.description ?? '', { max: 4000 }),
      genre: assertEnum(body.genre ?? 'Sandbox', GAME_CATEGORIES, { field: 'genre', fallback: 'Sandbox' }),
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 12).map((tag) => String(tag).slice(0, 24)) : [],
      maxPlayers: assertInt(body.maxPlayers ?? platformConfig.games.defaultMaxPlayers, {
        field: 'maxPlayers',
        min: 1,
        max: platformConfig.games.maxMaxPlayers,
        fallback: platformConfig.games.defaultMaxPlayers,
      }),
      isPublic: assertBoolean(body.isPublic, false),
      settings: {},
    });
    // Every new project starts with an empty, valid world so the editor opens instantly.
    const project = createEmptyProject({ name, ownerId: user.id, ownerName: user.username });
    const version = db.games.createVersion({
      gameId: game.id,
      manifest: JSON.stringify(buildBundleFromProject(project, game, 1, user.id)),
      changelog: 'Project created',
      label: 'draft',
      createdBy: user.id,
      published: false,
    });
    db.games.replaceScripts(version.id, game.id, project.scripts);
    sendJson(ctx.res, 201, {
      game: db.games.toGameSummary(db.games.findById(game.id)),
      versionId: version.id,
      project,
    });
  });

  /** Load a project into the editor: the current version's bundle + editable sources. */
  router.get('/api/creator/projects/:id', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Project not found.');
    assertCanEdit(game, user, ctx);
    const versionId = ctx.query.get('version');
    const version = versionId
      ? db.games.getVersion(versionId)
      : db.games.currentVersion(game.id) ?? db.games.latestVersion(game.id);
    if (!version) throw new NotFoundError('This project has no saved versions yet.');
    const bundle = JSON.parse(version.manifest);
    sendJson(ctx.res, 200, {
      game: db.games.toGameSummary(db.games.findById(game.id)),
      version: {
        id: version.id,
        versionNumber: version.version_number,
        label: version.label,
        published: Boolean(version.published),
        changelog: version.changelog,
        createdAt: version.created_at,
      },
      project: {
        format: PROJECT_FORMAT,
        project: {
          id: game.id,
          name: game.name,
          ownerId: game.owner_user_id,
          ownerName: game.owner_name,
          updatedAt: version.created_at,
        },
        world: bundle.world,
        scripts: db.games.listScripts(version.id),
        assets: db.assets.gameAssets(game.id).map((asset) => ({
          id: asset.id,
          name: asset.name,
          assetType: asset.asset_type,
          usage: asset.usage,
        })),
        config: bundle.config ?? {},
        metadata: bundle.metadata ?? {},
      },
      versions: db.games.listVersions(game.id, { limit: 20 }).map((row) => ({
        id: row.id,
        versionNumber: row.version_number,
        label: row.label,
        published: Boolean(row.published),
        createdAt: row.created_at,
      })),
    });
  });

  /**
   * Save the project. `mode: "draft"` creates a new unpublished version (so no work is ever lost
   * and old releases stay intact), `mode: "publish"` publishes the saved version.
   */
  router.put('/api/creator/projects/:id', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Project not found.');
    assertCanEdit(game, user, ctx);
    const body = await ctx.json({ maxBytes: 64 * 1024 * 1024 });
    const project = body.project;
    if (!project || typeof project !== 'object') throw new ValidationError('Missing project payload.');
    if (!project.world || typeof project.world !== 'object') throw new ValidationError('Project has no world scene.');

    const mode = assertEnum(body.mode ?? 'draft', ['draft', 'publish'], { field: 'mode', fallback: 'draft' });
    const metadata = {
      name: limitUserInput(body.name ?? project.metadata?.name ?? game.name, { max: 80, field: 'name' }),
      description: limitUserInput(body.description ?? project.metadata?.description ?? '', { max: 4000 }),
      genre: assertEnum(body.genre ?? game.genre, GAME_CATEGORIES, { field: 'genre', fallback: 'Sandbox' }),
      tags: Array.isArray(project.metadata?.tags) ? project.metadata.tags.slice(0, 12) : [],
      iconAssetId: body.iconAssetId ?? game.icon_asset_id ?? null,
      thumbnailAssetId: body.thumbnailAssetId ?? game.thumbnail_asset_id ?? null,
      screenshots: Array.isArray(project.metadata?.screenshots) ? project.metadata.screenshots.slice(0, 12) : [],
      maxPlayers: assertInt(body.maxPlayers ?? game.max_players, {
        field: 'maxPlayers',
        min: 1,
        max: platformConfig.games.maxMaxPlayers,
        fallback: platformConfig.games.defaultMaxPlayers,
      }),
      isPublic: body.isPublic === undefined ? Boolean(game.is_public) : assertBoolean(body.isPublic, false),
      allowPrivateServers: body.allowPrivateServers === undefined ? Boolean(game.allow_private_servers) : assertBoolean(body.allowPrivateServers, true),
      privateServerPrice: assertInt(body.privateServerPrice ?? game.private_server_price ?? 0, {
        field: 'privateServerPrice',
        min: 0,
        max: 1_000_000,
        fallback: 0,
      }),
    };

    const nextVersionNumber = (db.games.listVersions(game.id, { limit: 1 })[0]?.version_number ?? 0) + 1;
    const bundle = buildBundleFromProject(
      { ...project, metadata, config: { ...(project.config ?? {}), maxPlayers: metadata.maxPlayers } },
      { ...game, ...metadata },
      nextVersionNumber,
      user.id,
    );
    bundle.metadata = metadata;
    const validation = validateBundle(bundle);
    if (!validation.ok) throw new ValidationError(`Project is invalid: ${validation.errors.join('; ')}`);
    const stats = projectStats(project);
    if (stats.parts > ENGINE_LIMITS.maxPartsPerWorld) {
      throw new ValidationError(`World has too many parts (${stats.parts} > ${ENGINE_LIMITS.maxPartsPerWorld}).`);
    }
    if (bundle.scripts.length > 400) throw new ValidationError('Too many scripts in this project (max 400).');

    const version = db.games.createVersion({
      gameId: game.id,
      manifest: JSON.stringify(bundle),
      changelog: limitUserInput(body.changelog ?? '', { max: 1000 }),
      label: limitUserInput(body.label ?? (mode === 'publish' ? 'release' : 'draft'), { max: 40 }),
      createdBy: user.id,
      published: false,
    });
    db.games.replaceScripts(version.id, game.id, bundle.scripts ?? []);

    if (mode === 'publish') {
      db.games.publishVersion(game.id, version.id, { userId: user.id });
    }
    db.games.updateGame(game.id, {
      name: metadata.name,
      description: metadata.description,
      genre: metadata.genre,
      maxPlayers: metadata.maxPlayers,
      isPublic: metadata.isPublic,
      iconAssetId: metadata.iconAssetId,
      thumbnailAssetId: metadata.thumbnailAssetId,
      tags: metadata.tags,
      screenshots: metadata.screenshots,
      allowPrivateServers: metadata.allowPrivateServers,
      privateServerPrice: metadata.privateServerPrice,
    });
    for (const assetId of Array.isArray(project.assets) ? project.assets : []) {
      const asset = db.assets.getAsset(assetId);
      if (asset) db.assets.linkGameAsset(game.id, assetId, 'project');
    }

    // Notify followers when a game is published.
    if (mode === 'publish') {
      const followerRows = db.all('SELECT follower_id FROM followers WHERE target_id = ?', [user.id]);
      for (const row of followerRows.slice(0, 500)) {
        notify?.({
          userId: row.follower_id,
          kind: 'creator_update',
          title: `${metadata.name} was updated`,
          body: limitUserInput(body.changelog ?? 'A new version is live.', { max: 200 }),
          link: `/games/${game.slug}`,
          data: { gameId: game.id, versionId: version.id },
        });
      }
      deps.realms?.listRealms(game.id).forEach((realm) => {
        // Running realms keep serving their pinned version; new joins go to a fresh realm when
        // the version changes (rolling deploy rather than mutating live sessions).
        void realm;
      });
    }

    sendJson(ctx.res, 200, {
      game: db.games.toGameSummary(db.games.findById(game.id)),
      version: {
        id: version.id,
        versionNumber: version.version_number,
        published: Boolean(db.games.getVersion(version.id).published),
        contentHash: version.content_hash,
      },
      stats,
      mode,
    });
  });

  /** Explicit publish of an already-saved version (also used for rollback). */
  router.post('/api/creator/projects/:id/publish', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Project not found.');
    assertCanEdit(game, user, ctx);
    const body = await ctx.json().catch(() => ({}));
    const version = body.versionId ? db.games.getVersion(body.versionId) : db.games.listVersions(game.id, { limit: 1 })[0];
    if (!version) throw new NotFoundError('No version to publish.');
    if (version.game_id !== game.id) throw new ValidationError('That version belongs to another game.');
    if (db.games.getVersion(version.id).published && game.current_version_id === version.id && !body.rollback) {
      throw new ConflictError('That version is already live.');
    }
    const published = db.games.publishVersion(game.id, version.id, {
      userId: user.id,
      changelog: limitUserInput(body.changelog ?? '', { max: 1000 }) || null,
    });
    // Publishing releases the game to the world: it becomes discoverable and plays public.
    // Creators can keep a release unlisted by passing `unlisted: true`.
    if (!body.unlisted && !game.is_public) {
      db.games.updateGame(game.id, { isPublic: true });
    }
    sendJson(ctx.res, 200, {
      published: {
        id: published.id,
        versionNumber: published.version_number,
        contentHash: published.content_hash,
      },
      game: db.games.toGameSummary(db.games.findById(game.id)),
    });
  });

  /**
   * Editor play-test: spins up a real realm for the newest draft (published or not) and returns a
   * join URL so PLAY / PLAY HERE launches an actual client against actual server scripts.
   */
  router.post('/api/creator/projects/:id/playtest', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Project not found.');
    assertCanEdit(game, user, ctx);
    const body = await ctx.json().catch(() => ({}));
    const version = body.versionId ? db.games.getVersion(body.versionId) : db.games.latestVersion(game.id);
    if (!version || version.game_id !== game.id) throw new NotFoundError('This project has no saved versions yet.');
    const realm = await realms.startPlaytest({
      game: db.games.findById(game.id),
      version,
      userId: user.id,
      maxPlayers: assertInt(body.maxPlayers ?? 8, { field: 'maxPlayers', min: 1, max: platformConfig.games.maxMaxPlayers, fallback: 8 }),
    });
    const { token: joinToken, expiresAt } = realms.issueJoinToken({
      realmId: realm.id,
      userId: user.id,
      gameId: game.id,
    });
    sendJson(ctx.res, 200, {
      serverId: realm.id,
      gameId: game.id,
      versionId: version.id,
      versionNumber: version.version_number,
      mode: 'playtest',
      connectUrl: `/realm/${realm.id}?token=${encodeURIComponent(joinToken)}`,
      joinToken,
      expiresAt,
    });
  });

  /** Version history for a project (newest first). Published versions are immutable. */
  router.get('/api/creator/projects/:id/versions', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Project not found.');
    assertCanEdit(game, user, ctx);
    const { limit, offset } = pagination(ctx, { defaultLimit: 50 });
    const rows = db.games.listVersions(game.id, { limit, offset });
    sendJson(ctx.res, 200, {
      gameId: game.id,
      currentVersionId: game.current_version_id,
      versions: rows.map((version) => ({
        id: version.id,
        versionNumber: version.version_number,
        label: version.label,
        changelog: version.changelog,
        published: Boolean(version.published),
        publishedAt: version.published_at,
        contentHash: version.content_hash,
        createdBy: version.created_by,
        createdAt: version.created_at,
        stats: jsonColumn(version.manifest, {})?.stats ?? null,
      })),
    });
  });

  /** Delete (unlist) a project. Published games are unpublished rather than destroyed. */
  router.delete('/api/creator/projects/:id', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Project not found.');
    assertCanEdit(game, user, ctx);
    if (game.is_published) {
      db.games.updateGame(game.id, { isPublished: false, isPublic: false });
      sendJson(ctx.res, 200, { ok: true, unpublished: true });
      return;
    }
    db.games.deleteGame(game.id);
    sendJson(ctx.res, 200, { ok: true, deleted: true });
  });

  return router;
}

/** Owner, group admin or platform staff may edit a game. */
export function assertCanEdit(game, user, ctx) {
  if (game.owner_user_id === user.id) return true;
  if (hasRole(user, 'moderator')) return true;
  if (game.owner_group_id) {
    const { groups } = db;
    if (groups.hasPermission(game.owner_group_id, user.id, 'manage_games')) return true;
  }
  throw new ForbiddenError('You do not have permission to edit this game.');
}

export function buildBundleFromProject(project, game, versionNumber, userId) {
  const bundle = buildVersionBundle(
    { ...project, metadata: { ...(project.metadata ?? {}), name: project.metadata?.name ?? game.name } },
    {
      gameId: game.id,
      versionNumber,
      changelog: '',
      publishedBy: userId,
    },
  );
  return bundle;
}

export function privateServerPublic(row) {
  return {
    id: row.id,
    gameId: row.game_id,
    name: row.name,
    joinCode: row.join_code,
    active: Boolean(row.active),
    maxPlayers: row.max_players,
    memberCount: row.member_count ?? 0,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export default registerRoutes;
