/**
 * Development-only history: six past cycles of plausible readings, bills and
 * payments for the demo subscribers. Never run against a real database.
 */

import { query, transaction } from '../lib/db.js';
import { billAmountUsdCents, usdCentsToLbpRounded } from '../lib/money.js';
import { previousPeriod, currentPeriod } from '../lib/dates.js';

const CYCLES = 6;
const PRICE_CENTS = [30, 30, 28, 28, 26, 26];
const LBP_RATES = [89_000, 89_000, 89_500, 89_500, 90_000, 90_000];

function periodsEndingLastMonth(count: number): string[] {
  const periods: string[] = [];
  let period = previousPeriod(currentPeriod());
  for (let i = 0; i < count; i++) {
    periods.unshift(period);
    period = previousPeriod(period);
  }
  return periods;
}

/* eslint-disable no-await-in-loop */
export async function seedDemoHistory(subscriberIds: number[]): Promise<void> {
  if (subscriberIds.length === 0) return;
  const ownerRows = await query<{ id: number }>(
    "select id from staff where role = 'owner' order by id limit 1",
  );
  const ownerId = ownerRows[0]?.id;
  if (ownerId === undefined) {
    console.log('no owner account; skipping demo history');
    return;
  }

  const meterValue = new Map<number, number>(subscriberIds.map((id) => [id, 0]));
  const periods = periodsEndingLastMonth(CYCLES);

  for (const [index, period] of periods.entries()) {
    const usdPerKwhCents = PRICE_CENTS[index % PRICE_CENTS.length]!;
    const lbpRate = LBP_RATES[index % LBP_RATES.length]!;
    await transaction(async (tx) => {
      const cycleRows = await tx.query<{ id: number }>(
        `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, status, issued_at, closed_at, opened_by)
         values ($1, $2, $3, 'closed', now(), now(), $4)
         on conflict (period) do nothing
         returning id`,
        [period, usdPerKwhCents, lbpRate, ownerId],
      );
      const cycleId = cycleRows[0]?.id;
      if (cycleId === undefined) return;

      for (const subscriberId of subscriberIds) {
        const previous = meterValue.get(subscriberId) ?? 0;
        const kwh = 80 + ((subscriberId * 7 + index * 13) % 240);
        const current = previous + kwh;
        meterValue.set(subscriberId, current);

        await tx.query(
          `insert into meter_readings
             (subscriber_id, cycle_id, previous_value, current_value, kwh, entered_by)
           values ($1, $2, $3, $4, $5, $6)`,
          [subscriberId, cycleId, previous, current, kwh, ownerId],
        );

        const amountUsdCents = billAmountUsdCents(kwh, usdPerKwhCents);
        await tx.query(
          `insert into bills
             (subscriber_id, cycle_id, kwh, usd_per_kwh_cents, amount_usd_cents, lbp_rate, amount_lbp)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            subscriberId,
            cycleId,
            kwh,
            usdPerKwhCents,
            amountUsdCents,
            lbpRate,
            usdCentsToLbpRounded(amountUsdCents, lbpRate),
          ],
        );

        // Most subscribers pay in full; a few leave a balance, which is what makes
        // the arrears report worth looking at in development.
        const paysInFull = (subscriberId + index) % 7 !== 0;
        if (paysInFull) {
          await tx.query(
            `insert into payments (subscriber_id, amount_usd_cents, paid_currency, received_by)
             values ($1, $2, 'USD', $3)`,
            [subscriberId, amountUsdCents, ownerId],
          );
        }
      }
    });
  }
  console.log(`seeded ${periods.length} closed cycles with readings, bills and payments`);
}
/* eslint-enable no-await-in-loop */
