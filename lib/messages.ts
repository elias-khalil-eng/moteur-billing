/**
 * Messages the owner writes: to one subscriber, or to everyone active. They land in
 * the same inbox as bills and payments, so a subscriber has one place to look and
 * one place that keeps a record. Push is best effort on top of that row.
 *
 * The owner writes in their own words, in whichever language they use. Nothing here
 * translates them: a machine-made Arabic no one wrote is worse than the real sentence.
 */

import { query, transaction } from './db.js';
import { NotFoundError } from './errors.js';
import { writeAudit, actorFields } from './audit.js';
import { insertNotifications, ownerMessageText } from './notify.js';
import { dispatchToSubscribers } from './push.js';
import { asObject, optionalInteger, rejectUnknownFields, requiredString } from './validate.js';
import type { Actor } from './types.js';
import type { NotificationRow } from './notify.js';

const TITLE_MAX = 120;
const BODY_MAX = 1_000;

/** One insert per chunk, so a few hundred subscribers never build a statement too wide. */
const CHUNK = 200;

export interface MessageInput {
  title: string;
  body: string;
  /** null means every subscriber. */
  subscriberId: number | null;
}

export function parseMessageInput(body: unknown): MessageInput {
  const input = asObject(body);
  rejectUnknownFields(input, ['title', 'body', 'subscriberId']);
  return {
    title: requiredString(input, 'title', { maxLength: TITLE_MAX }),
    body: requiredString(input, 'body', { maxLength: BODY_MAX }),
    subscriberId: optionalInteger(input, 'subscriberId', { min: 1 }),
  };
}

export interface SentMessage {
  recipients: number;
}

async function recipientIds(subscriberId: number | null): Promise<number[]> {
  if (subscriberId !== null) {
    const rows = await query<{ id: number }>(
      'select id from subscribers where id = $1 and deleted_at is null',
      [subscriberId],
    );
    if (rows.length === 0) throw new NotFoundError('subscriber', subscriberId);
    return [rows[0]!.id];
  }
  // A suspended or disconnected subscriber still owes money and still reads the app,
  // so a broadcast reaches them too; only a deleted row is skipped.
  const rows = await query<{ id: number }>(
    'select id from subscribers where deleted_at is null order by id',
  );
  return rows.map((row) => row.id);
}

export async function sendOwnerMessage(body: unknown, actor: Actor): Promise<SentMessage> {
  const input = parseMessageInput(body);
  const ids = await recipientIds(input.subscriberId);
  const text = ownerMessageText({ title: input.title, body: input.body });

  await transaction(async (tx) => {
    for (let start = 0; start < ids.length; start += CHUNK) {
      const rows: NotificationRow[] = ids.slice(start, start + CHUNK).map((id) => ({
        subscriberId: id,
        type: 'owner_message' as const,
        billId: null,
        requestId: null,
        createdBy: actor.id,
        text,
      }));
      // Chunks are ordered inserts inside one transaction; they cannot run in parallel.
      // eslint-disable-next-line no-await-in-loop
      await insertNotifications(tx, rows);
    }

    await writeAudit(
      {
        ...actorFields(actor),
        action: input.subscriberId === null ? 'message.broadcast' : 'message.direct',
        entity: 'notification',
        entityId: input.subscriberId,
        after: { title: input.title, recipients: ids.length },
      },
      tx,
    );
  });

  await dispatchToSubscribers(ids, {
    title: input.title,
    body: input.body,
    url: '/notifications',
  }).catch((err: unknown) => {
    console.error(
      JSON.stringify({ action: 'push.dispatch', message: 'owner', error: String(err) }),
    );
  });

  return { recipients: ids.length };
}
