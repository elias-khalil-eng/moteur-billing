import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ensureSchema, resetTables, shutdown, call, createStaff } from './helpers.js';
import { query } from '../../lib/db.js';
import type { StaffFixture } from './helpers.js';

let owner: StaffFixture;
let collector: StaffFixture;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetTables();
  owner = await createStaff('owner', 'sami');
  collector = await createStaff('collector', 'nabil');
});

afterAll(async () => {
  await shutdown();
});

describe('GET /api/staff', () => {
  it('lists staff without any password material', async () => {
    const res = await call<{ staff: { username: string; role: string }[] }>({
      path: '/api/staff',
      token: owner.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.staff.map((s) => s.username).sort()).toEqual(['nabil', 'sami']);
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('rejects a collector with 403', async () => {
    const res = await call({ path: '/api/staff', token: collector.token });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/staff', () => {
  it('creates an account that can sign in', async () => {
    const res = await call<{ staff: { id: number; username: string; role: string } }>({
      method: 'POST',
      path: '/api/staff',
      token: owner.token,
      body: { username: 'rana', name: 'Rana', role: 'collector', password: 'a-long-password' },
    });
    expect(res.status).toBe(201);
    expect(res.body.staff.role).toBe('collector');

    const login = await call({
      method: 'POST',
      path: '/api/auth/staff/login',
      body: { username: 'rana', password: 'a-long-password' },
    });
    expect(login.status).toBe(200);
  });

  it('refuses a duplicate username', async () => {
    const res = await call({
      method: 'POST',
      path: '/api/staff',
      token: owner.token,
      body: { username: 'nabil', name: 'Someone', role: 'collector', password: 'a-long-password' },
    });
    expect(res.status).toBe(409);
  });

  it('refuses a short password and an unknown role', async () => {
    const short = await call({
      method: 'POST',
      path: '/api/staff',
      token: owner.token,
      body: { username: 'rana', name: 'Rana', role: 'collector', password: 'short' },
    });
    expect(short.status).toBe(400);

    const role = await call({
      method: 'POST',
      path: '/api/staff',
      token: owner.token,
      body: { username: 'rana', name: 'Rana', role: 'admin', password: 'a-long-password' },
    });
    expect(role.status).toBe(400);
  });

  it('rejects a collector with 403', async () => {
    const res = await call({
      method: 'POST',
      path: '/api/staff',
      token: collector.token,
      body: { username: 'rana', name: 'Rana', role: 'collector', password: 'a-long-password' },
    });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/staff/:id', () => {
  it('changes the name, the role and whether the account is active', async () => {
    const res = await call<{ staff: { name: string; role: string; isActive: boolean } }>({
      method: 'PATCH',
      path: `/api/staff/${collector.id}`,
      token: owner.token,
      body: { name: 'Nabil H.', role: 'owner', isActive: false },
    });
    expect(res.status).toBe(200);
    expect(res.body.staff.name).toBe('Nabil H.');
    expect(res.body.staff.role).toBe('owner');
    expect(res.body.staff.isActive).toBe(false);
  });

  it('refuses to deactivate the last active owner', async () => {
    const res = await call<{ error: { code: string } }>({
      method: 'PATCH',
      path: `/api/staff/${owner.id}`,
      token: owner.token,
      body: { isActive: false },
    });
    expect(res.status).toBe(409);

    const rows = await query<{ is_active: boolean }>('select is_active from staff where id = $1', [
      owner.id,
    ]);
    expect(rows[0]!.is_active).toBe(true);
  });

  it('refuses to demote the last owner', async () => {
    const res = await call({
      method: 'PATCH',
      path: `/api/staff/${owner.id}`,
      token: owner.token,
      body: { role: 'collector' },
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/staff/:id/password', () => {
  it('sets a new password and invalidates the old one', async () => {
    const res = await call({
      method: 'POST',
      path: `/api/staff/${collector.id}/password`,
      token: owner.token,
      body: { password: 'another-long-password' },
    });
    expect(res.status).toBe(204);

    const withOld = await call({
      method: 'POST',
      path: '/api/auth/staff/login',
      body: { username: 'nabil', password: collector.password },
    });
    expect(withOld.status).toBe(401);

    const withNew = await call({
      method: 'POST',
      path: '/api/auth/staff/login',
      body: { username: 'nabil', password: 'another-long-password' },
    });
    expect(withNew.status).toBe(200);
  });

  it('rejects a collector changing anyone password', async () => {
    const res = await call({
      method: 'POST',
      path: `/api/staff/${collector.id}/password`,
      token: collector.token,
      body: { password: 'another-long-password' },
    });
    expect(res.status).toBe(403);
  });
});
