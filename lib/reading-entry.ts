/**
 * Writing readings, and the route list a collector works down. Split from
 * readings.ts, which owns the rules those writes apply, to keep both files near
 * the size the project works to.
 */

import { query, maybeOne } from './db.js';
import { ConflictError, NotFoundError } from './errors.js';
import { canEditReadings, getCycle } from './cycles.js';
import { writeAudit, actorFields } from './audit.js';
import {
  deriveKwh,
  isOutlier,
  parseReadingInput,
  previousValueFor,
  trailingMeanKwh,
  TRAILING_CYCLES,
} from './readings.js';
import type { Actor, MeterReading, RouteRow } from './types.js';

async function assertCycleTakesReadings(cycleId: number): Promise<void> {
  const cycle = await getCycle(cycleId);
  if (!canEditReadings(cycle.status)) {
    throw new ConflictError('Readings are locked once the cycle is issued', {
      status: cycle.status,
      messageAr: 'القراءات مقفلة بعد إصدار فواتير الدورة',
    });
  }
}

interface ReadingRow extends Record<string, unknown> {
  id: number;
  subscriber_id: number;
  cycle_id: number;
  previous_value: number;
  current_value: number;
  kwh: number;
  is_estimated: boolean;
  meter_reset: boolean;
  read_at: Date;
  entered_by: number;
  note: string | null;
}

function toReading(row: ReadingRow): MeterReading {
  return {
    id: row.id,
    subscriberId: row.subscriber_id,
    cycleId: row.cycle_id,
    previousValue: row.previous_value,
    currentValue: row.current_value,
    kwh: row.kwh,
    isEstimated: row.is_estimated,
    meterReset: row.meter_reset,
    readAt: row.read_at.toISOString(),
    enteredBy: row.entered_by,
    note: row.note,
  };
}

const READING_RETURNING =
  'id, subscriber_id, cycle_id, previous_value, current_value, kwh, is_estimated, ' +
  'meter_reset, read_at, entered_by, note';

export interface SavedReading {
  reading: MeterReading;
  trailingMeanKwh: number | null;
}

export async function upsertReading(
  cycleId: number,
  subscriberId: number,
  body: unknown,
  actor: Actor,
): Promise<SavedReading> {
  await assertCycleTakesReadings(cycleId);
  const subscriber = await maybeOne<{ id: number }>(
    'select id from subscribers where id = $1 and deleted_at is null',
    [subscriberId],
  );
  if (subscriber === null) throw new NotFoundError('subscriber', subscriberId);

  const input = parseReadingInput(body);
  const previousValue = await previousValueFor(subscriberId, cycleId);
  const kwh = deriveKwh({
    previousValue,
    currentValue: input.currentValue,
    meterReset: input.meterReset,
    note: input.note,
  });

  const mean = await trailingMeanKwh(subscriberId);
  // Warn, never block: a genuine spike happens, and a collector on the doorstep
  // needs a way through it. The confirm tap sends confirmOutlier.
  if (!input.confirmOutlier && isOutlier(kwh, mean)) {
    throw new ConflictError(
      `${kwh.toLocaleString('en-US')} kWh is far above this subscriber's usual usage. ` +
        'Check the digits, then confirm.',
      {
        reason: 'outlier',
        kwh,
        trailingMeanKwh: mean,
        requiresConfirmation: true,
        messageAr:
          `${kwh.toLocaleString('en-US')} ك.و.س أعلى بكثير من استهلاك هذا المشترك المعتاد. ` +
          'تحقّق من الأرقام ثم أكّد.',
      },
    );
  }

  const rows = await query<ReadingRow>(
    `insert into meter_readings
       (subscriber_id, cycle_id, previous_value, current_value, kwh, is_estimated, meter_reset,
        entered_by, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (subscriber_id, cycle_id) do update
        set previous_value = excluded.previous_value,
            current_value = excluded.current_value,
            kwh = excluded.kwh,
            is_estimated = excluded.is_estimated,
            meter_reset = excluded.meter_reset,
            entered_by = excluded.entered_by,
            note = excluded.note,
            read_at = now()
     returning ${READING_RETURNING}`,
    [
      subscriberId,
      cycleId,
      previousValue,
      input.currentValue,
      kwh,
      input.isEstimated,
      input.meterReset,
      actor.id,
      input.note,
    ],
  );
  const reading = toReading(rows[0]!);
  await writeAudit({
    ...actorFields(actor),
    action: 'reading.save',
    entity: 'reading',
    entityId: reading.id,
    after: reading,
  });
  return { reading, trailingMeanKwh: mean };
}

