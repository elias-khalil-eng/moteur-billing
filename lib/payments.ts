/**
 * Cash payments, recorded by staff. A payment is applied to the subscriber's
 * balance, not to a particular bill: partial payments are normal here, and the
 * ledger is billed minus paid.
 *
 * Money is append-only. A wrong payment is voided, with a reason, and the row stays.
 */

import { query, maybeOne } from './db.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { lbpToUsdCents } from './money.js';
import { writeAudit, actorFields } from './audit.js';
import { insertNotifications, paymentRecordedText } from './notify.js';
import { dispatchToSubscribers } from './push.js';
import {
  asObject,
  oneOf,
  optionalString,
  rejectUnknownFields,
  requiredInteger,
  requiredString,
} from './validate.js';
import type { Actor, PaidCurrency, Payment } from './types.js';

const CURRENCIES = ['USD', 'LBP'] as const;
const PAYMENT_FIELDS = [
  'subscriberId',
  'amountUsdCents',
  'amountLbp',
  'paidCurrency',
  'lbpRateUsed',
  'paidAt',
  'note',
] as const;

export interface PaymentInput {
  subscriberId: number;
  amountUsdCents: number;
  paidCurrency: PaidCurrency;
  amountLbp: number | null;
  lbpRateUsed: number | null;
  paidAt: Date | null;
  note: string | null;
}

export function parsePaymentInput(body: unknown): PaymentInput {
  const input = asObject(body);
  rejectUnknownFields(input, PAYMENT_FIELDS);
  const subscriberId = requiredInteger(input, 'subscriberId', { min: 1 });
  const paidCurrency = oneOf(input, 'paidCurrency', CURRENCIES);
  const note = optionalString(input, 'note', { maxLength: 240 });

  let paidAt: Date | null = null;
  const rawPaidAt = optionalString(input, 'paidAt', { maxLength: 40 });
  if (rawPaidAt !== null) {
    const parsed = new Date(rawPaidAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError('paidAt must be a date', { field: 'paidAt' });
    }
    paidAt = parsed;
  }

  if (paidCurrency === 'USD') {
    if (input.amountLbp !== undefined || input.lbpRateUsed !== undefined) {
      throw new ValidationError('A payment in USD carries no LBP amount or rate', {
        field: 'amountLbp',
      });
    }
    return {
      subscriberId,
      amountUsdCents: requiredInteger(input, 'amountUsdCents', { min: 1 }),
      paidCurrency,
      amountLbp: null,
      lbpRateUsed: null,
      paidAt,
      note,
    };
  }

  // The server derives the USD figure. A client-sent amountUsdCents would be a
  // second source of truth for the same payment, so it is refused outright.
  if (input.amountUsdCents !== undefined) {
    throw new ValidationError('A payment in LBP is converted by the server, not the client', {
      field: 'amountUsdCents',
    });
  }
  const amountLbp = requiredInteger(input, 'amountLbp', { min: 1 });
  const lbpRateUsed = requiredInteger(input, 'lbpRateUsed', { min: 1 });
  const amountUsdCents = lbpToUsdCents(amountLbp, lbpRateUsed);
  if (amountUsdCents < 1) {
    throw new ValidationError('That LBP amount is worth less than one cent', {
      field: 'amountLbp',
    });
  }
  return { subscriberId, amountUsdCents, paidCurrency, amountLbp, lbpRateUsed, paidAt, note };
}

export function parseVoidReason(body: unknown): string {
  const input = asObject(body);
  rejectUnknownFields(input, ['reason']);
  return requiredString(input, 'reason', { maxLength: 240 });
}

interface PaymentRow extends Record<string, unknown> {
  id: number;
  subscriber_id: number;
  amount_usd_cents: number;
  paid_currency: PaidCurrency;
  amount_lbp: number | null;
  lbp_rate_used: number | null;
  paid_at: Date;
  received_by: number;
  received_by_name?: string;
  note: string | null;
  voided_at: Date | null;
  void_reason: string | null;
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    subscriberId: row.subscriber_id,
    amountUsdCents: row.amount_usd_cents,
    paidCurrency: row.paid_currency,
    amountLbp: row.amount_lbp,
    lbpRateUsed: row.lbp_rate_used,
    paidAt: row.paid_at.toISOString(),
    receivedBy: row.received_by,
    ...(row.received_by_name === undefined ? {} : { receivedByName: row.received_by_name }),
    note: row.note,
    voidedAt: row.voided_at === null ? null : row.voided_at.toISOString(),
    voidReason: row.void_reason,
  };
}

const PAYMENT_COLUMNS = `p.id, p.subscriber_id, p.amount_usd_cents, p.paid_currency, p.amount_lbp,
                         p.lbp_rate_used, p.paid_at, p.received_by, p.note, p.voided_at,
                         p.void_reason`;

export interface RecordedPayment {
  payment: Payment;
  balanceUsdCents: number;
}

