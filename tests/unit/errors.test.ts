import { describe, it, expect } from 'vitest';
import {
  HttpError,
  ValidationError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  RateLimitError,
  toErrorBody,
} from '../../lib/errors.js';

describe('errors', () => {
  it('HttpError carries status, code and message', () => {
    const e = new HttpError(418, 'teapot', 'I am a teapot');
    expect(e.status).toBe(418);
    expect(e.code).toBe('teapot');
    expect(e.message).toBe('I am a teapot');
    expect(e instanceof Error).toBe(true);
  });

  it('ValidationError is 400 and keeps field details', () => {
    const e = new ValidationError('current value is below previous value', {
      field: 'currentValue',
      previousValue: 900,
      currentValue: 800,
    });
    expect(e.status).toBe(400);
    expect(e.code).toBe('validation_error');
    expect(e.details).toEqual({ field: 'currentValue', previousValue: 900, currentValue: 800 });
  });

  it('NotFoundError is 404 and names the entity', () => {
    const e = new NotFoundError('subscriber', 42);
    expect(e.status).toBe(404);
    expect(e.code).toBe('not_found');
    expect(e.message).toContain('subscriber');
    expect(e.details).toEqual({ entity: 'subscriber', id: 42 });
  });

  it('ConflictError is 409, Unauthorized 401, Forbidden 403, RateLimit 429', () => {
    expect(new ConflictError('cycle already issued').status).toBe(409);
    expect(new UnauthorizedError().status).toBe(401);
    expect(new ForbiddenError().status).toBe(403);
    expect(new RateLimitError(900).status).toBe(429);
    expect(new RateLimitError(900).details).toEqual({ retryAfterSeconds: 900 });
  });

  it('toErrorBody shapes a known error as { error: { code, message, details } }', () => {
    const body = toErrorBody(new ValidationError('bad', { field: 'pin' }));
    expect(body).toEqual({
      error: { code: 'validation_error', message: 'bad', details: { field: 'pin' } },
    });
  });

  it('toErrorBody hides the message of an unknown error', () => {
    const body = toErrorBody(new Error('connection string postgres://user:pw@host'));
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).not.toContain('postgres://');
  });

  it('toErrorBody omits details when there are none', () => {
    const body = toErrorBody(new ConflictError('nope'));
    expect(Object.prototype.hasOwnProperty.call(body.error, 'details')).toBe(false);
  });
});

describe('bilingual messages', () => {
  it('carries an Arabic message alongside the English one', () => {
    const e = new ValidationError('A note is required', {
      field: 'note',
      messageAr: 'الملاحظة مطلوبة',
    });
    const body = toErrorBody(e);
    expect(body.error.message).toBe('A note is required');
    expect(body.error.messageAr).toBe('الملاحظة مطلوبة');
    expect(body.error.details).toEqual({ field: 'note' });
  });

  it('leaves messageAr out when the error has none', () => {
    const body = toErrorBody(new ConflictError('nope'));
    expect(Object.prototype.hasOwnProperty.call(body.error, 'messageAr')).toBe(false);
  });

  it('never leaks an Arabic message for an unknown error either', () => {
    const body = toErrorBody(new Error('postgres://user:pw@host'));
    expect(body.error.messageAr).toBe('حدث خطأ. حاول مرة أخرى.');
    expect(body.error.message).not.toContain('postgres://');
  });
});
