/** /api/auth — registration, sign in/out, session refresh, password + email flows. */
import { sendJson, serializeCookie, verifyCsrf, UnauthorizedError, ValidationError, limitUserInput } from './helpers.js';
import { requireAuth, limiters, SESSION_COOKIE, REFRESH_COOKIE, CSRF_COOKIE, createApiKey, listApiKeys, revokeApiKey } from '../context.js';
import * as db from '@kinetiq/db';
import { platformConfig } from '@kinetiq/shared';

const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

export function registerRoutes(router, deps) {
  const { auth, notify } = deps;

  const setSessionCookies = (res, session, { secure = false } = {}) => {
    const headers = [];
    headers.push(serializeCookie(SESSION_COOKIE, session.id, { maxAge: 60 * 60 * 6, httpOnly: true, secure, sameSite: 'Lax' }));
    headers.push(
      serializeCookie(REFRESH_COOKIE, session.refreshToken, { maxAge: REFRESH_MAX_AGE, httpOnly: true, secure, sameSite: 'Lax' }),
    );
    headers.push(
      serializeCookie(CSRF_COOKIE, session.csrfToken ?? '', { maxAge: REFRESH_MAX_AGE, httpOnly: false, secure, sameSite: 'Lax' }),
    );
    res.setHeader('set-cookie', headers);
    return session.csrfToken;
  };

  router.post('/api/auth/register', async (ctx) => {
    limiters.auth.check(`register:${ctx.ip}`);
    const body = await ctx.json();
    const result = auth.register({
      username: body.username,
      displayName: body.displayName,
      password: body.password,
      email: body.email,
      ip: ctx.ip,
      userAgent: ctx.headers['user-agent'] ?? '',
    });
    notify?.({
      userId: result.user.id,
      kind: 'system',
      title: `Welcome to ${platformConfig.platformName}`,
      body: `Your account is ready. You start with ${platformConfig.economy.signupBonus} ${platformConfig.currencyName}.`,
    });
    setSessionCookies(ctx.res, result.session);
    sendJson(ctx.res, 201, {
      user: db.users.toPublicUser(result.user, { includePrivate: true }),
      csrfToken: result.session.csrfToken,
    });
  });

  router.post('/api/auth/login', async (ctx) => {
    limiters.auth.check(`login:${ctx.ip}`);
    const body = await ctx.json();
    const result = auth.login({
      username: body.username,
      password: body.password,
      ip: ctx.ip,
      userAgent: ctx.headers['user-agent'] ?? '',
    });
    setSessionCookies(ctx.res, result.session);
    sendJson(ctx.res, 200, {
      user: db.users.toPublicUser(result.user, { includePrivate: true }),
      csrfToken: result.session.csrfToken,
    });
  });

  router.post('/api/auth/logout', async (ctx) => {
    if (ctx.sessionId) auth.logout(ctx.sessionId);
    ctx.res.setHeader('set-cookie', [
      serializeCookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true }),
      serializeCookie(REFRESH_COOKIE, '', { maxAge: 0, httpOnly: true }),
      serializeCookie(CSRF_COOKIE, '', { maxAge: 0, httpOnly: false }),
    ]);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/auth/refresh', async (ctx) => {
    limiters.auth.check(`refresh:${ctx.ip}`);
    const body = await ctx.json().catch(() => ({}));
    const refreshToken = body.refreshToken ?? ctx.cookies[REFRESH_COOKIE];
    const sessionId = ctx.sessionId;
    if (!sessionId || !refreshToken) throw new UnauthorizedError('No refresh token.');
    const result = auth.rotate({
      sessionId,
      refreshToken,
      ip: ctx.ip,
      userAgent: ctx.headers['user-agent'] ?? '',
    });
    setSessionCookies(ctx.res, result.session);
    sendJson(ctx.res, 200, {
      user: db.users.toPublicUser(result.user, { includePrivate: true }),
      csrfToken: result.session.csrfToken,
    });
  });

  router.get('/api/auth/me', async (ctx) => {
    if (!ctx.user) {
      sendJson(ctx.res, 200, { user: null, authenticated: false });
      return;
    }
    sendJson(ctx.res, 200, {
      user: db.users.toPublicUser(ctx.user, { includePrivate: true }),
      authenticated: true,
      balance: db.economy.balanceOf(ctx.user.id),
      unreadNotifications: db.notifications.unreadCount(ctx.user.id),
      csrfToken: ctx.csrfToken,
    });
  });

  router.post('/api/auth/csrf', async (ctx) => {
    const csrfToken = ctx.csrfToken || requireAuth(ctx) && '';
    sendJson(ctx.res, 200, { csrfToken });
  });

  router.post('/api/auth/password/reset-request', async (ctx) => {
    limiters.auth.check(`reset:${ctx.ip}`);
    const body = await ctx.json();
    const result = auth.requestPasswordReset(body.email);
    sendJson(ctx.res, 200, {
      ok: true,
      // In development the reset link is returned so the flow is testable without email delivery.
      ...(platformConfig.features.emailVerification || process.env.NODE_ENV !== 'production'
        ? { devLink: result.link ?? null }
        : {}),
    });
  });

  router.post('/api/auth/password/reset', async (ctx) => {
    const body = await ctx.json();
    const result = auth.completePasswordReset({ token: body.token, password: body.password });
    sendJson(ctx.res, 200, result);
  });

  router.post('/api/auth/password/change', async (ctx) => {
    requireAuth(ctx);
    const body = await ctx.json();
    const result = auth.changePassword({
      userId: ctx.userId,
      currentPassword: body.currentPassword,
      password: body.password,
      sessionId: ctx.sessionId,
    });
    sendJson(ctx.res, 200, result);
  });

  router.post('/api/auth/email/verify', async (ctx) => {
    const body = await ctx.json();
    sendJson(ctx.res, 200, auth.verifyEmail(body.code));
  });

  router.post('/api/auth/email/send', async (ctx) => {
    const user = requireAuth(ctx);
    if (!user.email) throw new ValidationError('Add an email address first.');
    const verification = auth.createEmailVerification(user);
    notify?.({
      userId: user.id,
      kind: 'system',
      title: 'Verify your email',
      body: 'Use the verification link to confirm your address.',
      link: verification.link,
    });
    sendJson(ctx.res, 200, {
      ok: true,
      ...(process.env.NODE_ENV !== 'production' ? { devLink: verification.link, devCode: verification.code } : {}),
    });
  });

  router.get('/api/auth/sessions', async (ctx) => {
    const user = requireAuth(ctx);
    sendJson(ctx.res, 200, {
      sessions: db.sessions.listSessions(user.id).map((row) => ({
        id: row.id,
        userAgent: row.user_agent,
        ip: row.ip,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        current: row.id === ctx.sessionId,
      })),
    });
  });

  router.post('/api/auth/sessions/revoke', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json();
    if (body.all) auth.logoutAll(user.id, { exceptSessionId: ctx.sessionId });
    else db.sessions.revokeSession(body.sessionId);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/auth/logout-all', async (ctx) => {
    const user = requireAuth(ctx);
    auth.logoutAll(user.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/auth/api-keys', async (ctx) => {
    const user = requireAuth(ctx);
    sendJson(ctx.res, 200, { keys: listApiKeys(user.id) });
  });

  router.post('/api/auth/api-keys', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json();
    const created = createApiKey(user.id, {
      name: body.name ?? 'Developer key',
      scopes: Array.isArray(body.scopes) ? body.scopes : ['read'],
      expiresInDays: body.expiresInDays ?? null,
    });
    sendJson(ctx.res, 201, { ...created, note: 'Store this key now — it is not shown again.' });
  });

  router.post('/api/auth/api-keys/revoke', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json();
    sendJson(ctx.res, 200, revokeApiKey(user.id, body.keyId));
  });

  return router;
}

export { verifyCsrf, limitUserInput };
export default registerRoutes;