export async function removeReading(
  cycleId: number,
  subscriberId: number,
  actor: Actor,
): Promise<void> {
  await assertCycleTakesReadings(cycleId);
  const rows = await query<ReadingRow>(
    `delete from meter_readings where cycle_id = $1 and subscriber_id = $2
     returning ${READING_RETURNING}`,
    [cycleId, subscriberId],
  );
  const removed = rows[0];
  if (removed === undefined) throw new NotFoundError('reading');
  await writeAudit({
    ...actorFields(actor),
    action: 'reading.delete',
    entity: 'reading',
    entityId: removed.id,
    before: toReading(removed),
  });
}

export interface RouteFilters {
  q?: string | null;
  zone?: string | null;
  pending?: string | null;
}

interface RouteQueryRow extends Record<string, unknown> {
  subscriber_id: number;
  code: string;
  name: string;
  zone: string | null;
  meter_serial: string | null;
  previous_value: number;
  current_value: number | null;
  kwh: number | null;
  is_estimated: boolean | null;
  meter_reset: boolean | null;
  note: string | null;
  trailing_mean_kwh: number | null;
}

/**
 * One query for the whole route: every active subscriber, the reading for this
 * cycle if there is one, the value their meter last showed, and their trailing
 * mean. A collector on a phone should not wait on N+1 round trips.
 */
export async function getRoute(cycleId: number, filters: RouteFilters): Promise<RouteRow[]> {
  await getCycle(cycleId);
  const search = filters.q?.trim() ? `%${filters.q.trim()}%` : null;
  const zone = filters.zone?.trim() ? filters.zone.trim() : null;
  const pendingOnly = filters.pending === 'true';

  const rows = await query<RouteQueryRow>(
    `select s.id as subscriber_id, s.code, s.name, s.zone, s.meter_serial,
            coalesce(r.previous_value, prev.current_value, 0) as previous_value,
            r.current_value, r.kwh, r.is_estimated, r.meter_reset, r.note,
            mean_calc.mean as trailing_mean_kwh
       from subscribers s
       left join meter_readings r on r.subscriber_id = s.id and r.cycle_id = $1
       left join lateral (
         select r2.current_value
           from meter_readings r2
           join billing_cycles c2 on c2.id = r2.cycle_id
          where r2.subscriber_id = s.id and r2.cycle_id <> $1
          order by c2.period desc
          limit 1
       ) prev on true
       left join lateral (
         select avg(recent.kwh)::numeric as mean from (
           select b.kwh from bills b
             join billing_cycles c3 on c3.id = b.cycle_id
            where b.subscriber_id = s.id
            order by c3.period desc
            limit $5
         ) recent
       ) mean_calc on true
      where s.deleted_at is null
        and s.status = 'active'
        and ($2::text is null or s.name ilike $2 or s.code ilike $2)
        and ($3::text is null or s.zone = $3)
        and ($4::boolean is false or r.id is null)
      order by s.zone nulls last, s.name, s.code`,
    [cycleId, search, zone, pendingOnly, TRAILING_CYCLES],
  );

  return rows.map((row) => ({
    subscriberId: row.subscriber_id,
    code: row.code,
    name: row.name,
    zone: row.zone,
    meterSerial: row.meter_serial,
    previousValue: row.previous_value,
    currentValue: row.current_value,
    kwh: row.kwh,
    isEstimated: row.is_estimated,
    meterReset: row.meter_reset,
    note: row.note,
    trailingMeanKwh: row.trailing_mean_kwh,
  }));
}
