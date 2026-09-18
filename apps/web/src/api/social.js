/** /api/friends, /api/notifications, /api/messages — the social graph, presence and chat. */
import { sendJson, limitUserInput, pagination } from './helpers.js';
import { requireAuth, limiters } from '../context.js';
import * as db from '@kinetiq/db';
import {
  platformConfig,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
  PRESENCE_STATUSES,
} from '@kinetiq/shared';
import { defaultChatFilter } from '@kinetiq/server';

export function registerRoutes(router, deps) {
  const { notify } = deps;
  const filter = deps.chatFilter ?? defaultChatFilter;

  const card = (row) => ({
    ...db.users.toUserCard(row),
    friendsSince: row.friends_since ?? null,
  });

  /** ---------------------------------------------------------------- friends */
  router.get('/api/friends', async (ctx) => {
    const user = requireAuth(ctx);
    const friends = db.social.listFriends(user.id);
    const ids = friends.map((row) => row.id);
    const playing = new Map();
    if (ids.length) {
      const rows = db.all(
        `SELECT id, presence_game_id FROM users WHERE presence = 'playing' AND presence_game_id IS NOT NULL
         AND id IN (${ids.map(() => '?').join(',')})`,
        ids,
      );
      for (const row of rows) playing.set(row.id, row.presence_game_id);
    }
    sendJson(ctx.res, 200, {
      friends: friends.map((row) => {
        const gameId = playing.get(row.id);
        const game = gameId ? db.games.findById(gameId) : null;
        const privacy = db.users.normalisePrivacy(row.privacy);
        const sharesActivity = privacy.whoCanSeeActivity === 'everyone' || privacy.whoCanSeeActivity === 'friends';
        return {
          ...card(row),
          playing: game && sharesActivity && game.is_public ? { id: game.id, name: game.name, slug: game.slug } : null,
          canJoin: game && sharesActivity && privacy.whoCanJoin !== 'nobody' ? true : false,
        };
      }),
      online: friends.filter((row) => row.presence !== 'offline').length,
      total: friends.length,
    });
  });

  router.get('/api/friends/requests', async (ctx) => {
    const user = requireAuth(ctx);
    sendJson(ctx.res, 200, {
      incoming: db.social.incomingRequests(user.id).map((row) => ({
        id: row.id,
        from: {
          id: row.from_user_id,
          username: row.from_username,
          displayName: row.from_display_name,
          presence: row.from_presence,
        },
        message: row.message,
        createdAt: row.created_at,
      })),
      outgoing: db.social.outgoingRequests(user.id).map((row) => ({
        id: row.id,
        to: {
          id: row.to_user_id,
          username: row.to_username,
          displayName: row.to_display_name,
          presence: row.to_presence,
        },
        message: row.message,
        createdAt: row.created_at,
      })),
    });
  });

  router.post('/api/friends/requests', async (ctx) => {
    const user = requireAuth(ctx);
    limiters.chat.check(`friendreq:${user.id}`);
    const body = await ctx.json();
    const target = resolveUser(body.username ?? body.userId);
    if (!target) throw new NotFoundError('User not found.');
    if (target.id === user.id) throw new ValidationError('You cannot add yourself.');
    const targetPrivacy = db.users.normalisePrivacy(target.privacy);
    const isFriend = db.social.areFriends(user.id, target.id);
    if (targetPrivacy.whoCanFriendRequest === 'nobody' && !isFriend) {
      throw new ForbiddenError('That player is not accepting friend requests.');
    }
    if (targetPrivacy.whoCanFriendRequest === 'friends' && !isFriend) {
      // "friends of friends" policy: check for a mutual friend.
      const mutual = db.social.mutualFriendIds(user.id, target.id);
      if (!mutual.length) throw new ForbiddenError('That player only accepts requests from friends of friends.');
    }
    const result = db.social.sendFriendRequest(user.id, target.id, limitUserInput(body.message ?? '', { max: 200 }));
    if (!result.ok) {
      if (result.reason === 'already_friends') throw new ConflictError('You are already friends.');
      if (result.reason === 'blocked') throw new ForbiddenError('That request cannot be sent.');
      if (result.reason === 'already_requested') throw new ConflictError('You already sent a request.');
      throw new ValidationError('Could not send that request.');
    }
    if (result.autoAccepted) {
      await acceptFlow(user, target, notify);
      sendJson(ctx.res, 200, { accepted: true, requestId: result.requestId });
      return;
    }
    notify?.({
      userId: target.id,
      kind: 'friend_request',
      title: `${user.display_name} sent you a friend request`,
      body: '',
      link: '/friends',
      data: { requestId: result.requestId, fromUserId: user.id },
    });
    sendJson(ctx.res, 201, { requestId: result.requestId, pending: true });
  });

  router.post('/api/friends/requests/:id/respond', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json();
    const accept = Boolean(body.accept);
    const result = db.social.respondToFriendRequest(ctx.params.id, user.id, accept);
    if (!result.ok) {
      if (result.reason === 'not_found') throw new NotFoundError('Request not found.');
      if (result.reason === 'forbidden') throw new ForbiddenError('That request is not yours to answer.');
      throw new ConflictError('That request was already handled.');
    }
    if (accept) await acceptFlow(user, db.users.findById(result.fromUserId), notify, { reverse: true });
    sendJson(ctx.res, 200, { accepted: accept });
  });

  router.post('/api/friends/requests/:id/cancel', async (ctx) => {
    const user = requireAuth(ctx);
    if (!db.social.cancelFriendRequest(ctx.params.id, user.id)) throw new NotFoundError('Request not found.');
    sendJson(ctx.res, 200, { ok: true });
  });

  router.delete('/api/friends/:userId', async (ctx) => {
    const user = requireAuth(ctx);
    const removed = db.social.removeFriend(user.id, ctx.params.userId);
    sendJson(ctx.res, 200, { removed });
  });

  router.post('/api/friends/:userId/invite', async (ctx) => {
    const user = requireAuth(ctx);
    const target = db.users.findById(ctx.params.userId);
    if (!target) throw new NotFoundError('User not found.');
    if (!db.social.areFriends(user.id, target.id)) throw new ForbiddenError('You can only invite friends.');
    const targetPrivacy = db.users.normalisePrivacy(target.privacy);
    if (targetPrivacy.whoCanInvite === 'nobody') throw new ForbiddenError('That player does not accept invites.');
    const body = await ctx.json().catch(() => ({}));
    const game = body.gameId ? db.games.findById(String(body.gameId)) : null;
    const serverId = body.serverId ? String(body.serverId) : null;
    notify?.({
      userId: target.id,
      kind: 'game_invite',
      title: `${user.display_name} invited you to play`,
      body: game ? game.name : 'Join their server',
      link: serverId ? `/join?server=${serverId}` : game ? `/games/${game.slug}` : '/discover',
      data: { gameId: game?.id ?? null, serverId, fromUserId: user.id },
    });
    sendJson(ctx.res, 200, { ok: true });
  });

  /** ---------------------------------------------------------------- followers */
  router.post('/api/users/:id/follow', async (ctx) => {
    const user = requireAuth(ctx);
    const target = db.users.findById(ctx.params.id);
    if (!target) throw new NotFoundError('User not found.');
    if (target.id === user.id) throw new ValidationError('You cannot follow yourself.');
    const body = await ctx.json().catch(() => ({}));
    if (body.unfollow) db.social.unfollow(user.id, target.id);
    else db.social.follow(user.id, target.id);
    sendJson(ctx.res, 200, {
      following: !body.unfollow,
      followerCount: db.social.followerCount(target.id),
    });
  });

  /** ---------------------------------------------------------------- notifications */
  router.get('/api/notifications', async (ctx) => {
    const user = requireAuth(ctx);
    const unreadOnly = ctx.query.get('unread') === '1';
    sendJson(ctx.res, 200, {
      notifications: db.notifications.listNotifications(user.id, { unreadOnly, limit: 50 }),
      unread: db.notifications.unreadCount(user.id),
    });
  });

  router.post('/api/notifications/read', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json().catch(() => ({}));
    if (body.all) db.notifications.markAllRead(user.id);
    else if (body.id) db.notifications.markRead(user.id, String(body.id));
    sendJson(ctx.res, 200, { ok: true, unread: db.notifications.unreadCount(user.id) });
  });

  /** ---------------------------------------------------------------- direct messages */
  router.get('/api/messages/threads', async (ctx) => {
    const user = requireAuth(ctx);
    sendJson(ctx.res, 200, {
      threads: db.social.listThreads(user.id, { limit: 40 }).map((row) => ({
        id: row.id,
        otherUser: { id: row.other_user_id, username: row.other_username },
        lastMessage: row.last_body,
        lastSenderId: row.last_sender_id,
        messageCount: row.message_count,
        lastReadAt: row.last_read_at,
        updatedAt: row.updated_at,
      })),
    });
  });

  router.get('/api/messages/:threadId', async (ctx) => {
    const user = requireAuth(ctx);
    const participant = db.get('SELECT * FROM thread_participants WHERE thread_id = ? AND user_id = ?', [
      ctx.params.threadId,
      user.id,
    ]);
    if (!participant) throw new ForbiddenError('You are not part of that conversation.');
    const { limit, offset } = pagination(ctx, { defaultLimit: 50 });
    const messages = db.social.listThread(ctx.params.threadId, { limit, offset });
    db.social.markThreadRead(ctx.params.threadId, user.id);
    sendJson(ctx.res, 200, {
      messages: messages
        .map((row) => ({
          id: row.id,
          senderId: row.sender_id,
          senderUsername: row.sender_username,
          senderDisplayName: row.sender_display_name,
          body: row.body,
          createdAt: row.created_at,
          moderationState: row.moderation_state,
        }))
        .reverse(),
    });
  });

  router.post('/api/messages', async (ctx) => {
    const user = requireAuth(ctx);
    limiters.chat.check(`dm:${user.id}`);
    const body = await ctx.json();
    const target = resolveUser(body.to ?? body.userId ?? body.username);
    if (!target) throw new NotFoundError('Recipient not found.');
    if (target.id === user.id) throw new ValidationError('You cannot message yourself.');

    const privacy = db.users.normalisePrivacy(target.privacy);
    const isFriend = db.social.areFriends(user.id, target.id);
    if (db.social.blockedEitherWay(user.id, target.id)) throw new ForbiddenError('Messaging is unavailable.');
    if (privacy.whoCanMessage === 'nobody') throw new ForbiddenError('That player is not accepting messages.');
    if (privacy.whoCanMessage === 'friends' && !isFriend) {
      throw new ForbiddenError('That player only accepts messages from friends.');
    }

    const text = limitUserInput(body.body, {
      max: platformConfig.safety.maxMessageLength,
      field: 'body',
      required: true,
    });
    const filtered = filter(text);
    const message = db.social.postDirectMessage(user.id, target.id, filtered.clean, {
      filteredBody: filtered.blocked ? text : null,
    });
    notify?.({
      userId: target.id,
      kind: 'system',
      title: `Message from ${user.display_name}`,
      body: filtered.clean.slice(0, 140),
      link: `/messages?user=${user.id}`,
      data: { fromUserId: user.id, threadId: message.thread_id },
    });
    sendJson(ctx.res, 201, {
      message: {
        id: message.id,
        threadId: message.thread_id,
        body: message.body,
        createdAt: message.created_at,
      },
      filtered: filtered.blocked,
    });
  });

  /** ---------------------------------------------------------------- presence */
  router.get('/api/presence', async (ctx) => {
    const user = requireAuth(ctx);
    const friends = db.social.listFriends(user.id, { limit: 200 });
    sendJson(ctx.res, 200, {
      self: {
        presence: user.presence,
        gameId: user.presence_game_id,
        updatedAt: user.presence_updated_at,
      },
      friends: friends.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        presence: PRESENCE_STATUSES.includes(row.presence) ? row.presence : 'offline',
        gameId: row.presence_game_id,
        lastSeenAt: row.presence_updated_at,
      })),
    });
  });

  return router;
}

function resolveUser(idOrUsername) {
  if (!idOrUsername) return null;
  const value = String(idOrUsername);
  return value.startsWith('usr_') ? db.users.findById(value) : db.users.findByUsername(value);
}

async function acceptFlow(user, other, notify, { reverse = false } = {}) {
  if (!other) return;
  const a = reverse ? other : user;
  const b = reverse ? user : other;
  notify?.({
    userId: b.id,
    kind: 'friend_accepted',
    title: `${a.display_name} accepted your friend request`,
    body: 'You are now friends.',
    link: `/users/${a.username}`,
    data: { userId: a.id },
  });
}

export default registerRoutes;
