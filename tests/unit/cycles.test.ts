import { describe, it, expect } from 'vitest';
import { assertTransition, canEditReadings, canEditPrice, parseCycleInput } from '../../lib/cycles.js';
import { ConflictError, ValidationError } from '../../lib/errors.js';
import type { CycleStatus } from '../../lib/types.js';

const STATUSES: CycleStatus[] = ['open', 'issued', 'closed'];

describe('assertTransition', () => {
  it('allows open to issued and issued to closed', () => {
    expect(() => assertTransition('open', 'issued')).not.toThrow();
    expect(() => assertTransition('issued', 'closed')).not.toThrow();
  });

  it('refuses to skip issuing', () => {
    expect(() => assertTransition('open', 'closed')).toThrow(ConflictError);
  });

  it('refuses to reopen an issued or closed cycle', () => {
    expect(() => assertTransition('issued', 'open')).toThrow(ConflictError);
    expect(() => assertTransition('closed', 'open')).toThrow(ConflictError);
    expect(() => assertTransition('closed', 'issued')).toThrow(ConflictError);
  });

  it('refuses a transition to the same state', () => {
    for (const status of STATUSES) {
      expect(() => assertTransition(status, status)).toThrow(ConflictError);
    }
  });

  it('names both states in the message', () => {
    expect(() => assertTransition('closed', 'issued')).toThrow(/closed/);
    expect(() => assertTransition('closed', 'issued')).toThrow(/issued/);
  });

  it('permits exactly two of the nine possible transitions', () => {
    const allowed = STATUSES.flatMap((from) =>
      STATUSES.filter((to) => {
        try {
          assertTransition(from, to);
          return true;
        } catch {
          return false;
        }
      }).map((to) => `${from}->${to}`),
    );
    expect(allowed).toEqual(['open->issued', 'issued->closed']);
  });
});

describe('what each state allows', () => {
  it('only an open cycle takes readings', () => {
    expect(canEditReadings('open')).toBe(true);
    expect(canEditReadings('issued')).toBe(false);
    expect(canEditReadings('closed')).toBe(false);
  });

  it('only an open cycle takes a new price or rate', () => {
    expect(canEditPrice('open')).toBe(true);
    expect(canEditPrice('issued')).toBe(false);
    expect(canEditPrice('closed')).toBe(false);
  });
});

describe('parseCycleInput', () => {
  it('accepts a period, a price in cents and an LBP rate', () => {
    expect(parseCycleInput({ period: '2026-09', usdPerKwhCents: 30, lbpRate: 89_000 })).toEqual({
      period: '2026-09',
      usdPerKwhCents: 30,
      lbpRate: 89_000,
    });
  });

  it('rejects a malformed period', () => {
    expect(() => parseCycleInput({ period: '2026-9', usdPerKwhCents: 30, lbpRate: 89_000 })).toThrow(
      ValidationError,
    );
  });

  it('rejects a zero or negative price and rate', () => {
    expect(() => parseCycleInput({ period: '2026-09', usdPerKwhCents: 0, lbpRate: 89_000 })).toThrow(
      ValidationError,
    );
    expect(() => parseCycleInput({ period: '2026-09', usdPerKwhCents: 30, lbpRate: 0 })).toThrow(
      ValidationError,
    );
  });

  it('rejects a non-integer price, which is how a float would reach the money layer', () => {
    expect(() =>
      parseCycleInput({ period: '2026-09', usdPerKwhCents: 30.5, lbpRate: 89_000 }),
    ).toThrow(ValidationError);
  });

  it('rejects an unknown field', () => {
    expect(() =>
      parseCycleInput({ period: '2026-09', usdPerKwhCents: 30, lbpRate: 89_000, status: 'issued' }),
    ).toThrow(ValidationError);
  });
});