async function balanceOf(subscriberId: number): Promise<number> {
  const row = await maybeOne<{ balance_usd_cents: number }>(
    'select balance_usd_cents from subscriber_balances where subscriber_id = $1',
    [subscriberId],
  );
  return row?.balance_usd_cents ?? 0;
}

export async function recordPayment(body: unknown, actor: Actor): Promise<RecordedPayment> {
  const input = parsePaymentInput(body);
  const subscriber = await maybeOne<{ id: number }>(
    'select id from subscribers where id = $1 and deleted_at is null',
    [input.subscriberId],
  );
  if (subscriber === null) throw new NotFoundError('subscriber', input.subscriberId);

  const rows = await query<PaymentRow>(
    `insert into payments
       (subscriber_id, amount_usd_cents, paid_currency, amount_lbp, lbp_rate_used, paid_at,
        received_by, note)
     values ($1, $2, $3, $4, $5, coalesce($6, now()), $7, $8)
     returning id, subscriber_id, amount_usd_cents, paid_currency, amount_lbp, lbp_rate_used,
               paid_at, received_by, note, voided_at, void_reason`,
    [
      input.subscriberId,
      input.amountUsdCents,
      input.paidCurrency,
      input.amountLbp,
      input.lbpRateUsed,
      input.paidAt,
      actor.id,
      input.note,
    ],
  );
  const payment = toPayment(rows[0]!);
  await writeAudit({
    ...actorFields(actor),
    action: 'payment.record',
    entity: 'payment',
    entityId: payment.id,
    after: payment,
  });

  const balanceUsdCents = await balanceOf(input.subscriberId);
  const text = paymentRecordedText({ amountUsdCents: payment.amountUsdCents, balanceUsdCents });
  await insertNotifications({ query }, [
    { subscriberId: input.subscriberId, type: 'payment_recorded', billId: null, text },
  ]);
  // Best effort, and never in the way of the receipt the collector is waiting for.
  await dispatchToSubscribers([input.subscriberId], {
    title: text.titleEn,
    body: text.bodyEn,
    url: '/payments',
  }).catch((err: unknown) => {
    console.error(JSON.stringify({ action: 'push.dispatch', paymentId: payment.id, error: String(err) }));
  });

  return { payment, balanceUsdCents };
}

/** Voiding leaves the row in place and removes it from the balance. Nothing is deleted. */
export async function voidPayment(
  id: number,
  body: unknown,
  actor: Actor,
): Promise<RecordedPayment> {
  const reason = parseVoidReason(body);
  const before = await maybeOne<PaymentRow>(
    `select ${PAYMENT_COLUMNS} from payments p where p.id = $1`,
    [id],
  );
  if (before === null) throw new NotFoundError('payment', id);
  if (before.voided_at !== null) {
    throw new ConflictError('That payment is already voided', {
      messageAr: 'هذه الدفعة ملغاة أصلًا',
    });
  }

  const rows = await query<PaymentRow>(
    `update payments p set voided_at = now(), voided_by = $1, void_reason = $2
      where p.id = $3 and p.voided_at is null
      returning id, subscriber_id, amount_usd_cents, paid_currency, amount_lbp, lbp_rate_used,
                paid_at, received_by, note, voided_at, void_reason`,
    [actor.id, reason, id],
  );
  const payment = toPayment(rows[0]!);
  await writeAudit({
    ...actorFields(actor),
    action: 'payment.void',
    entity: 'payment',
    entityId: id,
    before: toPayment(before),
    after: payment,
  });
  return { payment, balanceUsdCents: await balanceOf(payment.subscriberId) };
}

export interface PaymentFilters {
  subscriberId?: string | null;
  from?: string | null;
  to?: string | null;
  receivedBy?: string | null;
}

function optionalId(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function optionalDate(value: string | null | undefined, field: string): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${field} must be a date`, { field });
  }
  return parsed;
}

export async function listPayments(filters: PaymentFilters): Promise<Payment[]> {
  const rows = await query<PaymentRow>(
    `select ${PAYMENT_COLUMNS}, s.name as received_by_name
       from payments p
       join staff s on s.id = p.received_by
      where ($1::bigint is null or p.subscriber_id = $1)
        and ($2::timestamptz is null or p.paid_at >= $2)
        and ($3::timestamptz is null or p.paid_at < $3)
        and ($4::bigint is null or p.received_by = $4)
      order by p.paid_at desc
      limit 500`,
    [
      optionalId(filters.subscriberId),
      optionalDate(filters.from, 'from'),
      optionalDate(filters.to, 'to'),
      optionalId(filters.receivedBy),
    ],
  );
  return rows.map(toPayment);
}

export async function subscriberPayments(subscriberId: number): Promise<Payment[]> {
  const rows = await query<PaymentRow>(
    `select ${PAYMENT_COLUMNS}, s.name as received_by_name
       from payments p
       join staff s on s.id = p.received_by
      where p.subscriber_id = $1
      order by p.paid_at desc
      limit 100`,
    [subscriberId],
  );
  return rows.map(toPayment);
}
