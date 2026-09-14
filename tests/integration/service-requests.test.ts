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
import type { ServiceRequest, ServiceRequestWithSubscriber } from '../../lib/types.js';

let owner: StaffFixture;
let collector: StaffFixture;
let subscriber: SubscriberFixture;
let other: SubscriberFixture;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetTables();
  owner = await createStaff('owner', 'sami');
  collector = await createStaff('collector', 'nabil');
  subscriber = await createSubscriber('1001');
  other = await createSubscriber('1002');
});

afterAll(async () => {
  await shutdown();
});

async function fileRequest(
  token: string,
  kind = 'meter_issue',
  body = 'The meter stopped turning yesterday',
): Promise<{ status: number; request: ServiceRequest }> {
  const res = await call<{ request: ServiceRequest }>({
    method: 'POST',
    path: '/api/me/requests',
    token,
    body: { kind, body },
  });
  return { status: res.status, request: res.body?.request };
}

describe('POST /api/me/requests', () => {
  it('files a request that the subscriber can read back', async () => {
    const created = await fileRequest(subscriber.token);
    expect(created.status).toBe(201);
    expect(created.request.status).toBe('open');
    expect(created.request.ownerNote).toBeNull();

    const mine = await call<{ requests: ServiceRequest[] }>({
      path: '/api/me/requests',
      token: subscriber.token,
    });
    expect(mine.status).toBe(200);
    expect(mine.body.requests).toHaveLength(1);
    expect(mine.body.requests[0]!.body).toBe('The meter stopped turning yesterday');
  });

  it('leaves an audit row naming the subscriber as the actor', async () => {
    const created = await fileRequest(subscriber.token);
    const rows = await query<{ actor_type: string; actor_id: number; action: string }>(
      'select actor_type, actor_id, action from audit_log where entity_id = $1',
      [created.request.id],
    );
    expect(rows).toEqual([
      { actor_type: 'subscriber', actor_id: subscriber.id, action: 'request.create' },
    ]);
  });

  it('refuses an unknown kind, an empty body and an unknown field', async () => {
    const badKind = await fileRequest(subscriber.token, 'refund');
    expect(badKind.status).toBe(400);

    const empty = await fileRequest(subscriber.token, 'other', '   ');
    expect(empty.status).toBe(400);

    const extra = await call({
      method: 'POST',
      path: '/api/me/requests',
      token: subscriber.token,
      body: { kind: 'other', body: 'hello', status: 'resolved' },
    });
    expect(extra.status).toBe(400);
  });

  it('caps a subscriber at five requests still waiting', async () => {
    for (let i = 0; i < 5; i++) {
      // Sequential on purpose: the cap counts rows already committed.
      // eslint-disable-next-line no-await-in-loop
      const res = await fileRequest(subscriber.token, 'other', `Request ${i}`);
      expect(res.status).toBe(201);
    }
    const sixth = await fileRequest(subscriber.token, 'other', 'One too many');
    expect(sixth.status).toBe(409);

    // The cap is per subscriber, not global.
    const another = await fileRequest(other.token);
    expect(another.status).toBe(201);
  });

  it('counts a closed request as no longer waiting', async () => {
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await fileRequest(subscriber.token, 'other', `Request ${i}`);
    }
    const mine = await call<{ requests: ServiceRequest[] }>({
      path: '/api/me/requests',
      token: subscriber.token,
    });
    await call({
      method: 'PATCH',
      path: `/api/requests/${mine.body.requests[0]!.id}`,
      token: owner.token,
      body: { status: 'resolved' },
    });

    const next = await fileRequest(subscriber.token, 'other', 'Room freed up');
    expect(next.status).toBe(201);
  });
});

