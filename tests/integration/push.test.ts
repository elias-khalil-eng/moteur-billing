import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ensureSchema, resetTables, shutdown, createSubscriber } from './helpers.js';
import { query } from '../../lib/db.js';
import { dispatchToSubscribers } from '../../lib/push.js';
import type { PushSender } from '../../lib/push.js';
import type { SubscriberFixture } from './helpers.js';

let subscriber: SubscriberFixture;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetTables();
  subscriber = await createSubscriber('1001');
});

afterAll(async () => {
  await shutdown();
});

async function addSubscription(subscriberId: number, endpoint: string, failedCount = 0) {
  await query(
    `insert into push_subscriptions (subscriber_id, endpoint, p256dh, auth, failed_count, last_seen_at)
     values ($1, $2, 'key', 'auth', $3, now() - interval '2 days')`,
    [subscriberId, endpoint, failedCount],
  );
}

function senderReturning(byEndpoint: Record<string, number | Error>): PushSender {
  return {
    async send(subscription) {
      const outcome = byEndpoint[subscription.endpoint];
      if (outcome instanceof Error) throw outcome;
      if (typeof outcome === 'number' && outcome >= 400) {
        const error = new Error(`push failed with ${outcome}`) as Error & { statusCode: number };
        error.statusCode = outcome;
        throw error;
      }
      return { statusCode: outcome ?? 201 };
    },
  };
}

const payload = { title: 'New bill', body: '2026-09 bill', url: '/' };

describe('dispatchToSubscribers', () => {
  it('sends to every stored subscription and refreshes it on success', async () => {
    await addSubscription(subscriber.id, 'https://push.test/a', 3);

    const result = await dispatchToSubscribers(
      [subscriber.id],
      payload,
      senderReturning({ 'https://push.test/a': 201 }),
    );
    expect(result.sent).toBe(1);
    expect(result.removed).toBe(0);

    const rows = await query<{ failed_count: number; last_seen_at: Date }>(
      'select failed_count, last_seen_at from push_subscriptions where endpoint = $1',
      ['https://push.test/a'],
    );
    expect(rows[0]!.failed_count).toBe(0);
    expect(Date.now() - rows[0]!.last_seen_at.getTime()).toBeLessThan(60_000);
  });

  it('deletes a subscription the browser has dropped, on 404 and on 410', async () => {
    await addSubscription(subscriber.id, 'https://push.test/gone-404');
    await addSubscription(subscriber.id, 'https://push.test/gone-410');

    const result = await dispatchToSubscribers(
      [subscriber.id],
      payload,
      senderReturning({ 'https://push.test/gone-404': 404, 'https://push.test/gone-410': 410 }),
    );
    expect(result.removed).toBe(2);

    const rows = await query<{ count: number }>(
      'select count(*)::bigint as count from push_subscriptions',
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('counts a transient failure without removing the subscription', async () => {
    await addSubscription(subscriber.id, 'https://push.test/flaky');

    const result = await dispatchToSubscribers(
      [subscriber.id],
      payload,
      senderReturning({ 'https://push.test/flaky': 500 }),
    );
    expect(result.failed).toBe(1);
    expect(result.removed).toBe(0);

    const rows = await query<{ failed_count: number }>(
      'select failed_count from push_subscriptions where endpoint = $1',
      ['https://push.test/flaky'],
    );
    expect(rows[0]!.failed_count).toBe(1);
  });

  it('removes a subscription after five consecutive failures', async () => {
    await addSubscription(subscriber.id, 'https://push.test/dead', 4);

    const result = await dispatchToSubscribers(
      [subscriber.id],
      payload,
      senderReturning({ 'https://push.test/dead': 500 }),
    );
    expect(result.removed).toBe(1);

    const rows = await query<{ count: number }>(
      'select count(*)::bigint as count from push_subscriptions',
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('isolates failures: one bad endpoint does not stop the others', async () => {
    await addSubscription(subscriber.id, 'https://push.test/good');
    await addSubscription(subscriber.id, 'https://push.test/bad');

    const result = await dispatchToSubscribers([subscriber.id], payload, {
      async send(subscription) {
        if (subscription.endpoint.endsWith('bad')) throw new Error('network down');
        return { statusCode: 201 };
      },
    });
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('does nothing when there are no subscriptions', async () => {
    const result = await dispatchToSubscribers([subscriber.id], payload, senderReturning({}));
    expect(result).toEqual({ sent: 0, failed: 0, removed: 0 });
  });
});
