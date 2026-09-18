/**
 * Minimal HTTP router: exact and parameterised paths, per-method handlers, JSON error mapping.
 * No framework — a few hundred lines we fully control and can audit.
 */
import { sendError, isPlatformError } from '@kinetiq/shared';

export class Router {
  constructor() {
    this.routes = [];
    this.notFoundHandler = null;
  }

  add(method, pattern, handler, options = {}) {
    const regex = patternToRegex(pattern);
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      regex,
      paramNames: regex.paramNames,
      handler,
      options,
    });
    return this;
  }

  get(pattern, handler, options) {
    return this.add('GET', pattern, handler, options);
  }
  post(pattern, handler, options) {
    return this.add('POST', pattern, handler, options);
  }
  put(pattern, handler, options) {
    return this.add('PUT', pattern, handler, options);
  }
  patch(pattern, handler, options) {
    return this.add('PATCH', pattern, handler, options);
  }
  delete(pattern, handler, options) {
    return this.add('DELETE', pattern, handler, options);
  }

  /** Registers every method for a path (used for OPTIONS/preflight). */
  all(pattern, handler) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) this.add(method, pattern, handler);
    return this;
  }

  notFound(handler) {
    this.notFoundHandler = handler;
    return this;
  }

  match(method, pathname) {
    const upper = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== upper) continue;
      const match = route.regex.exec(pathname);
      if (match) {
        const params = {};
        for (let i = 1; i < match.length; i += 1) {
          params[route.paramNames[i - 1]] = decodeURIComponent(match[i]);
        }
        return { route, params };
      }
    }
    return null;
  }

  /** Express-style params: /games/:id/servers */
  static paramPattern(pattern) {
    return patternToRegex(pattern);
  }
}

function patternToRegex(pattern) {
  const names = [];
  const regexSource = pattern
    .split('/')
    .map((segment) => {
      if (!segment) return '';
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      if (segment === '*') {
        names.push('wildcard');
        return '(.*)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const regex = new RegExp(`^${regexSource}/?$`);
  regex.paramNames = names;
  return regex;
}

/** Wraps a handler so thrown platform errors become JSON responses and never crash the server. */
export function wrapHandler(handler, { logger } = {}) {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (error) {
      if (isPlatformError(error)) {
        sendError(ctx.res, error);
        return null;
      }
      if (logger) logger.error('unhandled route error', { error: error.message, stack: error.stack?.split('\n')[1] });
      sendError(ctx.res, {
        status: 500,
        expose: false,
        toJSON: () => ({ error: { code: 'internal_error', message: 'Something went wrong.' } }),
      });
      return null;
    }
  };
}

export default Router;
