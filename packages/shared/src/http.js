/** HTTP helpers shared by the API gateway: JSON responses, cookies, CSRF, rate limiting. */
import crypto from 'node:crypto';
import { RateLimitError } from './errors.js';

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendError(res, error) {
  const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
  const expose = error?.expose !== false;
  const payload = expose
    ? error?.toJSON
      ? error.toJSON()
      : { error: { code: 'error', message: String(error?.message || 'Error') } }
    : { error: { code: 'internal_error', message: 'Something went wrong.' } };
  if (error?.retryAfter) payload.error.details = { retryAfter: error.retryAfter };
  sendJson(res, status, payload);
}

export function readBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, options = {}) {
  const raw = await readBody(req, options);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Malformed JSON body'), { status: 400, code: 'bad_json', expose: true });
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  return parts.join('; ');
}

export function generateCsrfToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Constant-time CSRF comparison (double-submit cookie pattern). */
export function verifyCsrf(cookieValue, headerValue) {
  if (!cookieValue || !headerValue) return false;
  const a = Buffer.from(String(cookieValue));
  const b = Buffer.from(String(headerValue));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sliding-window rate limiter (in-memory, per key). Used for login attempts, chat, remote
 * events, uploads and general API abuse control.
 */
export class RateLimiter {
  constructor({ windowMs, max, name = 'limiter' }) {
    this.windowMs = windowMs;
    this.max = max;
    this.name = name;
    this.buckets = new Map();
    this.lastSweep = Date.now();
  }

  check(key, cost = 1) {
    const now = Date.now();
    if (now - this.lastSweep > this.windowMs) this.sweep(now);
    const bucket = this.buckets.get(key) ?? { count: 0, resetAt: now + this.windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + this.windowMs;
    }
    bucket.count += cost;
    this.buckets.set(key, bucket);
    if (bucket.count > this.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      throw new RateLimitError(`Rate limit exceeded for ${this.name}.`, retryAfter);
    }
    return { remaining: Math.max(0, this.max - bucket.count), resetAt: bucket.resetAt };
  }

  /** Non-throwing variant for places where we prefer to degrade gracefully. */
  allow(key, cost = 1) {
    try {
      this.check(key, cost);
      return true;
    } catch {
      return false;
    }
  }

  sweep(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (now > bucket.resetAt) this.buckets.delete(key);
    }
    this.lastSweep = now;
  }

  reset(key) {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export function noCacheHeaders() {
  return {
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  };
}
