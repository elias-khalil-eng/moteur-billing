/**
 * Running costs: diesel, maintenance, salaries and everything else. Owner only.
 * Expenses are soft-deleted, like subscribers, so a deleted row still reconciles
 * against a past profit report.
 */

import { query, maybeOne } from './db.js';
import { NotFoundError, ValidationError } from './errors.js';
import { writeAudit, actorFields } from './audit.js';
import {
  asObject,
  oneOf,
  optionalString,
  rejectUnknownFields,
  requiredInteger,
  requiredString,
} from './validate.js';
import type { Actor, Expense, ExpenseCategory } from './types.js';

const CATEGORIES = ['diesel', 'maintenance', 'salary', 'other'] as const;
const EXPENSE_FIELDS = [
  'category',
  'amountUsdCents',
  'liters',
  'vendor',
  'spentAt',
  'note',
] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ExpenseInput {
  category: ExpenseCategory;
  amountUsdCents: number;
  liters: number | null;
  vendor: string | null;
  spentAt: string;
  note: string | null;
}

function readLiters(input: Record<string, unknown>, category: ExpenseCategory): number | null {
  const raw = input.liters;
  if (raw === undefined || raw === null) return null;
  if (category !== 'diesel') {
    throw new ValidationError('Only a diesel expense records litres', { field: 'liters' });
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new ValidationError('liters must be a number above zero', { field: 'liters' });
  }
  return raw;
}

function readSpentAt(input: Record<string, unknown>): string {
  const spentAt = requiredString(input, 'spentAt', {
    pattern: DATE_PATTERN,
    message: 'spentAt must be a date in YYYY-MM-DD form',
  });
  if (Number.isNaN(Date.parse(`${spentAt}T00:00:00Z`))) {
    throw new ValidationError('spentAt is not a real date', { field: 'spentAt' });
  }
  return spentAt;
}

export function parseExpenseInput(body: unknown): ExpenseInput {
  const input = asObject(body);
  rejectUnknownFields(input, EXPENSE_FIELDS);
  const category = oneOf(input, 'category', CATEGORIES);
  return {
    category,
    amountUsdCents: requiredInteger(input, 'amountUsdCents', { min: 1 }),
    liters: readLiters(input, category),
    vendor: optionalString(input, 'vendor', { maxLength: 120 }),
    spentAt: readSpentAt(input),
    note: optionalString(input, 'note', { maxLength: 240 }),
  };
}

/**
 * The category the row will end up with decides whether litres are allowed, so the
 * caller passes the stored one: a patch that sends litres alone must be judged
 * against the expense as it stands, not against an assumed default.
 */
export function parseExpensePatch(
  body: unknown,
  currentCategory: ExpenseCategory,
): Partial<ExpenseInput> {
  const input = asObject(body);
  rejectUnknownFields(input, EXPENSE_FIELDS);
  if (Object.keys(input).length === 0) {
    throw new ValidationError('There is nothing to change');
  }
  const patch: Partial<ExpenseInput> = {};
  if ('category' in input) patch.category = oneOf(input, 'category', CATEGORIES);
  if ('amountUsdCents' in input) {
    patch.amountUsdCents = requiredInteger(input, 'amountUsdCents', { min: 1 });
  }
  if ('liters' in input) patch.liters = readLiters(input, patch.category ?? currentCategory);
  if ('vendor' in input) patch.vendor = optionalString(input, 'vendor', { maxLength: 120 });
  if ('spentAt' in input) patch.spentAt = readSpentAt(input);
  if ('note' in input) patch.note = optionalString(input, 'note', { maxLength: 240 });
  return patch;
}

interface ExpenseRow extends Record<string, unknown> {
  id: number;
  category: ExpenseCategory;
  amount_usd_cents: number;
  liters: number | null;
  vendor: string | null;
  spent_at: Date;
  entered_by: number;
  note: string | null;
}

function toExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    category: row.category,
    amountUsdCents: row.amount_usd_cents,
    liters: row.liters,
    vendor: row.vendor,
    spentAt:
      row.spent_at instanceof Date ? row.spent_at.toISOString().slice(0, 10) : String(row.spent_at),
    enteredBy: row.entered_by,
    note: row.note,
  };
}

const EXPENSE_COLUMNS =
  'id, category, amount_usd_cents, liters, vendor, spent_at, entered_by, note';

export async function createExpense(body: unknown, actor: Actor): Promise<Expense> {
  const input = parseExpenseInput(body);
  const rows = await query<ExpenseRow>(
    `insert into expenses (category, amount_usd_cents, liters, vendor, spent_at, entered_by, note)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${EXPENSE_COLUMNS}`,
    [
      input.category,
      input.amountUsdCents,
      input.liters,
      input.vendor,
      input.spentAt,
      actor.id,
      input.note,
    ],
  );
  const expense = toExpense(rows[0]!);
  await writeAudit({
    ...actorFields(actor),
    action: 'expense.create',
    entity: 'expense',
    entityId: expense.id,
    after: expense,
  });
  return expense;
}

const PATCH_COLUMNS: Record<keyof ExpenseInput, string> = {
  category: 'category',
  amountUsdCents: 'amount_usd_cents',
  liters: 'liters',
  vendor: 'vendor',
  spentAt: 'spent_at',
  note: 'note',
};

export async function getExpense(id: number): Promise<Expense> {
  const row = await maybeOne<ExpenseRow>(
    `select ${EXPENSE_COLUMNS} from expenses where id = $1 and deleted_at is null`,
    [id],
  );
  if (row === null) throw new NotFoundError('expense', id);
  return toExpense(row);
}

export async function updateExpense(id: number, body: unknown, actor: Actor): Promise<Expense> {
  const before = await getExpense(id);
  const patch = parseExpensePatch(body, before.category);

  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
    const key = field as keyof ExpenseInput;
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      assignments.push(`${column} = $${values.length}`);
    }
  }
  values.push(id);

  const rows = await query<ExpenseRow>(
    `update expenses set ${assignments.join(', ')}
      where id = $${values.length} and deleted_at is null
      returning ${EXPENSE_COLUMNS}`,
    values as never,
  );
  const updated = rows[0];
  if (updated === undefined) throw new NotFoundError('expense', id);
  const after = toExpense(updated);
  await writeAudit({
    ...actorFields(actor),
    action: 'expense.update',
    entity: 'expense',
    entityId: id,
    before,
    after,
  });
  return after;
}

export async function softDeleteExpense(id: number, actor: Actor): Promise<void> {
  const before = await getExpense(id);
  await query('update expenses set deleted_at = now() where id = $1', [id]);
  await writeAudit({
    ...actorFields(actor),
    action: 'expense.delete',
    entity: 'expense',
    entityId: id,
    before,
  });
}

export interface ExpenseFilters {
  from?: string | null;
  to?: string | null;
  category?: string | null;
}

export async function listExpenses(filters: ExpenseFilters): Promise<Expense[]> {
  const category = filters.category
    ? oneOf({ category: filters.category }, 'category', CATEGORIES)
    : null;
  const rows = await query<ExpenseRow>(
    `select ${EXPENSE_COLUMNS} from expenses
      where deleted_at is null
        and ($1::date is null or spent_at >= $1)
        and ($2::date is null or spent_at <= $2)
        and ($3::text is null or category = $3)
      order by spent_at desc, id desc
      limit 500`,
    [filters.from ?? null, filters.to ?? null, category],
  );
  return rows.map(toExpense);
}
