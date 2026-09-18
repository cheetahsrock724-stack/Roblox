/**
 * Per-request context: cookies, body parsing, session resolution, CSRF enforcement, API keys,
 * and rate limiting. Every route handler receives one of these and never touches `req` directly
 * for security-relevant state.
 */
import {
  readJson,
  readBody,
  parseCookies,
  clientIp,
  RateLimiter,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  platformConfig,
  createLogger,
  sha256,
  token,
} from '@kinetiq/shared';
import * as db from '@kinetiq/db';

const log = createLogger('http');
const SESSION_COOKIE = 'kq_session';
const REFRESH_COOKIE = 'kq_refresh';
const CSRF_COOKIE = 'kq_csrf';

/** Global limiters shared by the API. */
export const limiters = {
  api: new RateLimiter({ windowMs: 60_000, max: 600, name: 'api' }),
  write: new RateLimiter({ windowMs: 60_000, max: 240, name: 'write' }),
  auth: new RateLimiter({ windowMs: 60_000, max: 30, name: 'auth' }),
  upload: new RateLimiter({ windowMs: 3_600_000, max: 120, name: 'upload' }),
  chat: new RateLimiter({ windowMs: 60_000, max: 120, name: 'chat' }),
  matchmaking: new RateLimiter({ windowMs: 60_000, max: 60, name: 'matchmaking' }),
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function createContext(req, res, { auth }) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const cookies = parseCookies(req.headers.cookie ?? '');
  const ip = clientIp(req);
  const csrfCookie = cookies[CSRF_COOKIE];
  if (!csrfCookie) {
    cookies[CSRF_COOKIE] = '';
  }
  const ctx = {
    req,
    res,
    url,
    method: req.method.toUpperCase(),
    path: url.pathname,
    query: url.searchParams,
    params: {},
    cookies,
    ip,
    headers: req.headers,
    user: null,
    sessionId: cookies[SESSION_COOKIE] ?? null,
    csrfToken: csrfCookie,
    body: {},
    isApiKey: false,
    log,
    /** Reads and parses the JSON body (size-limited). */
    async json({ maxBytes = 2 * 1024 * 1024 } = {}) {
      if (ctx.body && Object.keys(ctx.body).length) return ctx.body;
      ctx.body = await readJson(req, { maxBytes });
      return ctx.body;
    },
    async raw({ maxBytes = platformConfig.limits?.maxUploadBytes ?? 12 * 1024 * 1024 } = {}) {
      return readBody(req, { maxBytes });
    },
  };

  // Authenticate: session cookie, refresh cookie or Bearer API key/token.
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (ctx.sessionId) {
    const resolved = await auth.resolveSession(ctx);
    if (resolved) {
      ctx.user = resolved.user;
      ctx.userId = resolved.user.id;
    }
  }
  if (!ctx.user && bearer) {
    const resolved = resolveApiKey(bearer);
    if (resolved) {
      ctx.user = resolved.user;
      ctx.userId = resolved.user.id;
      ctx.isApiKey = true;
      ctx.apiKey = resolved.key;
    }
  }

  // Rate limit by user (when known) or IP.
  const rateKey = ctx.userId ?? ip;
  if (ctx.path.startsWith('/api/')) {
    limiters.api.check(rateKey);
    if (!SAFE_METHODS.has(ctx.method) && !ctx.path.startsWith('/api/auth')) limiters.write.check(rateKey);
  }

  // CSRF: state-changing requests must present the token from the double-submit cookie.
  if (!SAFE_METHODS.has(ctx.method) && !ctx.isApiKey && !ctx.path.startsWith('/api/realtime')) {
    const header = req.headers['x-csrf-token'];
    if (ctx.sessionId && header !== csrfCookie) {
      throw new ForbiddenError('Missing or invalid CSRF token.');
    }
  }

  return ctx;
}

/** Validates that the request is authenticated, optionally with a role. */
export function requireAuth(ctx, { role = null } = {}) {
  if (!ctx.user) throw new UnauthorizedError('Sign in to continue.');
  if (ctx.user.status === 'banned' || ctx.user.status === 'suspended') {
    throw new ForbiddenError(`This account is ${ctx.user.status}.`);
  }
  if (role && !hasRole(ctx.user, role)) throw new ForbiddenError('You do not have permission to do that.');
  return ctx.user;
}

const ROLE_RANK = { user: 0, moderator: 1, admin: 2 };

export function hasRole(user, role) {
  return (ROLE_RANK[user?.role] ?? 0) >= (ROLE_RANK[role] ?? 99);
}

export function requireRole(ctx, role) {
  const user = requireAuth(ctx);
  if (!hasRole(user, role)) throw new ForbiddenError('You do not have permission to do that.');
  return user;
}

/** Resolves an API key (`kq_<id>_<secret>`) to its owner, with scope checks. */
function resolveApiKey(raw) {
  const match = /^(kq_[a-z0-9]{4,32})[._]([A-Za-z0-9_-]{10,})$/.exec(raw);
  if (!match) return null;
  const [, keyId, secret] = match;
  const row = db.get('SELECT * FROM api_keys WHERE id = ? AND revoked_at IS NULL', [keyId]);
  if (!row) return null;
  if (row.key_hash !== sha256(secret)) return null;
  if (row.expires_at && Date.parse(`${row.expires_at.replace(' ', 'T')}Z`) < Date.now()) return null;
  db.run('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?', [keyId]);
  const user = db.users.findById(row.user_id);
  if (!user) return null;
  return { key: row, user };
}

export function createApiKey(userId, { name = 'API key', scopes = ['read'], expiresInDays = null }) {
  const keyId = `kq_${randomToken(10)}`;
  const secret = randomToken(32);
  db.run(
    `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      keyId,
      userId,
      String(name).slice(0, 60),
      keyId,
      sha256(secret),
      JSON.stringify(scopes),
      expiresInDays ? new Date(Date.now() + expiresInDays * 86400_000).toISOString().replace('T', ' ').slice(0, 19) : null,
    ],
  );
  return { keyId, key: `${keyId}.${secret}`, scopes };
}

export function listApiKeys(userId) {
  return db.all(
    'SELECT id, name, key_prefix, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
    [userId],
  );
}

export function revokeApiKey(userId, keyId) {
  const result = db.run('UPDATE api_keys SET revoked_at = datetime(\'now\') WHERE id = ? AND user_id = ?', [keyId, userId]);
  if (!result.changes) throw new ValidationError('Unknown API key.');
  return { ok: true };
}

/** Rejects payloads that try to set server-controlled fields. */
export function rejectPrivilegedFields(body, fields) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body ?? {}, field)) {
      throw new ValidationError(`Field "${field}" cannot be set by clients.`, { field });
    }
  }
  return body;
}

function randomToken(length) {
  return token(Math.ceil(length / 1.4))
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, length);
}

export { SESSION_COOKIE, REFRESH_COOKIE, CSRF_COOKIE };
