/** Browser-safe ID generation (Web Crypto / Math.random fallback). */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function randomId(length = 16) {
  const bytes = randomBytes(Math.ceil(length * 1.4));
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out.slice(0, length);
}

export function token(bytes = 32) {
  return randomId(bytes * 2);
}

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
