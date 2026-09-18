/** Shared helpers for API route modules. */
export {
  sendJson,
  sendError,
  readJson,
  readBody,
  serializeCookie,
  parseCookies,
  verifyCsrf,
  clientIp,
  noCacheHeaders,
  RateLimiter,
} from '@kinetiq/shared';

import { sanitizeText, assertString, ValidationError } from '@kinetiq/shared';

export {
  assertEnum,
  assertInt,
  assertBoolean,
  assertString,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  PayloadTooLargeError,
  platformConfig,
} from '@kinetiq/shared';

/** Clamps and strips control characters from free-form text fields. */
export function limitUserInput(value, { max = 2000, field = 'value', required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`Missing ${field}.`, { field });
    return '';
  }
  return sanitizeText(assertString(value, { field, max }), { maxLength: max });
}

/** Pagination helper shared by list endpoints. */
export function pagination(ctx, { defaultLimit = 24, maxLimit = 100 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, Number(ctx.query.get('limit') ?? defaultLimit) || defaultLimit));
  const offset = Math.max(0, Number(ctx.query.get('offset') ?? 0) || 0);
  const page = Math.max(1, Number(ctx.query.get('page') ?? 0) || Math.floor(offset / limit) + 1);
  return { limit, offset: ctx.query.get('page') ? (page - 1) * limit : offset, page };
}

export function jsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export default { limitUserInput, pagination, jsonColumn };
