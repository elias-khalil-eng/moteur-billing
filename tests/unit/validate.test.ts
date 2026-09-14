import { describe, it, expect } from 'vitest';
import {
  asObject,
  rejectUnknownFields,
  requiredString,
  optionalString,
  requiredInteger,
  optionalInteger,
  optionalBoolean,
  oneOf,
} from '../../lib/validate.js';
import { ValidationError } from '../../lib/errors.js';

describe('asObject', () => {
  it('returns a plain object body', () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
  });

  it('rejects a missing body, an array, or a primitive', () => {
    expect(() => asObject(undefined)).toThrow(ValidationError);
    expect(() => asObject(null)).toThrow(ValidationError);
    expect(() => asObject([1, 2])).toThrow(ValidationError);
    expect(() => asObject('text')).toThrow(ValidationError);
  });
});

describe('rejectUnknownFields', () => {
  it('passes when every field is expected', () => {
    expect(() => rejectUnknownFields({ a: 1, b: 2 }, ['a', 'b', 'c'])).not.toThrow();
  });

  it('names the unexpected field', () => {
    expect(() => rejectUnknownFields({ a: 1, sneaky: 2 }, ['a'])).toThrow(/sneaky/);
    expect(() => rejectUnknownFields({ a: 1, sneaky: 2 }, ['a'])).toThrow(ValidationError);
  });
});

describe('requiredString', () => {
  it('returns a trimmed value', () => {
    expect(requiredString({ name: '  Sami  ' }, 'name')).toBe('Sami');
  });

  it('rejects a missing, empty or non-string value, naming the field', () => {
    expect(() => requiredString({}, 'name')).toThrow(/name/);
    expect(() => requiredString({ name: '   ' }, 'name')).toThrow(ValidationError);
    expect(() => requiredString({ name: 5 }, 'name')).toThrow(ValidationError);
  });

  it('enforces a maximum length', () => {
    expect(() => requiredString({ name: 'abcdef' }, 'name', { maxLength: 3 })).toThrow(
      ValidationError,
    );
  });

  it('enforces a pattern', () => {
    expect(requiredString({ code: '1042' }, 'code', { pattern: /^\d+$/ })).toBe('1042');
    expect(() => requiredString({ code: '10a2' }, 'code', { pattern: /^\d+$/ })).toThrow(
      ValidationError,
    );
  });
});

describe('optionalString', () => {
  it('returns null for a missing or empty value', () => {
    expect(optionalString({}, 'zone')).toBeNull();
    expect(optionalString({ zone: null }, 'zone')).toBeNull();
    expect(optionalString({ zone: '  ' }, 'zone')).toBeNull();
  });

  it('returns a trimmed value when present', () => {
    expect(optionalString({ zone: ' A ' }, 'zone')).toBe('A');
  });

  it('rejects a non-string value', () => {
    expect(() => optionalString({ zone: 7 }, 'zone')).toThrow(ValidationError);
  });
});

describe('requiredInteger', () => {
  it('returns an integer', () => {
    expect(requiredInteger({ kwh: 1250 }, 'kwh')).toBe(1250);
  });

  it('rejects a float, a numeric string, or a missing value', () => {
    expect(() => requiredInteger({ kwh: 12.5 }, 'kwh')).toThrow(ValidationError);
    expect(() => requiredInteger({ kwh: '1250' }, 'kwh')).toThrow(ValidationError);
    expect(() => requiredInteger({}, 'kwh')).toThrow(/kwh/);
  });

  it('enforces min and max', () => {
    expect(() => requiredInteger({ kwh: -1 }, 'kwh', { min: 0 })).toThrow(ValidationError);
    expect(() => requiredInteger({ kwh: 10 }, 'kwh', { max: 9 })).toThrow(ValidationError);
  });
});

describe('optionalInteger and optionalBoolean', () => {
  it('return null when absent', () => {
    expect(optionalInteger({}, 'lbpRateUsed')).toBeNull();
    expect(optionalBoolean({}, 'meterReset')).toBeNull();
  });

  it('return the value when present', () => {
    expect(optionalInteger({ lbpRateUsed: 89000 }, 'lbpRateUsed')).toBe(89000);
    expect(optionalBoolean({ meterReset: true }, 'meterReset')).toBe(true);
  });

  it('reject a wrong type', () => {
    expect(() => optionalInteger({ lbpRateUsed: '89000' }, 'lbpRateUsed')).toThrow(ValidationError);
    expect(() => optionalBoolean({ meterReset: 'yes' }, 'meterReset')).toThrow(ValidationError);
  });
});

describe('oneOf', () => {
  it('returns an allowed value', () => {
    expect(oneOf({ status: 'active' }, 'status', ['active', 'suspended'] as const)).toBe('active');
  });

  it('rejects a value outside the set and lists the allowed values', () => {
    expect(() => oneOf({ status: 'gone' }, 'status', ['active', 'suspended'] as const)).toThrow(
      /active/,
    );
  });
});
