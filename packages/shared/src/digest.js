/**
 * Pure-JS content hashing (no node:crypto) so the same code runs in the browser client.
 * This is an identity/versioning digest, not a cryptographic primitive: security-sensitive
 * hashing (passwords, tokens, asset integrity) lives in `crypto.js` and is server-only.
 */

const PRIME_A = 0x01000193n;
const PRIME_B = 0x00000100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function fnv1a64(bytes, seed) {
  let hash = seed;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * PRIME_A) & MASK64;
  }
  return hash;
}

function fnv1a64b(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * PRIME_B) & MASK64;
  }
  return hash;
}

export function utf8Bytes(value) {
  const str = String(value);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  // Fallback for exotic environments.
  const out = [];
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i);
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return new Uint8Array(out);
}

/** 128-bit content digest rendered as 32 hex characters. Deterministic across platforms. */
export function contentHash(value) {
  const bytes = value instanceof Uint8Array ? value : utf8Bytes(value);
  const a = fnv1a64(bytes, 0xcbf29ce484222325n);
  const b = fnv1a64b(bytes);
  const c = fnv1a64(bytes, 0x9e3779b97f4a7c15n);
  const d = fnv1a64b(bytes.slice().reverse());
  return [a, b, c, d].map((n) => n.toString(16).padStart(16, '0')).join('');
}

export function shortHash(value, length = 12) {
  return contentHash(value).slice(0, length);
}

export default contentHash;
