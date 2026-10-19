import { OutboxEvent, RateLimitHit } from 'ccms-shared';
import { EntitySchema } from 'typeorm';

// ---- Transaction (ERD section 4, with the Sprint 4 additions approved on 10/18, Decision G15) ----

// One row, id always 1 (a CHECK in after-sync). Created on first start with the defaults:
// hold off (B20), counters off (B22), auto-close off for every classification (B21).
export const TransactionSettings = new EntitySchema({
  name: 'TransactionSettings',
  tableName: 'transaction_settings',
  columns: {
    id: { type: 'smallint', primary: true },
    holdEnabled: { name: 'hold_enabled', type: 'boolean', default: false },
    countersEnabled: { name: 'counters_enabled', type: 'boolean', default: false },
    autoCloseDaysSimple: { name: 'auto_close_days_simple', type: 'int', nullable: true },
    autoCloseDaysComplex: { name: 'auto_close_days_complex', type: 'int', nullable: true },
    autoCloseDaysHighlyTechnical: { name: 'auto_close_days_highly_technical', type: 'int', nullable: true },
    version: { type: 'int', default: 1 },
    updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
    updatedBy: { name: 'updated_by', type: 'uuid', nullable: true },
  },
});

// A service counter of one office. Never deleted, only deactivated. office_id is a plain ID (Core owns offices).
export const Counter = new EntitySchema({
  name: 'Counter',
  tableName: 'counters',
  columns: {
    counterId: { name: 'counter_id', type: 'uuid', primary: true },
    officeId: { name: 'office_id', type: 'uuid' },
    label: { type: 'varchar', length: 50 },
    isActive: { name: 'is_active', type: 'boolean', default: true },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
  },
});

// One tracking-number sequence per office and Manila date. Updated in the same database transaction as the start.
export const TrackingSequence = new EntitySchema({
  name: 'TrackingSequence',
  tableName: 'tracking_sequences',
  columns: {
    officeId: { name: 'office_id', type: 'uuid', primary: true },
    seqDate: { name: 'seq_date', type: 'date', primary: true },
    lastSeq: { name: 'last_seq', type: 'int', default: 0 },
  },
});

// A citizen's transaction. The standard in force at the start, the service, the office and its classification are
// COPIED here (B4): later Charter changes never change a past result. Exactly two timestamps (started_at, ended_at, B1).
// Result columns stay empty until the compliance result is computed.
export const Transaction = new EntitySchema({
  name: 'Transaction',
  tableName: 'transactions',
  columns: {
    transactionId: { name: 'transaction_id', type: 'uuid', primary: true },
    trackingNo: { name: 'tracking_no', type: 'varchar', length: 60 },
    serviceId: { name: 'service_id', type: 'uuid' },
    serviceCode: { name: 'service_code', type: 'text' },
    serviceName: { name: 'service_name', type: 'text' },
    officeId: { name: 'office_id', type: 'uuid' },
    officeCode: { name: 'office_code', type: 'varchar', length: 20 },
    serviceClassification: { name: 'service_classification', type: 'varchar', length: 20 },
    standardId: { name: 'standard_id', type: 'uuid' },
    standardDurationDays: { name: 'standard_duration_days', type: 'int' },
    standardDurationHours: { name: 'standard_duration_hours', type: 'int' },
    standardDurationMinutes: { name: 'standard_duration_minutes', type: 'int' },
    counterId: { name: 'counter_id', type: 'uuid', nullable: true },
    clientType: { name: 'client_type', type: 'varchar', length: 20 },
    clientReference: { name: 'client_reference', type: 'varchar', length: 100, nullable: true },
    clientEmail: { name: 'client_email', type: 'varchar', length: 254, nullable: true },
    startedAt: { name: 'started_at', type: 'timestamptz' },
    startedBy: { name: 'started_by', type: 'uuid' },
    endedAt: { name: 'ended_at', type: 'timestamptz', nullable: true },
    endedBy: { name: 'ended_by', type: 'uuid', nullable: true },
    status: { type: 'varchar', length: 20 },
    elapsedWorkingMinutes: { name: 'elapsed_working_minutes', type: 'int', nullable: true },
    isCompliant: { name: 'is_compliant', type: 'boolean', nullable: true },
    varianceMinutes: { name: 'variance_minutes', type: 'int', nullable: true },
    cancelReason: { name: 'cancel_reason', type: 'text', nullable: true },
    backdateReason: { name: 'backdate_reason', type: 'text', nullable: true },
    isBackdated: { name: 'is_backdated', type: 'boolean', default: false },
    heldMinutes: { name: 'held_minutes', type: 'int', default: 0 },
    holdReason: { name: 'hold_reason', type: 'text', nullable: true },
    holdStartedAt: { name: 'hold_started_at', type: 'timestamptz', nullable: true },
    // Ticketing is not part of Sprint 4 (QueueTicket is a stub in the ERD); the columns exist in the ERD and stay empty.
    queueTicketId: { name: 'queue_ticket_id', type: 'uuid', nullable: true },
    queueWaitMinutes: { name: 'queue_wait_minutes', type: 'int', nullable: true },
    receiptEmailStatus: { name: 'receipt_email_status', type: 'varchar', length: 10, default: 'NONE' },
    receiptEmailAttempts: { name: 'receipt_email_attempts', type: 'int', default: 0 },
    version: { type: 'int', default: 1 },
  },
});

export const entities = [TransactionSettings, Counter, TrackingSequence, Transaction, OutboxEvent, RateLimitHit];
