import { Queryable, query } from '../db/pool';

export async function audit(
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
  db?: Queryable,
) {
  await query(
    'INSERT INTO audit_logs (actor_id, action, entity, entity_id, metadata) VALUES ($1, $2, $3, $4, $5)',
    [actorId, action, entity, entityId, JSON.stringify(metadata)],
    db,
  );
}
