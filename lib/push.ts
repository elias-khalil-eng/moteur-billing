/**
 * Web Push dispatch. Always called after the transaction that created the
 * notification rows has committed: the in-app inbox is the guaranteed channel and a
 * push failure must never roll back a bill.
 *
 * Failures are isolated per message. A 404 or 410 means the browser dropped the
 * subscription, so the row goes; anything else is counted, and a subscription that
 * fails five times in a row is removed as dead.
 */

import webpush from 'web-push';
import { query } from './db.js';

const BATCH_SIZE = 20;
const MAX_CONSECUTIVE_FAILURES = 5;

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export interface PushTarget {
  id: number;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSender {
  send(target: PushTarget, payload: string): Promise<{ statusCode: number }>;
}

export interface PushResult {
  sent: number;
  failed: number;
  removed: number;
}

function statusOfPushError(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const status = (err as { statusCode: unknown }).statusCode;
    return typeof status === 'number' ? status : null;
  }
  return null;
}

export function vapidConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT,
  );
}

/** The real sender. Kept behind the PushSender interface so tests never leave the machine. */
export function webPushSender(): PushSender {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT!,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  return {
    async send(target, payload) {
      const result = await webpush.sendNotification(
        { endpoint: target.endpoint, keys: target.keys },
        payload,
      );
      return { statusCode: result.statusCode };
    },
  };
}

async function removeSubscription(id: number): Promise<void> {
  await query('delete from push_subscriptions where id = $1', [id]);
}

async function recordSuccess(id: number): Promise<void> {
  await query('update push_subscriptions set last_seen_at = now(), failed_count = 0 where id = $1', [
    id,
  ]);
}

async function recordFailure(id: number): Promise<boolean> {
  const rows = await query<{ failed_count: number }>(
    'update push_subscriptions set failed_count = failed_count + 1 where id = $1 returning failed_count',
    [id],
  );
  const failures = rows[0]?.failed_count ?? 0;
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    await removeSubscription(id);
    return true;
  }
  return false;
}

export async function dispatchToSubscribers(
  subscriberIds: readonly number[],
  payload: PushPayload,
  sender: PushSender | null = null,
): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, removed: 0 };
  if (subscriberIds.length === 0) return result;

  const active = sender ?? (vapidConfigured() ? webPushSender() : null);
  if (active === null) return result;

  const targets = await query<{ id: number; endpoint: string; p256dh: string; auth: string }>(
    `select id, endpoint, p256dh, auth from push_subscriptions
      where subscriber_id = any($1::bigint[])`,
    [subscriberIds as number[]],
  );
  if (targets.length === 0) return result;

  const body = JSON.stringify(payload);

  for (let start = 0; start < targets.length; start += BATCH_SIZE) {
    const batch = targets.slice(start, start + BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const outcomes = await Promise.all(
      batch.map(async (row) => {
        const target: PushTarget = {
          id: row.id,
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        };
        try {
          await active.send(target, body);
          await recordSuccess(row.id);
          return 'sent' as const;
        } catch (err) {
          const status = statusOfPushError(err);
          if (status === 404 || status === 410) {
            await removeSubscription(row.id);
            return 'removed' as const;
          }
          const removed = await recordFailure(row.id);
          return removed ? 'failed-removed' : ('failed' as const);
        }
      }),
    );

    for (const outcome of outcomes) {
      if (outcome === 'sent') result.sent += 1;
      else if (outcome === 'removed') result.removed += 1;
      else if (outcome === 'failed-removed') {
        result.failed += 1;
        result.removed += 1;
      } else result.failed += 1;
    }
  }

  return result;
}
