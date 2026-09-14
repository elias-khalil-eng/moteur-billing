import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  hashSecret,
  verifySecret,
  generatePin,
  assertValidPin,
  signStaffToken,
  signSubscriberToken,
  verifyToken,
  bearerToken,
  requireRole,
  requireStaff,
  requireSubscriber,
} from '../../lib/auth.js';
import { UnauthorizedError, ForbiddenError, ValidationError } from '../../lib/errors.js';
import type { StaffActor, SubscriberActor } from '../../lib/types.js';

const owner: StaffActor = { kind: 'staff', id: 1, role: 'owner', name: 'Owner', username: 'owner' };
const collector: StaffActor = {
  kind: 'staff',
  id: 2,
  role: 'collector',
  name: 'Collector',
  username: 'coll',
};
const subscriber: SubscriberActor = { kind: 'subscriber', id: 7, code: '1042', name: 'Subscriber' };

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-not-for-production';
});

describe('hashSecret / verifySecret', () => {
  it('does not store the plaintext', async () => {
    const hash = await hashSecret('4821');
    expect(hash).not.toContain('4821');
  });

  it('verifies a correct secret and rejects a wrong one', async () => {
    const hash = await hashSecret('4821');
    expect(await verifySecret('4821', hash)).toBe(true);
    expect(await verifySecret('4822', hash)).toBe(false);
  });

  it('produces a different hash each time for the same input', async () => {
    expect(await hashSecret('4821')).not.toBe(await hashSecret('4821'));
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    expect(await verifySecret('4821', 'not-a-hash')).toBe(false);
  });
});

describe('PIN generation and validation', () => {
  it('generates a six digit numeric PIN', () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePin()).toMatch(/^\d{6}$/);
    }
  });

  it('does not generate the same PIN every time', () => {
    const pins = new Set(Array.from({ length: 30 }, () => generatePin()));
    expect(pins.size).toBeGreaterThan(1);
  });

  it('accepts a four to six digit PIN', () => {
    expect(() => assertValidPin('1234')).not.toThrow();
    expect(() => assertValidPin('123456')).not.toThrow();
  });

  it('rejects a PIN that is too short, too long, or not numeric', () => {
    expect(() => assertValidPin('123')).toThrow(ValidationError);
    expect(() => assertValidPin('1234567')).toThrow(ValidationError);
    expect(() => assertValidPin('12a4')).toThrow(ValidationError);
    expect(() => assertValidPin('')).toThrow(ValidationError);
    expect(() => assertValidPin(undefined)).toThrow(ValidationError);
  });
});

describe('tokens', () => {
  it('a staff token carries the subject, kind and role', () => {
    const token = signStaffToken(owner);
    const payload = verifyToken(token);
    expect(payload.sub).toBe('1');
    expect(payload.kind).toBe('staff');
    expect(payload.role).toBe('owner');
  });

  it('a staff token expires in eight hours', () => {
    const decoded = jwt.decode(signStaffToken(owner)) as { iat: number; exp: number };
    expect(decoded.exp - decoded.iat).toBe(8 * 60 * 60);
  });

  it('a subscriber token carries the token version and expires in thirty days', () => {
    const token = signSubscriberToken(subscriber, 3);
    const payload = verifyToken(token);
    expect(payload.sub).toBe('7');
    expect(payload.kind).toBe('subscriber');
    expect(payload.tv).toBe(3);
    const decoded = jwt.decode(token) as { iat: number; exp: number };
    expect(decoded.exp - decoded.iat).toBe(30 * 24 * 60 * 60);
  });

  it('rejects a tampered token', () => {
    const token = signStaffToken(collector);
    const tampered = `${token.slice(0, -3)}abc`;
    expect(() => verifyToken(tampered)).toThrow(UnauthorizedError);
  });

  it('rejects a token signed with another secret', () => {
    const foreign = jwt.sign({ kind: 'staff', role: 'owner' }, 'a-different-secret', {
      subject: '1',
      expiresIn: '8h',
    });
    expect(() => verifyToken(foreign)).toThrow(UnauthorizedError);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ kind: 'staff', role: 'owner' }, process.env.JWT_SECRET as string, {
      subject: '1',
      expiresIn: -10,
    });
    expect(() => verifyToken(expired)).toThrow(UnauthorizedError);
  });

  it('rejects a token whose kind is not staff or subscriber', () => {
    const odd = jwt.sign({ kind: 'robot' }, process.env.JWT_SECRET as string, {
      subject: '1',
      expiresIn: '8h',
    });
    expect(() => verifyToken(odd)).toThrow(UnauthorizedError);
  });
});

describe('bearerToken', () => {
  it('reads a bearer token from the authorization header', () => {
    const headers = new Headers({ authorization: 'Bearer abc.def.ghi' });
    expect(bearerToken(headers)).toBe('abc.def.ghi');
  });

  it('accepts a lowercase scheme', () => {
    expect(bearerToken(new Headers({ authorization: 'bearer abc' }))).toBe('abc');
  });

  it('returns null when the header is missing or another scheme', () => {
    expect(bearerToken(new Headers())).toBeNull();
    expect(bearerToken(new Headers({ authorization: 'Basic abc' }))).toBeNull();
    expect(bearerToken(new Headers({ authorization: 'Bearer' }))).toBeNull();
  });
});

describe('role gates', () => {
  it('requireRole lets an owner through and stops a collector', () => {
    expect(() => requireRole(owner, 'owner')).not.toThrow();
    expect(() => requireRole(collector, 'owner')).toThrow(ForbiddenError);
  });

  it('requireRole lets a collector through a collector gate', () => {
    expect(() => requireRole(collector, 'collector')).not.toThrow();
    expect(() => requireRole(owner, 'collector')).not.toThrow();
  });

  it('requireRole stops a subscriber at any staff gate', () => {
    expect(() => requireRole(subscriber, 'collector')).toThrow(ForbiddenError);
    expect(() => requireRole(subscriber, 'owner')).toThrow(ForbiddenError);
  });

  it('requireStaff returns the staff actor and rejects a subscriber or nobody', () => {
    expect(requireStaff(collector)).toBe(collector);
    expect(() => requireStaff(subscriber)).toThrow(ForbiddenError);
    expect(() => requireStaff(null)).toThrow(UnauthorizedError);
  });

  it('requireSubscriber returns the subscriber actor and rejects staff or nobody', () => {
    expect(requireSubscriber(subscriber)).toBe(subscriber);
    expect(() => requireSubscriber(owner)).toThrow(ForbiddenError);
    expect(() => requireSubscriber(null)).toThrow(UnauthorizedError);
  });
});

describe('token algorithm', () => {
  it('rejects an unsigned token that claims alg: none', () => {
    const unsigned = jwt.sign({ kind: 'staff', role: 'owner' }, '', {
      algorithm: 'none',
      subject: '1',
      expiresIn: '8h',
    });
    expect(() => verifyToken(unsigned)).toThrow(UnauthorizedError);
  });

  it('accepts only HS256, so a token signed with another algorithm is refused', () => {
    const decodedHeader = JSON.parse(
      Buffer.from(signStaffToken(owner).split('.')[0]!, 'base64url').toString('utf8'),
    ) as { alg: string };
    expect(decodedHeader.alg).toBe('HS256');

    const hs512 = jwt.sign({ kind: 'staff', role: 'owner' }, process.env.JWT_SECRET as string, {
      algorithm: 'HS512',
      subject: '1',
      expiresIn: '8h',
    });
    expect(() => verifyToken(hs512)).toThrow(UnauthorizedError);
  });
});
