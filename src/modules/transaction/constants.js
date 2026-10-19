// Shared values of the Transaction module.
export const STATUS = Object.freeze({
  IN_PROGRESS: 'IN_PROGRESS',
  ON_HOLD: 'ON_HOLD',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  AUTO_CLOSED: 'AUTO_CLOSED',
});
export const STATUS_LIST = Object.freeze(Object.values(STATUS));
export const OPEN_STATUSES = Object.freeze([STATUS.IN_PROGRESS, STATUS.ON_HOLD]);

export const CLIENT_TYPES = Object.freeze(['STUDENT', 'ALUMNI', 'EMPLOYEE', 'EXTERNAL']);
export const CLASSIFICATIONS = Object.freeze(['SIMPLE', 'COMPLEX', 'HIGHLY_TECHNICAL']);

export const REASON_MAX = 500;

/** The actor recorded for work done by a job rather than a person (Decision G15). */
export const SYSTEM_ACTOR = Object.freeze({ actorUserId: null, actorRole: 'system' });

export const MSG = Object.freeze({
  CHOOSE_SERVICE: 'Choose a service',
  CLIENT_TYPE: 'Client type is required',
  EMAIL: 'Enter a valid email address',
  REQUIREMENTS: 'Confirm that all required documents are present before starting',
  COUNTER: 'Choose your counter',
  OPEN_EXISTS: 'You already have an open transaction. Complete or hand it over first.',
  COUNTER_BUSY: 'This counter already has an open transaction',
  NO_STANDARD_TODAY: 'No standard is in force for this service today',
  CATALOGUE_DOWN: 'Cannot reach the service catalogue right now. Try again, or record the transaction later as a backdated entry.',
  CALENDAR_DOWN: 'Cannot reach the calendar right now. The transaction stays on hold; try again.',
  HOLD_OFF: 'Hold is turned off for this institution',
  HOLD_REASON: 'Enter a reason for the hold',
  NOT_IN_PROGRESS: 'This transaction is not in progress',
  NOT_ON_HOLD: 'This transaction is not on hold',
  RESUME_FIRST: 'Resume the transaction before completing it',
  CANCEL_REASON: 'Enter a reason for cancelling',
  CANCEL_STATE: 'Only open transactions can be cancelled',
  BACKDATE_REASON: 'Enter why this time is entered after the fact',
  FUTURE: 'Time cannot be in the future',
  END_AFTER_START: 'End must be after start',
});