describe('GET /api/requests', () => {
  it('shows the owner every request with who filed it, open ones first', async () => {
    const first = await fileRequest(subscriber.token, 'meter_issue', 'Meter is stuck');
    await fileRequest(other.token, 'billing_question', 'Why is my bill higher');
    await call({
      method: 'PATCH',
      path: `/api/requests/${first.request.id}`,
      token: owner.token,
      body: { status: 'resolved', ownerNote: 'Replaced the meter' },
    });

    const res = await call<{ requests: ServiceRequestWithSubscriber[] }>({
      path: '/api/requests',
      token: owner.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(2);
    expect(res.body.requests[0]!.status).toBe('open');
    expect(res.body.requests[0]!.subscriberCode).toBe('1002');
    expect(res.body.requests[1]!.status).toBe('resolved');
  });

  it('filters by status and refuses a status that is not one of the four', async () => {
    await fileRequest(subscriber.token);
    const open = await call<{ requests: ServiceRequestWithSubscriber[] }>({
      path: '/api/requests?status=open',
      token: owner.token,
    });
    expect(open.body.requests).toHaveLength(1);

    const resolved = await call<{ requests: ServiceRequestWithSubscriber[] }>({
      path: '/api/requests?status=resolved',
      token: owner.token,
    });
    expect(resolved.body.requests).toHaveLength(0);

    const nonsense = await call({ path: '/api/requests?status=pending', token: owner.token });
    expect(nonsense.status).toBe(400);
  });

  it('refuses a collector and a subscriber', async () => {
    expect((await call({ path: '/api/requests', token: collector.token })).status).toBe(403);
    expect((await call({ path: '/api/requests', token: subscriber.token })).status).toBe(403);
  });
});

describe('PATCH /api/requests/:id', () => {
  it('notifies the subscriber on every move the owner makes', async () => {
    const created = await fileRequest(subscriber.token);

    const started = await call<{ request: ServiceRequest }>({
      method: 'PATCH',
      path: `/api/requests/${created.request.id}`,
      token: owner.token,
      body: { status: 'in_progress', ownerNote: 'Coming Thursday' },
    });
    expect(started.status).toBe(200);
    expect(started.body.request.status).toBe('in_progress');
    expect(started.body.request.ownerNote).toBe('Coming Thursday');
    expect(started.body.request.closedAt).toBeNull();

    const inbox = await call<{ notifications: { type: string; bodyEn: string }[] }>({
      path: '/api/me/notifications',
      token: subscriber.token,
    });
    expect(inbox.body.notifications).toHaveLength(1);
    expect(inbox.body.notifications[0]!.type).toBe('request_update');
    expect(inbox.body.notifications[0]!.bodyEn).toContain('In progress');
    expect(inbox.body.notifications[0]!.bodyEn).toContain('Coming Thursday');
  });

  it('stamps who closed it, and refuses a second close', async () => {
    const created = await fileRequest(subscriber.token);
    const closed = await call<{ request: ServiceRequest }>({
      method: 'PATCH',
      path: `/api/requests/${created.request.id}`,
      token: owner.token,
      body: { status: 'resolved' },
    });
    expect(closed.body.request.closedAt).not.toBeNull();
    expect(closed.body.request.closedBy).toBe(owner.id);

    const again = await call({
      method: 'PATCH',
      path: `/api/requests/${created.request.id}`,
      token: owner.token,
      body: { status: 'rejected' },
    });
    expect(again.status).toBe(409);
  });

  it('keeps the earlier note when a later move sends only a status', async () => {
    const created = await fileRequest(subscriber.token);
    await call({
      method: 'PATCH',
      path: `/api/requests/${created.request.id}`,
      token: owner.token,
      body: { ownerNote: 'Looked at it' },
    });
    const done = await call<{ request: ServiceRequest }>({
      method: 'PATCH',
      path: `/api/requests/${created.request.id}`,
      token: owner.token,
      body: { status: 'resolved' },
    });
    expect(done.body.request.ownerNote).toBe('Looked at it');
  });

  it('refuses an empty patch, an unknown id, a collector and a subscriber', async () => {
    const created = await fileRequest(subscriber.token);
    const path = `/api/requests/${created.request.id}`;

    expect((await call({ method: 'PATCH', path, token: owner.token, body: {} })).status).toBe(400);
    expect(
      (
        await call({
          method: 'PATCH',
          path: '/api/requests/9999',
          token: owner.token,
          body: { status: 'resolved' },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call({ method: 'PATCH', path, token: collector.token, body: { status: 'resolved' } }))
        .status,
    ).toBe(403);
    expect(
      (await call({ method: 'PATCH', path, token: subscriber.token, body: { status: 'resolved' } }))
        .status,
    ).toBe(403);
  });
});
