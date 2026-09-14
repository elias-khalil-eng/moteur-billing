/**
 * The billing cycle lifecycle:
 *
 *     open ──issue──> issued ──close──> closed
 *
 * Issuing itself lives in billing.ts, because it writes bills; this module owns
 * the states, the transitions between them, and everything a cycle knows about
 * itself. Only one cycle may be open at a time, which the database also enforces.
 */

import { query, maybeOne } from './db.js';
import { ConflictError, NotFoundError } from './errors.js';
import { assertPeriod } from './dates.js';
import { writeAudit, actorFields } from './audit.js';
import { asObject, rejectUnknownFields, requiredInteger, requiredString } from './validate.js';
import type { Actor, BillingCycle, CycleProgress, CycleStatus } from './types.js';

const ALLOWED_TRANSITIONS: Record<CycleStatus, CycleStatus[]> = {
  open: ['issued'],
  issued: ['closed'],
  closed: [],
};

export function assertTransition(from: CycleStatus, to: CycleStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new ConflictError(`A ${from} cycle cannot become ${to}`, { from, to });
  }
}

export function canEditReadings(status: CycleStatus): boolean {
  return status === 'open';
}

export function canEditPrice(status: CycleStatus): boolean {
  return status === 'open';
}

export interface CycleInput {
  period: string;
  usdPerKwhCents: number;
  lbpRate: number;
}

const CYCLE_FIELDS = ['period', 'usdPerKwhCents', 'lbpRate'] as const;

export function parseCycleInput(body: unknown): CycleInput {
  const input = asObject(body);
  rejectUnknownFields(input, CYCLE_FIELDS);
  const period = requiredString(input, 'period');
  assertPeriod(period);
  return {
    period,
    usdPerKwhCents: requiredInteger(input, 'usdPerKwhCents', { min: 1 }),
    lbpRate: requiredInteger(input, 'lbpRate', { min: 1 }),
  };
}

export function parseCyclePatch(body: unknown): Partial<Omit<CycleInput, 'period'>> {
  const input = asObject(body);
  rejectUnknownFields(input, ['usdPerKwhCents', 'lbpRate']);
  const patch: Partial<Omit<CycleInput, 'period'>> = {};
  if ('usdPerKwhCents' in input) {
    patch.usdPerKwhCents = requiredInteger(input, 'usdPerKwhCents', { min: 1 });
  }
  if ('lbpRate' in input) patch.lbpRate = requiredInteger(input, 'lbpRate', { min: 1 });
  if (Object.keys(patch).length === 0) {
    throw new ConflictError('There is nothing to change');
  }
  return patch;
}

interface CycleRow extends Record<string, unknown> {
  id: number;
  period: string;
  usd_per_kwh_cents: number;
  lbp_rate: number;
  status: CycleStatus;
  opened_at: Date;
  issued_at: Date | null;
  closed_at: Date | null;
  opened_by: number;
}

export function toCycle(row: CycleRow): BillingCycle {
  return {
    id: row.id,
    period: row.period,
    usdPerKwhCents: row.usd_per_kwh_cents,
    lbpRate: row.lbp_rate,
    status: row.status,
    openedAt: row.opened_at.toISOString(),
    issuedAt: row.issued_at === null ? null : row.issued_at.toISOString(),
    closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
    openedBy: row.opened_by,
  };
}

const CYCLE_COLUMNS =
  'id, period, usd_per_kwh_cents, lbp_rate, status, opened_at, issued_at, closed_at, opened_by';

export async function getCycle(id: number): Promise<BillingCycle> {
  const row = await maybeOne<CycleRow>(`select ${CYCLE_COLUMNS} from billing_cycles where id = $1`, [
    id,
  ]);
  if (row === null) throw new NotFoundError('cycle', id);
  return toCycle(row);
}

export async function listCycles(): Promise<BillingCycle[]> {
  const rows = await query<CycleRow>(
    `select ${CYCLE_COLUMNS} from billing_cycles order by period desc`,
  );
  return rows.map(toCycle);
}

