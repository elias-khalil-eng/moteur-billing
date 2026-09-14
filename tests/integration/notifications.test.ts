import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ensureSchema, resetTables, shutdown, call, createStaff, createSubscriber } from './helpers.js';
import { query } from '../../lib/db.js';
import type { StaffFixture, SubscriberFixture } from './helpers.js';

let owner: StaffFixture;
let subscriber: SubscriberFixture;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetTables();
  owner = await createStaff('owner', 'sami');
  subscriber = await createSubscriber('1001');
});

afterAll(async () => {
  await shutdown();
});

async function addNotification(subscriberId: number, titleEn = 'New bill') {
  const rows = await query<{ id: number }>(
    `insert into notifications (subscriber_id, type, title_ar, title_en, body_ar, body_en)
     values ($1, 'bill_issued', 'فاتورة جديدة', $2, 'نص', 'body') returning id`,
    [subscriberId, titleEn],
  );
  return rows[0]!.id;
}

describe('GET /api/me/notifications', () => {
  it('lists a subscriber inbox newest first, with the unread count', async () => {
    await addNotification(subscriber.id, 'Older');
    await addNotification(subscriber.id, 'Newer');

    const res = await call<{ notifications: { titleEn: string }[]; unreadCount: number }>({
      path: '/api/me/notifications',
      token: subscriber.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.notifications.map((n) => n.titleEn)).toEqual(['Newer', 'Older']);
    expect(res.body.unreadCount).toBe(2);
  });

  it('filters to unread only', async () => {
    const read = await addNotification(subscriber.id, 'Read');
    await addNotification(subscriber.id, 'Unread');
    await query('update notifications set read_at = now() where id = $1', [read]);

    const res = await call<{ notifications: { titleEn: string }[] }>({
      path: '/api/me/notifications?unreadOnly=true',
      token: subscriber.token,
    });
    expect(res.body.notifications.map((n) => n.titleEn)).toEqual(['Unread']);
  });

  it('never shows another subscriber their notifications', async () => {
    const other = await createSubscriber('1002');
    await addNotification(other.id, 'Not yours');
    await addNotification(subscriber.id, 'Yours');

    const res = await call<{ notifications: { titleEn: string }[] }>({
      path: `/api/me/notifications?subscriberId=${other.id}`,
      token: subscriber.token,
    });
    expect(res.body.notifications.map((n) => n.titleEn)).toEqual(['Yours']);
  });

  it('refuses a staff token', async () => {
    const res = await call({ path: '/api/me/notifications', token: owner.token });
    expect(res.status).toBe(403);
  });
});

describe('marking notifications read', () => {
  it('marks one as read', async () => {
    const id = await addNotification(subscriber.id);
    const res = await call({
      method: 'POST',
      path: `/api/me/notifications/${id}/read`,
      token: subscriber.token,
    });
    expect(res.status).toBe(200);

    const rows = await query<{ read_at: Date | null }>(
      'select read_at from notifications where id = $1',
      [id],
    );
    expect(rows[0]!.read_at).not.toBeNull();
  });

  it('refuses to mark another subscriber notification as read', async () => {
    const other = await createSubscriber('1002');
    const id = await addNotification(other.id);
    const res = await call({
      method: 'POST',
      path: `/api/me/notifications/${id}/read`,
      token: subscriber.token,
    });
    expect(res.status).toBe(404);

    const rows = await query<{ read_at: Date | null }>(
      'select read_at from notifications where id = $1',
      [id],
    );
    expect(rows[0]!.read_at).toBeNull();
  });

  it('marks every unread notification as read at once', async () => {
    await addNotification(subscriber.id);
    await addNotification(subscriber.id);
    const res = await call<{ unreadCount: number }>({
      method: 'POST',
      path: '/api/me/notifications/read-all',
      token: subscriber.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(0);
  });
});

describe('push subscriptions', () => {
  const endpoint = 'https://push.example.test/subscription/abc';

  it('stores a subscription for the signed in subscriber', async () => {
    const res = await call({
      method: 'POST',
      path: '/api/me/push/subscribe',
      token: subscriber.token,
      body: { endpoint, keys: { p256dh: 'key-material', auth: 'auth-secret' } },
    });
    expect(res.status).toBe(201);

    const rows = await query<{ subscriber_id: number; p256dh: string }>(
      'select subscriber_id, p256dh from push_subscriptions where endpoint = $1',
      [endpoint],
    );
    expect(rows[0]!.subscriber_id).toBe(subscriber.id);
    expect(rows[0]!.p256dh).toBe('key-material');
  });

  it('is idempotent: registering the same endpoint twice keeps one row', async () => {
    const body = { endpoint, keys: { p256dh: 'key-material', auth: 'auth-secret' } };
    await call({ method: 'POST', path: '/api/me/push/subscribe', token: subscriber.token, body });
    await call({ method: 'POST', path: '/api/me/push/subscribe', token: subscriber.token, body });

    const rows = await query<{ count: number }>(
      'select count(*)::bigint as count from push_subscriptions where endpoint = $1',
      [endpoint],
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('removes a subscription', async () => {
    const body = { endpoint, keys: { p256dh: 'key-material', auth: 'auth-secret' } };
    await call({ method: 'POST', path: '/api/me/push/subscribe', token: subscriber.token, body });
    const res = await call({
      method: 'DELETE',
      path: '/api/me/push/subscribe',
      token: subscriber.token,
      body: { endpoint },
    });
    expect(res.status).toBe(204);

    const rows = await query<{ count: number }>(
      'select count(*)::bigint as count from push_subscriptions where endpoint = $1',
      [endpoint],
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('rejects a malformed subscription', async () => {
    const res = await call({
      method: 'POST',
      path: '/api/me/push/subscribe',
      token: subscriber.token,
      body: { endpoint, keys: { p256dh: 'key-material' } },
    });
    expect(res.status).toBe(400);
  });
});
