import { CORRELATION_HEADER } from './correlation.js';

// Standard error format for every CCMS service:
// { error: { code, message, details, correlation_id, timestamp } }
export class AppError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  badRequest: (message = 'Invalid request', details = null, code = 'BAD_REQUEST') =>
    new AppError(400, code, message, details),
  validation: (message = 'Validation failed', details = null) =>
    new AppError(400, 'VALIDATION_ERROR', message, details),
  unauthorized: (message = 'Authentication required', code = 'UNAUTHORIZED') =>
    new AppError(401, code, message),
  forbidden: (message = 'You do not have permission to perform this action', code = 'FORBIDDEN') =>
    new AppError(403, code, message),
  notFound: (message = 'Not found', code = 'NOT_FOUND') => new AppError(404, code, message),
  conflict: (message, code = 'CONFLICT', details = null) => new AppError(409, code, message, details),
  unavailable: (message, code = 'SERVICE_UNAVAILABLE') => new AppError(503, code, message),
};

export function buildErrorBody({ code, message, details = null, correlationId }) {
  return {
    error: {
      code,
      message,
      details,
      correlation_id: correlationId,
      timestamp: new Date().toISOString(),
    },
  };
}

// Turns any thrown value into a standard error Response. Unknown errors are logged on the server
// (with their stack) but the response never carries a stack trace or internal message.
export function errorResponse(err, correlationId) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong. Please try again.';
  let details = null;

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else {
    console.error(
      JSON.stringify({
        level: 'error',
        correlation_id: correlationId,
        message: err?.message,
        stack: err?.stack,
      }),
    );
  }

  return new Response(JSON.stringify(buildErrorBody({ code, message, details, correlationId })), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      [CORRELATION_HEADER]: correlationId,
    },
  });
}
