import { createHash, timingSafeEqual } from 'node:crypto';
import { Errors } from './errors.js';

export const SERVICE_KEY_HEADER = 'x-service-key';

function digest(value) {
  return createHash('sha256').update(value).digest();
}

/** True when the request carries the shared service key. Never throws. */
export function hasValidServiceKey(request, expected = process.env.SERVICE_KEY) {
  const provided = request.headers.get(SERVICE_KEY_HEADER);
  if (!expected || !provided) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

/** For backend-only endpoints: 401 unless the shared service key is present and correct. */
export function requireServiceKey(request, expected = process.env.SERVICE_KEY) {
  if (!expected) throw new Error('SERVICE_KEY is not configured');
  if (!hasValidServiceKey(request, expected)) {
    throw Errors.unauthorized('Service key required', 'INVALID_SERVICE_KEY');
  }
}

export function serviceHeaders(correlationId, key = process.env.SERVICE_KEY) {
  return {
    'x-service-key': key ?? '',
    ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
  };
}
