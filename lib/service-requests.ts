/**
 * Service requests. A subscriber writes one; the owner answers it by moving its
 * status and leaving a note. Every move the owner makes writes a notification back
 * to the subscriber, because a request that goes quiet is worse than no request at
 * all: the person phones anyway, and the written record stops being the truth.
 */

import { query, maybeOne, transaction } from './db.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { writeAudit, actorFields } from './audit.js';
import { insertNotifications, requestUpdateText } from './notify.js';
import { dispatchToSubscribers } from './push.js';
import {
  asObject,
  oneOf,
  optionalOneOf,
  optionalString,
  rejectUnknownFields,
  requiredString,
} from './validate.js';
import type {
  Actor,
  ServiceRequest,
  ServiceRequestKind,
  ServiceRequestStatus,
  ServiceRequestWithSubscriber,
} from './types.js';

const KINDS: readonly ServiceRequestKind[] = [
  'meter_issue',
  'new_connection',
  'disconnect',
  'billing_question',
  'other',
];

const STATUSES: readonly ServiceRequestStatus[] = ['open', 'in_progress', 'resolved', 'rejected'];

const BODY_MAX = 1_000;
const NOTE_MAX = 1_000;

/**
 * A subscriber with five requests already waiting is not being ignored by the owner,
 * they are filling the queue. The cap keeps one person from burying everyone else.
 */
const MAX_OPEN_PER_SUBSCRIBER = 5;

/** Once a request is answered it stays answered; a new problem is a new request. */
const TERMINAL = new Set<ServiceRequestStatus>(['resolved', 'rejected']);

interface RequestRow extends Record<string, unknown> {
  id: number;
  subscriber_id: number;
  kind: ServiceRequestKind;
  body: string;
  status: ServiceRequestStatus;
  owner_note: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  closed_by: number | null;
}

interface RequestWithSubscriberRow extends RequestRow {
  subscriber_code: string;
  subscriber_name: string;
  subscriber_phone: string | null;
}

function toRequest(row: RequestRow): ServiceRequest {
  return {
    id: row.id,
    subscriberId: row.subscriber_id,
    kind: row.kind,
    body: row.body,
    status: row.status,
    ownerNote: row.owner_note,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
    closedBy: row.closed_by,
  };
}

function toRequestWithSubscriber(row: RequestWithSubscriberRow): ServiceRequestWithSubscriber {
  return {
    ...toRequest(row),
    subscriberCode: row.subscriber_code,
    subscriberName: row.subscriber_name,
    subscriberPhone: row.subscriber_phone,
  };
}

const COLUMNS = `id, subscriber_id, kind, body, status, owner_note, created_at, updated_at,
                 closed_at, closed_by`;

export interface RequestInput {
  kind: ServiceRequestKind;
  body: string;
}

export function parseRequestInput(body: unknown): RequestInput {
  const input = asObject(body);
  rejectUnknownFields(input, ['kind', 'body']);
  return {
    kind: oneOf(input, 'kind', KINDS),
    body: requiredString(input, 'body', { maxLength: BODY_MAX }),
  };
}

export interface RequestPatch {
  status: ServiceRequestStatus | null;
  ownerNote: string | null;
}

export function parseRequestPatch(body: unknown): RequestPatch {
  const input = asObject(body);
  rejectUnknownFields(input, ['status', 'ownerNote']);
  const patch: RequestPatch = {
    status: optionalOneOf(input, 'status', STATUSES),
    ownerNote: optionalString(input, 'ownerNote', { maxLength: NOTE_MAX }),
  };
  if (patch.status === null && patch.ownerNote === null) {
    throw new ValidationError('Send a status, a note, or both');
  }
  return patch;
}

export async function createRequest(
  subscriberId: number,
  body: unknown,
  actor: Actor,
): Promise<ServiceRequest> {
  const input = parseRequestInput(body);

  const open = await maybeOne<{ count: number }>(
    `select count(*)::bigint as count from service_requests
      where subscriber_id = $1 and status in ('open', 'in_progress')`,
    [subscriberId],
  );
  if ((open?.count ?? 0) >= MAX_OPEN_PER_SUBSCRIBER) {
    throw new ConflictError('You already have requests waiting for an answer', {
      messageAr: 'لديك طلبات بانتظار الرد. انتظر الرد عليها قبل إرسال طلب جديد.',
      openRequests: open?.count ?? 0,
    });
  }

  const rows = await query<RequestRow>(
    `insert into service_requests (subscriber_id, kind, body)
     values ($1, $2, $3)
     returning ${COLUMNS}`,
    [subscriberId, input.kind, input.body],
  );
  const request = toRequest(rows[0]!);

  await writeAudit({
    ...actorFields(actor),
    action: 'request.create',
    entity: 'service_request',
    entityId: request.id,
    after: request,
  });

  return request;
}

