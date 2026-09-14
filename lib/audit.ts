/**
 * Audit log writer. Every change to money, to a subscriber's standing, or to a
 * cycle's state leaves a row here. Takes an optional transaction so an audit entry
 * commits or rolls back with the change it describes.
 */

import { query } from './db.js';
import type { Queryable } from './db.js';
import type { Actor, ActorType } from './types.js';

export interface AuditEntry {
  actorType: ActorType;
  actorId: number | null;
  action: string;
  entity: string;
  entityId: number | null;
  before?: unknown;
  after?: unknown;
}

export function actorFields(actor: Actor | null): Pick<AuditEntry, 'actorType' | 'actorId'> {
  if (actor === null) return { actorType: 'system', actorId: null };
  return { actorType: actor.kind, actorId: actor.id };
}

export async function writeAudit(entry: AuditEntry, tx?: Queryable): Promise<void> {
  const run = tx ? tx.query.bind(tx) : query;
  await run(
    `insert into audit_log (actor_type, actor_id, action, entity, entity_id, before_data, after_data)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.actorType,
      entry.actorId,
      entry.action,
      entry.entity,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}
