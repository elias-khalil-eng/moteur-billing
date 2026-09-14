/**
 * Domain error types. Every error that should reach the client with a meaningful
 * status and code extends HttpError; anything else is reported as 500 with its
 * message withheld, because unknown errors carry connection strings and stack detail.
 */

export type ErrorDetails = Record<string, unknown>;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetails | undefined;

  constructor(status: number, code: string, message: string, details?: ErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details?: ErrorDetails) {
    super(400, 'validation_error', message, details);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Authentication required', details?: ErrorDetails) {
    super(401, 'unauthorized', message, details);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'You do not have permission to do that', details?: ErrorDetails) {
    super(403, 'forbidden', message, details);
  }
}

export class NotFoundError extends HttpError {
  constructor(entity: string, id?: string | number) {
    super(404, 'not_found', `No such ${entity}`, id === undefined ? { entity } : { entity, id });
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: ErrorDetails) {
    super(409, 'conflict', message, details);
  }
}

export class RateLimitError extends HttpError {
  constructor(retryAfterSeconds: number, message = 'Too many attempts. Try again later.') {
    super(429, 'rate_limited', message, { retryAfterSeconds });
  }
}

export interface ErrorBody {
  error: { code: string; message: string; messageAr?: string; details?: ErrorDetails };
}

/**
 * A message that reaches a subscriber has to be readable in Arabic, so an error may
 * carry `messageAr` in its details. It is lifted out of details here: the client
 * picks the message for the language it is showing, and the rest of details stays
 * machine-readable.
 */
export function toErrorBody(err: unknown): ErrorBody {
  if (err instanceof HttpError) {
    const { messageAr, ...details } = err.details ?? {};
    const hasDetails = Object.keys(details).length > 0;
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(typeof messageAr === 'string' ? { messageAr } : {}),
        ...(hasDetails ? { details } : {}),
      },
    };
  }
  return {
    error: {
      code: 'internal_error',
      message: 'Something went wrong',
      messageAr: 'حدث خطأ. حاول مرة أخرى.',
    },
  };
}

export function statusOf(err: unknown): number {
  return err instanceof HttpError ? err.status : 500;
}
