import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  ensureSchema,
  resetTables,
  shutdown,
  call,
  createStaff,
  createSubscriber,
} from './helpers.js';
import { query } from '../../lib/db.js';

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetTables();
});

afterAll(async () => {
  await shutdown();
});

describe('POST /api/auth/staff/login', () => {
  it('returns a token and the staff profile for correct credentials', async () => {
    await createStaff('owner', 'sami', 'correct-horse');
    const res = await call<{ token: string; staff: { username: string; role: string } }>({
      method: 'POST',
      path: '/api/auth/staff/login',
      body: { username: 'sami', password: 'correct-horse' },
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.staff.username).toBe('sami');
    expect(res.body.staff.role).toBe('owner');
  });

  it('rejects a wrong password with 401 and no hint about which field was wrong', async () => {
    await createStaff('owner', 'sami', 'correct-horse');
    const res = await call<{ error: { code: string; message: string } }>({
      method: 'POST',
      path: '/api/auth/staff/login',
      body: { username: 'sami', password: 'wrong-horse' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error.message).not.toMatch(/password|username/i);
  });

  it('rejects an unknown username with 401', async () => {
    const res = await call({
      method: 'POST',
      path: '/api/auth/staff/login',
      body: { username: 'nobody', password: 'correct-horse' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a deactivated account', async () => {
    const staff = await createStaff('collector', 'gone', 'correct-horse');
    await query('update staff set is_active = false where id = $1', [staff.id]);
    const res = await call({
      method: 'POST',
      path: '/api/auth/staff/login',
      body: { username: 'gone', password: 'correct-horse' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a missing field with 400', async () => {
    const res = await call<{ error: { code: string } }>({
      method: 'POST',
      path: '/api/auth/staff/login',
      body: { username: 'sami' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

describe('POST /api/auth/subscriber/login', () => {
  it('returns a token and the subscriber profile for a correct code and PIN', async () => {
    await createSubscriber('1042', '482100');
    const res = await call<{ token: string; subscriber: { code: string } }>({
      method: 'POST',
      path: '/api/auth/subscriber/login',
      body: { code: '1042', pin: '482100' },
    });
    expect(res.status).toBe(200);
    expect(res.body.subscriber.code).toBe('1042');
  });

  it('rejects a wrong PIN with 401', async () => {
    await createSubscriber('1042', '482100');
    const res = await call({
      method: 'POST',
      path: '/api/auth/subscriber/login',
      body: { code: '1042', pin: '000000' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a soft deleted subscriber', async () => {
    const sub = await createSubscriber('1042', '482100');
    await query('update subscribers set deleted_at = now() where id = $1', [sub.id]);
    const res = await call({
      method: 'POST',
      path: '/api/auth/subscriber/login',
      body: { code: '1042', pin: '482100' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 429 on the sixth failed attempt for the same code', async () => {
    await createSubscriber('1042', '482100');
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = await call({
        method: 'POST',
        path: '/api/auth/subscriber/login',
        body: { code: '1042', pin: '000000' },
      });
      expect(failed.status).toBe(401);
    }
    const blocked = await call<{ error: { code: string } }>({
      method: 'POST',
      path: '/api/auth/subscriber/login',
      body: { code: '1042', pin: '000000' },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
  });

  it('blocks the correct PIN too once the identifier is rate limited', async () => {
    await createSubscriber('1042', '482100');
    for (let attempt = 0; attempt < 5; attempt++) {
      await call({
        method: 'POST',
        path: '/api/auth/subscriber/login',
        body: { code: '1042', pin: '000000' },
      });
    }
    const blocked = await call({
      method: 'POST',
      path: '/api/auth/subscriber/login',
      body: { code: '1042', pin: '482100' },
    });
    expect(blocked.status).toBe(429);
  });
});

describe('GET /api/me', () => {
  it('describes the signed in staff member', async () => {
    const owner = await createStaff('owner', 'sami');
    const res = await call<{ kind: string; role: string; username: string }>({
      path: '/api/me',
      token: owner.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('staff');
    expect(res.body.role).toBe('owner');
    expect(res.body.username).toBe('sami');
  });

  it('describes the signed in subscriber', async () => {
    const sub = await createSubscriber('1042');
    const res = await call<{ kind: string; code: string }>({
      path: '/api/me',
      token: sub.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('subscriber');
    expect(res.body.code).toBe('1042');
  });

  it('returns 401 without a token', async () => {
    const res = await call({ path: '/api/me' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a token whose staff account was deactivated', async () => {
    const collector = await createStaff('collector', 'gone');
    await query('update staff set is_active = false where id = $1', [collector.id]);
    const res = await call({ path: '/api/me', token: collector.token });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a subscriber token whose token_version was bumped', async () => {
    const sub = await createSubscriber('1042');
    await query('update subscribers set token_version = token_version + 1 where id = $1', [sub.id]);
    const res = await call({ path: '/api/me', token: sub.token });
    expect(res.status).toBe(401);
  });
});
