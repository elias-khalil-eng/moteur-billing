import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  ensureSchema,
  resetTables,
  shutdown,
  call,
  createStaff,
  createSubscriber,
} from './helpers.js';
import { query } from '../../lib/db.js';
import type { StaffFixture, SubscriberFixture } from './helpers.js';

let owner: StaffFixture;
let collector: StaffFixture;
let first: SubscriberFixture;
let second: SubscriberFixture;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetTables();
  owner = await createStaff('owner', 'sami');
  collector = await createStaff('collector', 'nabil');
  first = await createSubscriber('1001');
  second = await createSubscriber('1002');
});

afterAll(async () => {
  await shutdown();
});

interface InboxBody {
  notifications: { type: string; titleEn: string; bodyAr: string; bodyEn: string }[];
  unreadCount: number;
}

describe('POST /api/messages', () => {
  it('reaches every subscriber when no one is named', async () => {
    const res = await call<{ recipients: number }>({
      method: 'POST',
      path: '/api/messages',
      token: owner.token,
      body: { title: 'No power tonight', body: 'The generator is down until Friday morning.' },
    });
    expect(res.status).toBe(201);
    expect(res.body.recipients).toBe(2);

    for (const subscriber of [first, second]) {
      // eslint-disable-next-line no-await-in-loop
      const inbox = await call<InboxBody>({
        path: '/api/me/notifications',
        token: subscriber.token,
      });
      expect(inbox.body.notifications).toHaveLength(1);
      expect(inbox.body.notifications[0]!.type).toBe('owner_message');
      expect(inbox.body.notifications[0]!.titleEn).toBe('No power tonight');
      expect(inbox.body.unreadCount).toBe(1);
    }
  });

  it('reaches only the subscriber named', async () => {
    const res = await call<{ recipients: number }>({
      method: 'POST',
      path: '/api/messages',
      token: owner.token,
      body: {
        title: 'Your balance',
        body: 'Please settle before Thursday.',
        subscriberId: first.id,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.recipients).toBe(1);

    const mine = await call<InboxBody>({ path: '/api/me/notifications', token: first.token });
    expect(mine.body.notifications).toHaveLength(1);

    const theirs = await call<InboxBody>({ path: '/api/me/notifications', token: second.token });
    expect(theirs.body.notifications).toHaveLength(0);
  });

  it('keeps the owner words as written in both language columns', async () => {
    await call({
      method: 'POST',
      path: '/api/messages',
      token: owner.token,
      body: { title: 'انقطاع', body: 'المولد متوقف حتى الجمعة.', subscriberId: first.id },
    });
    const inbox = await call<InboxBody>({ path: '/api/me/notifications', token: first.token });
    const note = inbox.body.notifications[0]!;
    expect(note.bodyAr).toBe('المولد متوقف حتى الجمعة.');
    expect(note.bodyEn).toBe('المولد متوقف حتى الجمعة.');
  });

  it('records who sent it', async () => {
    await call({
      method: 'POST',
      path: '/api/messages',
      token: owner.token,
      body: { title: 'Notice', body: 'Collection day moved to Saturday.' },
    });
    const rows = await query<{ created_by: number }>(
      "select distinct created_by from notifications where type = 'owner_message'",
    );
    expect(rows).toEqual([{ created_by: owner.id }]);

    const audit = await query<{ action: string }>(
      "select action from audit_log where action like 'message.%'",
    );
    expect(audit).toEqual([{ action: 'message.broadcast' }]);
  });

  it('skips a deleted subscriber in a broadcast', async () => {
    await call({
      method: 'DELETE',
      path: `/api/subscribers/${second.id}`,
      token: owner.token,
    });
    const res = await call<{ recipients: number }>({
      method: 'POST',
      path: '/api/messages',
      token: owner.token,
      body: { title: 'Notice', body: 'Prices change next cycle.' },
    });
    expect(res.body.recipients).toBe(1);
  });

  it('refuses an unknown subscriber, a missing body and an over-long title', async () => {
    expect(
      (
        await call({
          method: 'POST',
          path: '/api/messages',
          token: owner.token,
          body: { title: 'Hello', body: 'Anyone there', subscriberId: 9999 },
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await call({
          method: 'POST',
          path: '/api/messages',
          token: owner.token,
          body: { title: 'Hello' },
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await call({
          method: 'POST',
          path: '/api/messages',
          token: owner.token,
          body: { title: 'x'.repeat(121), body: 'Too long a title' },
        })
      ).status,
    ).toBe(400);
  });

  it('refuses a collector and a subscriber', async () => {
    const body = { title: 'Notice', body: 'Not yours to send.' };
    expect(
      (await call({ method: 'POST', path: '/api/messages', token: collector.token, body })).status,
    ).toBe(403);
    expect(
      (await call({ method: 'POST', path: '/api/messages', token: first.token, body })).status,
    ).toBe(403);
  });
});
