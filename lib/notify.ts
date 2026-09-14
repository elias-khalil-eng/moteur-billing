/**
 * Notification rows. The in-app inbox is the guaranteed channel; Web Push is
 * best-effort on top of it and is dispatched separately, after the transaction
 * that created these rows has committed.
 */

import { query, maybeOne } from './db.js';
import type { Queryable } from './db.js';
import { NotFoundError } from './errors.js';
import { asObject, rejectUnknownFields, requiredString } from './validate.js';
import type {
  NotificationItem,
  NotificationType,
  ServiceRequestKind,
  ServiceRequestStatus,
} from './types.js';

export interface NotificationText {
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
}

/** Display formatting for notification text; no monetary value is computed here. */
function usd(amountUsdCents: number): string {
  const sign = amountUsdCents < 0 ? '-' : '';
  const abs = Math.abs(amountUsdCents);
  return `${sign}$${Math.trunc(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

function lbp(amountLbp: number): string {
  return amountLbp.toLocaleString('en-US');
}

export function billIssuedText(input: {
  period: string;
  kwh: number;
  amountUsdCents: number;
  amountLbp: number;
}): NotificationText {
  return {
    titleAr: 'فاتورة جديدة',
    titleEn: 'New bill',
    bodyAr: `فاتورة ${input.period}: ${input.kwh.toLocaleString('en-US')} ك.و.س، ${usd(
      input.amountUsdCents,
    )} أو ${lbp(input.amountLbp)} ل.ل.`,
    bodyEn: `${input.period} bill: ${input.kwh.toLocaleString('en-US')} kWh, ${usd(
      input.amountUsdCents,
    )} or ${lbp(input.amountLbp)} LBP`,
  };
}

export function paymentRecordedText(input: {
  amountUsdCents: number;
  balanceUsdCents: number;
}): NotificationText {
  return {
    titleAr: 'تم تسجيل دفعة',
    titleEn: 'Payment recorded',
    bodyAr: `استلمنا ${usd(input.amountUsdCents)}. الرصيد المتبقي ${usd(input.balanceUsdCents)}.`,
    bodyEn: `We received ${usd(input.amountUsdCents)}. Balance now ${usd(input.balanceUsdCents)}.`,
  };
}

const REQUEST_KIND_AR: Record<ServiceRequestKind, string> = {
  meter_issue: 'عطل في العداد',
  new_connection: 'اشتراك جديد',
  disconnect: 'فصل الاشتراك',
  billing_question: 'استفسار عن الفاتورة',
  other: 'طلب آخر',
};

const REQUEST_KIND_EN: Record<ServiceRequestKind, string> = {
  meter_issue: 'Meter problem',
  new_connection: 'New connection',
  disconnect: 'Disconnection',
  billing_question: 'Billing question',
  other: 'Other request',
};

const REQUEST_STATUS_AR: Record<ServiceRequestStatus, string> = {
  open: 'قيد الانتظار',
  in_progress: 'قيد التنفيذ',
  resolved: 'تم إنجازه',
  rejected: 'مرفوض',
};

const REQUEST_STATUS_EN: Record<ServiceRequestStatus, string> = {
  open: 'Waiting',
  in_progress: 'In progress',
  resolved: 'Done',
  rejected: 'Declined',
};

/** The system announcing what the owner did with a request, in both languages. */
export function requestUpdateText(input: {
  kind: ServiceRequestKind;
  status: ServiceRequestStatus;
  ownerNote: string | null;
}): NotificationText {
  const noteAr = input.ownerNote === null ? '' : ' — ' + input.ownerNote;
  const noteEn = input.ownerNote === null ? '' : ' — ' + input.ownerNote;
  return {
    titleAr: 'تحديث على طلبك',
    titleEn: 'Request update',
    bodyAr: REQUEST_KIND_AR[input.kind] + ': ' + REQUEST_STATUS_AR[input.status] + noteAr,
    bodyEn: REQUEST_KIND_EN[input.kind] + ': ' + REQUEST_STATUS_EN[input.status] + noteEn,
  };
}

/**
 * A message the owner typed. It is one person's own words, so it is stored as written
 * in both language columns rather than machine-translated into an Arabic no one wrote.
 */
export function ownerMessageText(input: { title: string; body: string }): NotificationText {
  return {
    titleAr: input.title,
    titleEn: input.title,
    bodyAr: input.body,
    bodyEn: input.body,
  };
}

export interface NotificationRow {
  subscriberId: number;
  type: NotificationType;
  billId: number | null;
  text: NotificationText;
  createdBy?: number | null;
  requestId?: number | null;
}

export async function insertNotifications(
  tx: Queryable,
  rows: readonly NotificationRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((row, index) => {
    const base = index * 9;
    values.push(
      row.subscriberId,
      row.type,
      row.text.titleAr,
      row.text.titleEn,
      row.text.bodyAr,
      row.text.bodyEn,
      row.billId,
      row.createdBy ?? null,
      row.requestId ?? null,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
  });
  await tx.query(
    `insert into notifications
       (subscriber_id, type, title_ar, title_en, body_ar, body_en, bill_id, created_by, request_id)
     values ${tuples.join(', ')}`,
    values as never,
  );
}

// --- inbox and push subscriptions -----------------------------------------

interface NotificationDbRow extends Record<string, unknown> {
  id: number;
  type: NotificationType;
  title_ar: string;
  title_en: string;
  body_ar: string;
  body_en: string;
  bill_id: number | null;
  request_id: number | null;
  read_at: Date | null;
  created_at: Date;
}

function toNotification(row: NotificationDbRow): NotificationItem {
  return {
    id: row.id,
    type: row.type,
    titleAr: row.title_ar,
    titleEn: row.title_en,
    bodyAr: row.body_ar,
    bodyEn: row.body_en,
    billId: row.bill_id,
    requestId: row.request_id,
    readAt: row.read_at === null ? null : row.read_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

export interface Inbox {
  notifications: NotificationItem[];
  unreadCount: number;
}

export async function listNotifications(
  subscriberId: number,
  unreadOnly: boolean,
): Promise<Inbox> {
  const rows = await query<NotificationDbRow>(
    `select id, type, title_ar, title_en, body_ar, body_en, bill_id, request_id, read_at,
            created_at
       from notifications
      where subscriber_id = $1 and ($2::boolean is false or read_at is null)
      order by created_at desc, id desc
      limit 100`,
    [subscriberId, unreadOnly],
  );
  return { notifications: rows.map(toNotification), unreadCount: await unreadCount(subscriberId) };
}

export async function unreadCount(subscriberId: number): Promise<number> {
  const row = await maybeOne<{ count: number }>(
    'select count(*)::bigint as count from notifications where subscriber_id = $1 and read_at is null',
    [subscriberId],
  );
  return row?.count ?? 0;
}

export async function markRead(subscriberId: number, notificationId: number): Promise<Inbox> {
  const rows = await query<{ id: number }>(
    `update notifications set read_at = coalesce(read_at, now())
      where id = $1 and subscriber_id = $2 returning id`,
    [notificationId, subscriberId],
  );
  // Scoped by the token's subject, so another subscriber's row is simply not found.
  if (rows.length === 0) throw new NotFoundError('notification', notificationId);
  return listNotifications(subscriberId, false);
}

export async function markAllRead(subscriberId: number): Promise<Inbox> {
  await query(
    'update notifications set read_at = now() where subscriber_id = $1 and read_at is null',
    [subscriberId],
  );
  return listNotifications(subscriberId, false);
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function parsePushSubscription(body: unknown): PushSubscriptionInput {
  const input = asObject(body);
  rejectUnknownFields(input, ['endpoint', 'keys']);
  const endpoint = requiredString(input, 'endpoint', { maxLength: 1_000 });
  const keys = asObject(input.keys);
  rejectUnknownFields(keys, ['p256dh', 'auth']);
  return {
    endpoint,
    p256dh: requiredString(keys, 'p256dh', { maxLength: 400 }),
    auth: requiredString(keys, 'auth', { maxLength: 400 }),
  };
}

export async function savePushSubscription(
  subscriberId: number,
  body: unknown,
): Promise<{ endpoint: string }> {
  const input = parsePushSubscription(body);
  await query(
    `insert into push_subscriptions (subscriber_id, endpoint, p256dh, auth)
     values ($1, $2, $3, $4)
     on conflict (endpoint) do update
        set subscriber_id = excluded.subscriber_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            last_seen_at = now(),
            failed_count = 0`,
    [subscriberId, input.endpoint, input.p256dh, input.auth],
  );
  return { endpoint: input.endpoint };
}

export async function removePushSubscription(subscriberId: number, body: unknown): Promise<void> {
  const input = asObject(body);
  rejectUnknownFields(input, ['endpoint']);
  const endpoint = requiredString(input, 'endpoint', { maxLength: 1_000 });
  await query('delete from push_subscriptions where endpoint = $1 and subscriber_id = $2', [
    endpoint,
    subscriberId,
  ]);
}