export async function subscriberRequests(subscriberId: number): Promise<ServiceRequest[]> {
  const rows = await query<RequestRow>(
    `select ${COLUMNS} from service_requests
      where subscriber_id = $1
      order by created_at desc, id desc
      limit 100`,
    [subscriberId],
  );
  return rows.map(toRequest);
}

export interface RequestListQuery {
  status?: string | null;
}

export async function listRequests(
  params: RequestListQuery,
): Promise<ServiceRequestWithSubscriber[]> {
  const status = params.status ?? null;
  if (status !== null && !STATUSES.includes(status as ServiceRequestStatus)) {
    throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`, { field: 'status' });
  }
  const rows = await query<RequestWithSubscriberRow>(
    `select r.id, r.subscriber_id, r.kind, r.body, r.status, r.owner_note, r.created_at,
            r.updated_at, r.closed_at, r.closed_by,
            s.code as subscriber_code, s.name as subscriber_name, s.phone as subscriber_phone
       from service_requests r
       join subscribers s on s.id = r.subscriber_id
      where $1::text is null or r.status = $1
      order by
        case r.status when 'open' then 0 when 'in_progress' then 1 else 2 end,
        r.created_at desc
      limit 200`,
    [status],
  );
  return rows.map(toRequestWithSubscriber);
}

export async function getRequest(id: number): Promise<ServiceRequest> {
  const row = await maybeOne<RequestRow>(`select ${COLUMNS} from service_requests where id = $1`, [
    id,
  ]);
  if (row === null) throw new NotFoundError('service_request', id);
  return toRequest(row);
}

export async function updateRequest(
  id: number,
  body: unknown,
  actor: Actor,
): Promise<ServiceRequest> {
  const patch = parseRequestPatch(body);
  const before = await getRequest(id);

  if (TERMINAL.has(before.status)) {
    throw new ConflictError('That request is already closed', {
      messageAr: 'هذا الطلب مغلق. افتح طلبا جديدا بدل تعديله.',
      status: before.status,
    });
  }

  const status = patch.status ?? before.status;
  const closing = TERMINAL.has(status);

  const updated = await transaction(async (tx) => {
    const rows = await tx.query<RequestRow>(
      `update service_requests
          set status = $2,
              owner_note = coalesce($3, owner_note),
              updated_at = now(),
              closed_at = case when $4::boolean then now() else null end,
              closed_by = case when $4::boolean then $5::bigint else null end
        where id = $1 and status not in ('resolved', 'rejected')
        returning ${COLUMNS}`,
      [id, status, patch.ownerNote, closing, actor.id],
    );
    // Another owner may have closed it between the read above and this update.
    const row = rows[0];
    if (row === undefined) {
      throw new ConflictError('That request was closed by someone else', {
        messageAr: 'أغلق شخص آخر هذا الطلب للتو.',
      });
    }
    const next = toRequest(row);

    await insertNotifications(tx, [
      {
        subscriberId: next.subscriberId,
        type: 'request_update',
        billId: null,
        requestId: next.id,
        createdBy: actor.id,
        text: requestUpdateText({
          kind: next.kind,
          status: next.status,
          ownerNote: patch.ownerNote,
        }),
      },
    ]);

    await writeAudit(
      {
        ...actorFields(actor),
        action: 'request.update',
        entity: 'service_request',
        entityId: next.id,
        before,
        after: next,
      },
      tx,
    );

    return next;
  });

  const text = requestUpdateText({
    kind: updated.kind,
    status: updated.status,
    ownerNote: patch.ownerNote,
  });
  // Best effort. The inbox row written above is the channel that has to be there.
  await dispatchToSubscribers([updated.subscriberId], {
    title: text.titleEn,
    body: text.bodyEn,
    url: '/requests',
  }).catch((err: unknown) => {
    console.error(
      JSON.stringify({ action: 'push.dispatch', requestId: updated.id, error: String(err) }),
    );
  });

  return updated;
}
