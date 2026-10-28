import { randomUUID } from 'node:crypto';
import { auditEntityName } from './audit-name.js';
import { OutboxEvent } from './db.js';

/**
 * Writes an audit event to the local outbox using the SAME transaction as the business change,
 * so an event exists if and only if the change committed.
 *
 *   await dataSource.transaction(async (manager) => {
 *     ...business change using manager...
 *     await recordAudit(manager, { actor: user, action: 'ACCOUNT_CREATED', entityType: 'account', ... });
 *   });
 */
export async function recordAudit(manager, event) {
  const auditId = event.auditId ?? randomUUID();
  const payload = {
    audit_id: auditId,
    actor_user_id: event.actor?.id ?? event.actorUserId,
    actor_role: event.actor?.role ?? event.actorRole,
    action: event.action,
    entity_type: event.entityType,
    entity_name: auditEntityName(event),
    entity_id: event.entityId == null ? null : String(event.entityId),
    office_id: event.officeId ?? null,
    before_value: event.before ?? null,
    after_value: event.after ?? null,
    ip_address: event.ipAddress ?? null,
    occurred_at: (event.occurredAt ?? new Date()).toISOString(),
  };
  await manager.createQueryBuilder().insert().into(OutboxEvent).values({ auditId, payload }).orIgnore().execute();
  return auditId;
}

function backoffSeconds(attempts) {
  return Math.min(5 * 2 ** attempts, 3600);
}

/**
 * Sends one batch of unsent outbox events to the Logs service (with the shared key), marks them sent, and
 * schedules a retry with backoff on failure. Each event carries its own audit_id, so a re-send
 * (for example after a lost response) never creates a duplicate entry in Logs.
 */
export async function dispatchOutbox(
  dataSource,
  { logsUrl, serviceKey, batchSize = 50, fetchImpl = fetch, timeoutMs = 5000, leaseSeconds = 60 },
) {
  const repo = dataSource.getRepository(OutboxEvent);
  // Claim a batch atomically: rows another run is working on are skipped (SKIP LOCKED) and the claimed
  // rows are pushed forward by leaseSeconds, so two overlapping cron runs never send the same event.
  // If this run dies midway, the lease simply expires and the event is retried.
  const claimed = await dataSource.query(
    `UPDATE audit_outbox SET next_attempt_at = now() + make_interval(secs => $2)
     WHERE audit_id IN (
       SELECT audit_id FROM audit_outbox
       WHERE sent_at IS NULL AND next_attempt_at <= now()
       ORDER BY created_at ASC LIMIT $1
       FOR UPDATE SKIP LOCKED)
     RETURNING audit_id, payload, attempts, created_at`,
    [batchSize, leaseSeconds],
  );
  // TypeORM returns [rows, count] for UPDATE ... RETURNING.
  const claimedRows = Array.isArray(claimed[0]) ? claimed[0] : claimed;
  const rows = claimedRows
    .map((r) => ({ auditId: r.audit_id, payload: r.payload, attempts: r.attempts, createdAt: r.created_at }))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const response = await fetchImpl(`${logsUrl.replace(/\/$/, '')}/audit-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-key': serviceKey,
          'x-correlation-id': randomUUID(),
        },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Logs service responded ${response.status}`);
      await repo.update({ auditId: row.auditId }, { sentAt: () => 'now()', attempts: row.attempts + 1, lastError: null });
      sent += 1;
    } catch (err) {
      await repo.update(
        { auditId: row.auditId },
        {
          attempts: row.attempts + 1,
          lastError: String(err.message).slice(0, 500),
          nextAttemptAt: new Date(Date.now() + backoffSeconds(row.attempts) * 1000),
        },
      );
      failed += 1;
    }
  }
  return { sent, failed };
}
