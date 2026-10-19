import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'x-correlation-id';

export function getCorrelationId(request) {
  const incoming = request?.headers?.get?.(CORRELATION_HEADER);
  // Accept a caller-supplied id only when it looks safe to echo back into logs and headers.
  if (incoming && /^[A-Za-z0-9._-]{8,128}$/.test(incoming)) return incoming;
  return randomUUID();
}

export function correlationHeaders(correlationId, extra = {}) {
  return { 'X-Correlation-Id': correlationId, ...extra };
}
