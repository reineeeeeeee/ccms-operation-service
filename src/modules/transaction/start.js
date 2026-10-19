import { randomUUID } from 'node:crypto';
import { Errors, assertOfficeAccess, isUniqueViolation, isUuid, recordAudit, toManilaDate } from 'ccms-shared';
import { kickOutbox, kickReceipts } from '../../lib/outbox.js';
import { CoreRejectedError, CoreUnavailableError } from './core-client.js';
import { CLIENT_TYPES, MSG, STATUS } from './constants.js';
import { loadTransactionRow, rowsOf } from './db.js';
import { toTransactionDto } from './dto.js';
import { computeAndStoreResult } from './complete.js';
import { readSettingsRow } from './settings.js';
import { parseBackdate, usDate } from './time.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates the body of POST /transactions (CC021; CC026 adds started_at, ended_at and backdate_reason).
 * Collects every problem by field name and throws one 400.
 */
export function parseStartInput(body, { now }) {
  const details = {};
  const serviceId = typeof body.service_id === 'string' ? body.service_id.trim() : '';
  if (!isUuid(serviceId)) details.service_id = MSG.CHOOSE_SERVICE;
  if (!CLIENT_TYPES.includes(body.client_type)) details.client_type = MSG.CLIENT_TYPE;

  let clientReference = null;
  if (body.client_reference !== undefined && body.client_reference !== null) {
    if (typeof body.client_reference !== 'string') details.client_reference = 'Client reference must be text';
    else if (body.client_reference.trim().length > 100) details.client_reference = 'Client reference must be 100 characters or fewer';
    else clientReference = body.client_reference.trim() || null;
  }
  let clientEmail = null;
  if (body.client_email !== undefined && body.client_email !== null) {
    const email = typeof body.client_email === 'string' ? body.client_email.trim() : null;
    if (email === null || email.length > 254 || (email !== '' && !EMAIL_RE.test(email))) details.client_email = MSG.EMAIL;
    else clientEmail = email || null;
  }
  if (body.requirements_confirmed !== true) details.requirements_confirmed = MSG.REQUIREMENTS;

  let counterId = null;
  if (body.counter_id !== undefined && body.counter_id !== null && body.counter_id !== '') {
    if (typeof body.counter_id === 'string' && isUuid(body.counter_id.trim())) counterId = body.counter_id.trim();
    else details.counter_id = MSG.COUNTER;
  }

  let backdate = { startedAt: null, endedAt: null, backdateReason: null };
  try {
    backdate = parseBackdate(body, { now });
  } catch (err) {
    Object.assign(details, err.details ?? {});
  }
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
  return { serviceId, clientType: body.client_type, clientReference, clientEmail, counterId, ...backdate };
}

/** Looks the standard in force up in Core (one retry inside the client) and turns Core's answers into Operations errors. */
async function lookUpStandard(core, serviceId, asOf, { backdated }) {
  try {
    return await core.standardAsOf(serviceId, asOf);
  } catch (err) {
    if (err instanceof CoreUnavailableError) throw Errors.unavailable(MSG.CATALOGUE_DOWN, 'CATALOGUE_UNAVAILABLE');
    if (err instanceof CoreRejectedError) {
      if (err.code === 'SERVICE_NOT_FOUND' || (err.status === 404 && err.code !== 'STANDARD_NOT_FOUND')) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
      if (err.code === 'SERVICE_INACTIVE') throw Errors.conflict('Service inactive', 'SERVICE_INACTIVE');
      if (err.code === 'STANDARD_NOT_FOUND') {
        const message = backdated ? `No standard was in force for this service on ${usDate(asOf)}` : MSG.NO_STANDARD_TODAY;
        throw Errors.conflict(message, 'STANDARD_NOT_IN_FORCE');
      }
      throw Errors.unavailable(MSG.CATALOGUE_DOWN, 'CATALOGUE_UNAVAILABLE');
    }
    throw err;
  }
}

function trackingNo(officeCode, manilaDate, sequence) {
  return `${officeCode}-${manilaDate.replaceAll('-', '')}-${String(sequence).padStart(4, '0')}`;
}

function mapUnique(err) {
  if (isUniqueViolation(err, 'transactions_one_open_per_staff_uq')) return Errors.conflict(MSG.OPEN_EXISTS, 'OPEN_TRANSACTION_EXISTS');
  if (isUniqueViolation(err, 'transactions_one_open_per_counter_uq')) return Errors.conflict(MSG.COUNTER_BUSY, 'COUNTER_BUSY');
  return null;
}

/**
 * CC021 Start a transaction (and CC026 when started_at / ended_at are supplied).
 *
 *  1. validate the body (400, nothing else happens);
 *  2. read the settings; ask Core for the standard in force on the Manila date of the start (one retry; if Core cannot
 *     be reached the start is blocked with 503 and nothing is saved, B13);
 *  3. check the office (Office Head / Staff: their own office, else 403);
 *  4. in ONE database transaction: take the next tracking number of that office and Manila date, copy the service,
 *     office, classification and the standard onto the new row, and write the audit event. A failure rolls back the
 *     number as well. started_at is the server time of the request unless the user supplied it.
 * The one-open rules are enforced by two partial unique indexes: one per staff account, one per counter.
 */
