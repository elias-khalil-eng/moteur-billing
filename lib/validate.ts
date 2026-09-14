/**
 * Input validation used by every domain module. Each function names the field it
 * rejected, because "Invalid input" is never a good enough error message here:
 * a collector on a phone needs to know which number was wrong.
 */

import { ValidationError } from './errors.js';

export type Body = Record<string, unknown>;

export function asObject(value: unknown): Body {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('The request body must be a JSON object');
  }
  return value as Body;
}

export function rejectUnknownFields(body: Body, allowed: readonly string[]): void {
  const unknownFields = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknownFields.length > 0) {
    throw new ValidationError(`Unexpected field: ${unknownFields.join(', ')}`, {
      fields: unknownFields,
    });
  }
}

export interface StringRules {
  maxLength?: number;
  minLength?: number;
  pattern?: RegExp;
  message?: string;
}

function checkString(value: string, field: string, rules: StringRules): string {
  if (rules.minLength !== undefined && value.length < rules.minLength) {
    throw new ValidationError(
      rules.message ?? `${field} must be at least ${rules.minLength} characters`,
      { field },
    );
  }
  if (rules.maxLength !== undefined && value.length > rules.maxLength) {
    throw new ValidationError(
      rules.message ?? `${field} must be at most ${rules.maxLength} characters`,
      { field },
    );
  }
  if (rules.pattern !== undefined && !rules.pattern.test(value)) {
    throw new ValidationError(rules.message ?? `${field} is not in the expected format`, { field });
  }
  return value;
}

export function requiredString(body: Body, field: string, rules: StringRules = {}): string {
  const raw = body[field];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError(`${field} is required`, { field });
  }
  return checkString(raw.trim(), field, rules);
}

export function optionalString(body: Body, field: string, rules: StringRules = {}): string | null {
  const raw = body[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new ValidationError(`${field} must be text`, { field });
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : checkString(trimmed, field, rules);
}

export interface NumberRules {
  min?: number;
  max?: number;
  message?: string;
}

function checkInteger(value: unknown, field: string, rules: NumberRules): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} must be a whole number`, { field, value });
  }
  if (rules.min !== undefined && value < rules.min) {
    throw new ValidationError(rules.message ?? `${field} must be at least ${rules.min}`, {
      field,
      value,
    });
  }
  if (rules.max !== undefined && value > rules.max) {
    throw new ValidationError(rules.message ?? `${field} must be at most ${rules.max}`, {
      field,
      value,
    });
  }
  return value;
}

export function requiredInteger(body: Body, field: string, rules: NumberRules = {}): number {
  if (body[field] === undefined || body[field] === null) {
    throw new ValidationError(`${field} is required`, { field });
  }
  return checkInteger(body[field], field, rules);
}

export function optionalInteger(
  body: Body,
  field: string,
  rules: NumberRules = {},
): number | null {
  const raw = body[field];
  if (raw === undefined || raw === null) return null;
  return checkInteger(raw, field, rules);
}

export function optionalBoolean(body: Body, field: string): boolean | null {
  const raw = body[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'boolean') {
    throw new ValidationError(`${field} must be true or false`, { field });
  }
  return raw;
}

export function oneOf<T extends string>(body: Body, field: string, allowed: readonly T[]): T {
  const raw = body[field];
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`, { field });
  }
  return raw as T;
}

export function optionalOneOf<T extends string>(
  body: Body,
  field: string,
  allowed: readonly T[],
): T | null {
  if (body[field] === undefined || body[field] === null) return null;
  return oneOf(body, field, allowed);
}
