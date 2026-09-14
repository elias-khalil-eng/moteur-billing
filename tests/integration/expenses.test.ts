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

function addExpense(body: Record<string, unknown>, token = owner.token) {
  return call<{ expense: { id: number; category: string; amountUsdCents: number } }>({
    method: 'POST',
    path: '/api/expenses',
    token,
    body,
  });
}

describe('expenses', () => {
  it('records a diesel expense with litres', async () => {
    const res = await addExpense({
      category: 'diesel',
      amountUsdCents: 45_000,
      liters: 320.5,
      vendor: 'Station Aoun',
      spentAt: '2026-09-15',
    });
    expect(res.status).toBe(201);
    expect(res.body.expense.amountUsdCents).toBe(45_000);
  });

  it('lists and filters by date range and category', async () => {
    await addExpense({ category: 'diesel', amountUsdCents: 45_000, spentAt: '2026-09-15' });
    await addExpense({ category: 'salary', amountUsdCents: 20_000, spentAt: '2026-08-01' });

    const all = await call<{ expenses: unknown[] }>({ path: '/api/expenses', token: owner.token });
    expect(all.body.expenses).toHaveLength(2);

    const september = await call<{ expenses: { category: string }[] }>({
      path: '/api/expenses?from=2026-09-01&to=2026-09-30',
      token: owner.token,
    });
    expect(september.body.expenses.map((e) => e.category)).toEqual(['diesel']);

    const salaries = await call<{ expenses: { category: string }[] }>({
      path: '/api/expenses?category=salary',
      token: owner.token,
    });
    expect(salaries.body.expenses.map((e) => e.category)).toEqual(['salary']);
  });

  it('updates and soft deletes', async () => {
    const created = await addExpense({
      category: 'other',
      amountUsdCents: 1_000,
      spentAt: '2026-09-15',
    });
    const id = created.body.expense.id;

    const patched = await call<{ expense: { amountUsdCents: number } }>({
      method: 'PATCH',
      path: `/api/expenses/${id}`,
      token: owner.token,
      body: { amountUsdCents: 1_500 },
    });
    expect(patched.body.expense.amountUsdCents).toBe(1_500);

    const removed = await call({
      method: 'DELETE',
      path: `/api/expenses/${id}`,
      token: owner.token,
    });
    expect(removed.status).toBe(204);

    const rows = await query<{ deleted_at: Date | null }>(
      'select deleted_at from expenses where id = $1',
      [id],
    );
    expect(rows[0]!.deleted_at).not.toBeNull();

    const list = await call<{ expenses: unknown[] }>({ path: '/api/expenses', token: owner.token });
    expect(list.body.expenses).toHaveLength(0);
  });

  it('is closed to collectors on every verb', async () => {
    const created = await addExpense({
      category: 'other',
      amountUsdCents: 1_000,
      spentAt: '2026-09-15',
    });
    const id = created.body.expense.id;

    expect((await call({ path: '/api/expenses', token: collector.token })).status).toBe(403);
    expect(
      (
        await addExpense(
          { category: 'other', amountUsdCents: 100, spentAt: '2026-09-15' },
          collector.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call({
          method: 'PATCH',
          path: `/api/expenses/${id}`,
          token: collector.token,
          body: { amountUsdCents: 1 },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call({ method: 'DELETE', path: `/api/expenses/${id}`, token: collector.token })).status,
    ).toBe(403);
  });
});

describe('litres belong to diesel only, on edit as well as on create', () => {
  it('refuses litres added to a salary expense by a patch that does not name the category', async () => {
    const created = await addExpense({
      category: 'salary',
      amountUsdCents: 20_000,
      spentAt: '2026-09-15',
    });

    const res = await call<{ error: { details?: { field?: string } } }>({
      method: 'PATCH',
      path: `/api/expenses/${created.body.expense.id}`,
      token: owner.token,
      body: { liters: 300 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details?.field).toBe('liters');

    const rows = await query<{ liters: number | null }>(
      'select liters from expenses where id = $1',
      [created.body.expense.id],
    );
    expect(rows[0]!.liters).toBeNull();
  });

  it('still allows litres on a diesel expense patched without the category', async () => {
    const created = await addExpense({
      category: 'diesel',
      amountUsdCents: 45_000,
      spentAt: '2026-09-15',
    });
    const res = await call<{ expense: { liters: number | null } }>({
      method: 'PATCH',
      path: `/api/expenses/${created.body.expense.id}`,
      token: owner.token,
      body: { liters: 300 },
    });
    expect(res.status).toBe(200);
    expect(res.body.expense.liters).toBe(300);
  });
});
