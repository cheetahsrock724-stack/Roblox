/**
 * Cryptography helpers.
 *
 * Passwords: scrypt (memory-hard, from Node's audited OpenSSL bindings) with a per-password
 * random salt, stored as `scrypt$N$r$p$salt$hash`. Never plaintext, never reversible.
 * Verification is constant-time.
 */
import crypto from 'node:crypto';
import { sessionSecret, joinTokenSecret } from './config.js';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  let derived;
  try {
    derived = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmac(value, secret = sessionSecret()) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Short-lived signed tokens (join tokens, verification links, cursor pagination).
 * Format: base64url(payloadJson).base64url(hmacSha256)
 */
export function signPayload(payload, { secret, ttlSeconds = 300 } = {}) {
  const body = { ...payload, iat: Math.floor(Date.now() / 1000) };
  if (ttlSeconds) body.exp = body.iat + ttlSeconds;
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret || sessionSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifySignedPayload(tokenValue, { secret, clockToleranceSeconds = 5 } = {}) {
  if (typeof tokenValue !== 'string' || !tokenValue.includes('.')) return null;
  const [encoded, signature] = tokenValue.split('.');
  if (!encoded || !signature) return null;
  const expected = crypto
    .createHmac('sha256', secret || sessionSecret())
    .update(encoded)
    .digest('base64url');
  if (!timingSafeEqualString(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp + clockToleranceSeconds) return null;
  if (payload.nbf && now < payload.nbf - clockToleranceSeconds) return null;
  return payload;
}

/** Join tokens are signed with a dedicated secret and are always short lived. */
export function signJoinToken(payload, ttlSeconds = 120) {
  return signPayload(payload, { secret: joinTokenSecret(), ttlSeconds });
}

export function verifyJoinToken(tokenValue) {
  return verifySignedPayload(tokenValue, { secret: joinTokenSecret() });
}

export function hashAssetBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Derives a public (non-secret) key fingerprint for launcher manifests. */
export function signManifest(manifest) {
  return hmac(JSON.stringify(manifest));
}

export function randomCode(length = 6) {
  const digits = '0123456789';
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i += 1) out += digits[bytes[i] % digits.length];
  return out;
}