/** The cycle staff are working in: the open one, or the most recent if none is open. */
export async function getCurrentCycle(): Promise<BillingCycle | null> {
  const row = await maybeOne<CycleRow>(
    `select ${CYCLE_COLUMNS} from billing_cycles
      order by (status = 'open') desc, period desc limit 1`,
  );
  return row === null ? null : toCycle(row);
}

export async function openCycle(body: unknown, actor: Actor): Promise<BillingCycle> {
  const input = parseCycleInput(body);

  const open = await maybeOne<{ period: string }>(
    "select period from billing_cycles where status = 'open'",
  );
  if (open !== null) {
    throw new ConflictError(`Cycle ${open.period} is still open. Issue and close it first.`, {
      openPeriod: open.period,
      messageAr: `دورة ${open.period} ما زالت مفتوحة. أصدر فواتيرها وأقفلها أولًا.`,
    });
  }
  const existing = await maybeOne<{ id: number }>(
    'select id from billing_cycles where period = $1',
    [input.period],
  );
  if (existing !== null) {
    throw new ConflictError(`Cycle ${input.period} already exists`, { field: 'period' });
  }

  const rows = await query<CycleRow>(
    `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, opened_by)
     values ($1, $2, $3, $4) returning ${CYCLE_COLUMNS}`,
    [input.period, input.usdPerKwhCents, input.lbpRate, actor.id],
  );
  const cycle = toCycle(rows[0]!);
  await writeAudit({
    ...actorFields(actor),
    action: 'cycle.open',
    entity: 'cycle',
    entityId: cycle.id,
    after: cycle,
  });
  return cycle;
}

export async function updateCycle(id: number, body: unknown, actor: Actor): Promise<BillingCycle> {
  const patch = parseCyclePatch(body);
  const before = await getCycle(id);
  if (!canEditPrice(before.status)) {
    throw new ConflictError('The price and rate can only change while the cycle is open', {
      status: before.status,
      messageAr: 'لا يمكن تعديل السعر وسعر الصرف إلا والدورة مفتوحة',
    });
  }

  const rows = await query<CycleRow>(
    `update billing_cycles
        set usd_per_kwh_cents = coalesce($1, usd_per_kwh_cents),
            lbp_rate = coalesce($2, lbp_rate)
      where id = $3 and status = 'open'
      returning ${CYCLE_COLUMNS}`,
    [patch.usdPerKwhCents ?? null, patch.lbpRate ?? null, id],
  );
  // Another request can issue the cycle between the read and the write.
  const updated = rows[0];
  if (updated === undefined) {
    throw new ConflictError('That cycle is no longer open', {
      messageAr: 'الدورة لم تعد مفتوحة',
    });
  }
  const after = toCycle(updated);
  await writeAudit({
    ...actorFields(actor),
    action: 'cycle.update',
    entity: 'cycle',
    entityId: id,
    before,
    after,
  });
  return after;
}

/**
 * Closing freezes the cycle for reporting. It does not freeze the ledger: payments
 * against old bills stay possible afterwards, because debt does not expire.
 */
export async function closeCycle(id: number, actor: Actor): Promise<BillingCycle> {
  const before = await getCycle(id);
  assertTransition(before.status, 'closed');

  const rows = await query<CycleRow>(
    `update billing_cycles set status = 'closed', closed_at = now()
      where id = $1 and status = 'issued'
      returning ${CYCLE_COLUMNS}`,
    [id],
  );
  if (rows.length === 0) {
    throw new ConflictError('That cycle is no longer issued');
  }
  const after = toCycle(rows[0]!);
  await writeAudit({
    ...actorFields(actor),
    action: 'cycle.close',
    entity: 'cycle',
    entityId: id,
    before: { status: before.status },
    after: { status: after.status },
  });
  return after;
}

export async function getCycleProgress(id: number): Promise<CycleProgress> {
  const cycle = await getCycle(id);
  const counts = await maybeOne<{ readings: number; active: number }>(
    `select
       (select count(*)::bigint from meter_readings where cycle_id = $1) as readings,
       (select count(*)::bigint from subscribers
         where deleted_at is null and status = 'active') as active`,
    [id],
  );
  return {
    cycleId: cycle.id,
    period: cycle.period,
    status: cycle.status,
    readingsEntered: counts?.readings ?? 0,
    activeSubscribers: counts?.active ?? 0,
  };
}
