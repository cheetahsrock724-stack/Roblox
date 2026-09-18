/** Random identifiers. All entities use opaque IDs rather than usernames. */
import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ALPHABET_UPPER = ALPHABET.toUpperCase();

function encode(buffer, alphabet) {
  let out = '';
  for (const byte of buffer) out += alphabet[byte % alphabet.length];
  return out;
}

export function randomId(length = 16, { alphabet = ALPHABET } = {}) {
  return encode(crypto.randomBytes(Math.ceil((length * 1.4) | 0)), alphabet).slice(0, length);
}

export function token(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Prefixed identifiers keep logs readable: `usr_9f2k...`. */
export function id(prefix, length = 14) {
  return `${prefix}_${randomId(length)}`;
}

export const ids = {
  user: () => id('usr', 14),
  session: () => id('ses', 18),
  game: () => id('gam', 14),
  version: () => id('ver', 16),
  realm: () => id('rlm', 16),
  asset: () => id('ast', 16),
  item: () => id('itm', 14),
  badge: () => id('bdg', 14),
  group: () => id('grp', 14),
  report: () => id('rpt', 14),
  moderation: () => id('mod', 14),
  transaction: () => id('txn', 16),
  message: () => id('msg', 14),
  notification: () => id('ntf', 14),
  product: () => id('prd', 14),
  privateServer: () => id('psv', 14),
  apiKey: () => id('key', 20),
  app: () => id('app', 12),
};

export function shortId(value = '', head = 8) {
  return String(value).slice(0, head);
}

export default ids;
