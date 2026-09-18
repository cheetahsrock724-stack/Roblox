/** Typed errors that map cleanly onto HTTP status codes and API error payloads. */

export class PlatformError extends Error {
  constructor(message, { status = 400, code = 'bad_request', details = undefined, expose = true } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export class ValidationError extends PlatformError {
  constructor(message = 'Invalid input', details) {
    super(message, { status: 422, code: 'validation_error', details });
  }
}

export class UnauthorizedError extends PlatformError {
  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: 'unauthorized' });
  }
}

export class ForbiddenError extends PlatformError {
  constructor(message = 'Not allowed') {
    super(message, { status: 403, code: 'forbidden' });
  }
}

export class NotFoundError extends PlatformError {
  constructor(message = 'Not found') {
    super(message, { status: 404, code: 'not_found' });
  }
}

export class ConflictError extends PlatformError {
  constructor(message = 'Already exists', details) {
    super(message, { status: 409, code: 'conflict', details });
  }
}

export class RateLimitError extends PlatformError {
  constructor(message = 'Too many requests', retryAfter = 60) {
    super(message, { status: 429, code: 'rate_limited', details: { retryAfter } });
    this.retryAfter = retryAfter;
  }
}

export class PayloadTooLargeError extends PlatformError {
  constructor(message = 'Payload too large') {
    super(message, { status: 413, code: 'payload_too_large' });
  }
}

export class InternalError extends PlatformError {
  constructor(message = 'Internal error') {
    super(message, { status: 500, code: 'internal_error', expose: false });
  }
}

export function isPlatformError(error) {
  return error instanceof PlatformError;
}
