/**
 * Input validation. Every API boundary funnels through here so malicious payloads are rejected
 * before they reach SQL, the filesystem, or game scripts.
 */
import { ValidationError } from './errors.js';

const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'system', 'root', 'support', 'staff',
  'kinetiq', 'official', 'help', 'security', 'null', 'undefined', 'me', 'you', 'api',
]);

export const RESERVED_NAMES = RESERVED_USERNAMES;

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const DISPLAY_NAME_RE = /^[\p{L}\p{N} _.'\-]{1,32}$/u;

export function assertUsername(value) {
  const username = String(value ?? '').trim();
  if (!USERNAME_RE.test(username)) {
    throw new ValidationError('Usernames must be 3-20 characters: letters, numbers, and underscores only.', {
      field: 'username',
    });
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    throw new ValidationError('That username is reserved.', { field: 'username' });
  }
  return username;
}

export function assertDisplayName(value, fallback) {
  const display = String(value ?? '').trim();
  if (!display) return fallback;
  if (!DISPLAY_NAME_RE.test(display)) {
    throw new ValidationError('Display names may contain letters, numbers, spaces, and . _ \' - (max 32).', {
      field: 'displayName',
    });
  }
  return display;
}

export function assertPassword(value) {
  const password = String(value ?? '');
  if (password.length < 10) {
    throw new ValidationError('Passwords must be at least 10 characters.', { field: 'password' });
  }
  if (password.length > 200) {
    throw new ValidationError('Passwords must be at most 200 characters.', { field: 'password' });
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) {
    throw new ValidationError('Passwords must mix at least two of: lowercase, uppercase, digits, symbols.', {
      field: 'password',
    });
  }
  const weak = ['password', 'letmein', 'qwerty', 'kinetiq', '123456', 'iloveyou'];
  if (weak.some((w) => password.toLowerCase().includes(w))) {
    throw new ValidationError('That password is too common.', { field: 'password' });
  }
  return password;
}

export function assertEmail(value, { required = false } = {}) {
  const email = String(value ?? '').trim();
  if (!email) {
    if (required) throw new ValidationError('Email is required.', { field: 'email' });
    return null;
  }
  if (email.length > 254 || !/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) {
    throw new ValidationError('That email address looks invalid.', { field: 'email' });
  }
  return email.toLowerCase();
}

export function assertString(value, { field = 'value', min = 0, max = 500, trim = true, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`Missing ${field}.`, { field });
    return null;
  }
  let out = String(value);
  if (trim) out = out.trim();
  if (out.length < min) throw new ValidationError(`${field} must be at least ${min} characters.`, { field });
  if (out.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`, { field });
  return out;
}

export function assertBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function assertInt(value, { field = 'value', min = -Infinity, max = Infinity, fallback = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`Missing ${field}.`, { field });
  }
  const num = Number(value);
  if (!Number.isFinite(num)) throw new ValidationError(`${field} must be a number.`, { field });
  const rounded = Math.trunc(num);
  if (rounded < min || rounded > max) {
    throw new ValidationError(`${field} must be between ${min} and ${max}.`, { field });
  }
  return rounded;
}

export function assertNumber(value, { field = 'value', min = -Infinity, max = Infinity, fallback = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`Missing ${field}.`, { field });
  }
  const num = Number(value);
  if (!Number.isFinite(num)) throw new ValidationError(`${field} must be a finite number.`, { field });
  if (num < min || num > max) throw new ValidationError(`${field} must be between ${min} and ${max}.`, { field });
  return num;
}

export function assertEnum(value, allowed, { field = 'value', fallback = undefined } = {}) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const normalized = String(value ?? '');
  if (!allowed.includes(normalized)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}.`, { field, allowed });
  }
  return normalized;
}

export function assertId(value, { field = 'id', prefix = undefined } = {}) {
  const out = String(value ?? '').trim();
  const pattern = prefix ? new RegExp(`^${prefix}_[a-z0-9]{4,40}$`) : /^[a-z]{3}_[a-z0-9]{4,40}$/;
  if (!pattern.test(out)) throw new ValidationError(`Invalid ${field}.`, { field });
  return out;
}

export function assertArray(value, { field = 'value', max = 1000, of = undefined } = {}) {
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array.`, { field });
  if (value.length > max) throw new ValidationError(`${field} must contain at most ${max} items.`, { field });
  return of ? value.map((item) => of(item)) : value;
}

/** Strips control characters that enable log injection / terminal escapes. */
export function sanitizeText(value, { maxLength = 5000 } = {}) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maxLength);
}

/** Removes `<`, `>` and quotes' HTML meaning; the web UI also escapes on render. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Safe path segment for asset storage: never derived from user input verbatim. */
export function assertSafeSegment(value) {
  const out = String(value ?? '');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(out) || out.startsWith('.')) {
    throw new ValidationError('Invalid path segment.');
  }
  return out;
}

export function assertSlug(value, { field = 'slug', max = 64 } = {}) {
  const out = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  if (!out) throw new ValidationError(`Invalid ${field}.`, { field });
  return out;
}

export function assertUrl(value, { field = 'url', allowRelative = false } = {}) {
  const out = String(value ?? '').trim();
  if (allowRelative && out.startsWith('/')) return out;
  let parsed;
  try {
    parsed = new URL(out);
  } catch {
    throw new ValidationError(`${field} must be a valid URL.`, { field });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ValidationError(`${field} must use http or https.`, { field });
  }
  return parsed.toString();
}
