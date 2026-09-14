/**
 * Meter readings: how a reading becomes kWh, and what counts as suspicious.
 * A typo like 12500 for 1250 is the most common real error on this route, so an
 * unusually large reading is warned about and confirmed rather than rejected.
 */

import { maybeOne } from './db.js';
import { ValidationError } from './errors.js';
import {
  asObject,
  optionalBoolean,
  optionalString,
  rejectUnknownFields,
  requiredInteger,
} from './validate.js';

export const OUTLIER_MULTIPLIER = 3;
export const TRAILING_CYCLES = 3;

export interface KwhInput {
  previousValue: number;
  currentValue: number;
  meterReset?: boolean;
  note?: string | null;
}

export function deriveKwh(input: KwhInput): number {
  const { previousValue, currentValue } = input;
  for (const [field, value] of [
    ['previousValue', previousValue],
    ['currentValue', currentValue],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${field} must be a whole number of kWh, zero or above`, {
        field,
        value,
      });
    }
  }

  if (input.meterReset === true) {
    if (input.note === undefined || input.note === null || input.note.trim() === '') {
      throw new ValidationError(
        'A note is required when the meter was replaced: record the old meter final value',
        {
          field: 'note',
          messageAr: 'الملاحظة مطلوبة عند تبديل العداد: سجّل القراءة الأخيرة للعداد القديم',
        },
      );
    }
    return currentValue;
  }

  if (currentValue < previousValue) {
    throw new ValidationError(
      `The new reading ${currentValue.toLocaleString('en-US')} is below the previous reading ` +
        `${previousValue.toLocaleString('en-US')}. Tick "meter replaced" if the meter changed.`,
      {
        field: 'currentValue',
        previousValue,
        currentValue,
        messageAr:
          `القراءة الجديدة ${currentValue.toLocaleString('en-US')} أقل من القراءة السابقة ` +
          `${previousValue.toLocaleString('en-US')}. اختر «تبديل العداد» إذا تغيّر العداد.`,
      },
    );
  }
  return currentValue - previousValue;
}

export function isOutlier(kwh: number, trailingMeanKwh: number | null): boolean {
  if (trailingMeanKwh === null || trailingMeanKwh <= 0) return false;
  return kwh > OUTLIER_MULTIPLIER * trailingMeanKwh;
}

export interface ReadingInput {
  currentValue: number;
  isEstimated: boolean;
  meterReset: boolean;
  note: string | null;
  confirmOutlier: boolean;
}

const READING_FIELDS = [
  'currentValue',
  'isEstimated',
  'meterReset',
  'note',
  'confirmOutlier',
] as const;

export function parseReadingInput(body: unknown): ReadingInput {
  const input = asObject(body);
  rejectUnknownFields(input, READING_FIELDS);
  return {
    currentValue: requiredInteger(input, 'currentValue', { min: 0 }),
    isEstimated: optionalBoolean(input, 'isEstimated') ?? false,
    meterReset: optionalBoolean(input, 'meterReset') ?? false,
    note: optionalString(input, 'note', { maxLength: 240 }),
    confirmOutlier: optionalBoolean(input, 'confirmOutlier') ?? false,
  };
}

/** The last reading from any earlier cycle, which is where previous_value comes from. */
export async function previousValueFor(subscriberId: number, cycleId: number): Promise<number> {
  const row = await maybeOne<{ current_value: number }>(
    `select r.current_value
       from meter_readings r
       join billing_cycles c on c.id = r.cycle_id
      where r.subscriber_id = $1 and r.cycle_id <> $2
      order by c.period desc
      limit 1`,
    [subscriberId, cycleId],
  );
  return row?.current_value ?? 0;
}

/** Mean kWh over the subscriber's last three billed cycles, or null with no history. */
export async function trailingMeanKwh(subscriberId: number): Promise<number | null> {
  const row = await maybeOne<{ mean: number | null }>(
    `select avg(kwh)::numeric as mean from (
       select b.kwh from bills b
         join billing_cycles c on c.id = b.cycle_id
        where b.subscriber_id = $1
        order by c.period desc
        limit $2
     ) recent`,
    [subscriberId, TRAILING_CYCLES],
  );
  return row?.mean ?? null;
}