export async function startTransaction(dataSource, { core, now = () => new Date() }, user, body, { ipAddress } = {}) {
  const requestTime = now();
  const input = parseStartInput(body, { now: requestTime });
  const backdated = input.startedAt !== null;
  const startedAt = input.startedAt ?? requestTime;
  const manilaDate = toManilaDate(startedAt);

  const settings = await readSettingsRow(dataSource);
  if (settings.counters_enabled && !input.counterId) {
    throw Errors.validation(MSG.COUNTER, { counter_id: MSG.COUNTER });
  }

  const standard = await lookUpStandard(core, input.serviceId, manilaDate, { backdated });
  assertOfficeAccess(user, standard.office_id);

  const transactionId = randomUUID();
  const completed = input.endedAt !== null;
  try {
    await dataSource.transaction(async (manager) => {
      let counterId = null;
      if (settings.counters_enabled) {
        const counters = await manager.query('SELECT counter_id, office_id, is_active FROM counters WHERE counter_id = $1', [input.counterId]);
        const counter = counters[0];
        if (!counter || !counter.is_active || String(counter.office_id) !== String(standard.office_id)) {
          throw Errors.validation(MSG.COUNTER, { counter_id: MSG.COUNTER });
        }
        counterId = counter.counter_id;
      }

      const [{ last_seq: sequence }] = rowsOf(
        await manager.query(
          `INSERT INTO tracking_sequences (office_id, seq_date, last_seq) VALUES ($1, $2, 1)
           ON CONFLICT (office_id, seq_date) DO UPDATE SET last_seq = tracking_sequences.last_seq + 1
           RETURNING last_seq`,
          [standard.office_id, manilaDate],
        ),
      );
      const number = trackingNo(standard.office_code, manilaDate, sequence);

      await manager.query(
        `INSERT INTO transactions (
           transaction_id, tracking_no, service_id, service_code, service_name, office_id, office_code, service_classification,
           standard_id, standard_duration_days, standard_duration_hours, standard_duration_minutes, counter_id, client_type,
           client_reference, client_email, started_at, started_by, ended_at, ended_by, status, is_backdated, backdate_reason,
           receipt_email_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [
          transactionId, number, input.serviceId, standard.service_code, standard.service_name, standard.office_id, standard.office_code,
          standard.classification, standard.standard_id, standard.duration_days, standard.duration_hours, standard.duration_minutes,
          counterId, input.clientType, input.clientReference, input.clientEmail, startedAt, user.id,
          completed ? input.endedAt : null, completed ? user.id : null,
          completed ? STATUS.COMPLETED : STATUS.IN_PROGRESS, backdated, input.backdateReason,
          completed && input.clientEmail ? 'PENDING' : 'NONE',
        ],
      );

      // The audit trail never carries the citizen's email or reference (personal data).
      await recordAudit(manager, {
        actor: user,
        action: 'TRANSACTION_STARTED',
        entityType: 'transaction',
        entityId: transactionId,
        officeId: standard.office_id,
        after: {
          tracking_no: number,
          service_id: input.serviceId,
          service_code: standard.service_code,
          standard_id: standard.standard_id,
          standard_duration_days: standard.duration_days,
          standard_duration_hours: standard.duration_hours,
          standard_duration_minutes: standard.duration_minutes,
          client_type: input.clientType,
          counter_id: counterId,
          requirements_confirmed: true,
        },
        ipAddress,
      });
      if (backdated) {
        await recordAudit(manager, {
          actor: user,
          action: 'TRANSACTION_BACKDATED',
          entityType: 'transaction',
          entityId: transactionId,
          officeId: standard.office_id,
          after: { field: 'started_at', value: startedAt.toISOString(), reason: input.backdateReason },
          ipAddress,
        });
      }
      if (completed) {
        await recordAudit(manager, {
          actor: user,
          action: 'TRANSACTION_BACKDATED',
          entityType: 'transaction',
          entityId: transactionId,
          officeId: standard.office_id,
          after: { field: 'ended_at', value: input.endedAt.toISOString(), reason: input.backdateReason },
          ipAddress,
        });
        await recordAudit(manager, {
          actor: user,
          action: 'TRANSACTION_COMPLETED',
          entityType: 'transaction',
          entityId: transactionId,
          officeId: standard.office_id,
          before: { status: STATUS.IN_PROGRESS },
          after: { status: STATUS.COMPLETED, ended_at: input.endedAt.toISOString() },
          ipAddress,
        });
      }
    });
  } catch (err) {
    throw mapUnique(err) ?? err;
  }
  kickOutbox();

  if (completed) {
    // Recorded after the fact in one call: work out the result right away (Core down: it stays pending for the job).
    const row = await loadTransactionRow(dataSource, transactionId);
    await computeAndStoreResult(dataSource, core, row, { actor: user, ipAddress });
    if (input.clientEmail) kickReceipts();
  }
  return toTransactionDto(await loadTransactionRow(dataSource, transactionId));
}
