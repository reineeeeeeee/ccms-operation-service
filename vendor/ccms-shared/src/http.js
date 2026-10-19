import { CORRELATION_HEADER, getCorrelationId } from './correlation.js';
import { Errors, errorResponse } from './errors.js';

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function noContent(headers = {}) {
  return new Response(null, { status: 204, headers });
}

// Wraps a Next.js route handler: assigns/propagates X-Correlation-Id, awaits route params, and
// converts any thrown error into the standard error format.
export function route(handler) {
  return async function wrapped(request, context = {}) {
    const correlationId = getCorrelationId(request);
    try {
      const params = context.params ? await context.params : {};
      const response = await handler(request, { params, correlationId });
      response.headers.set(CORRELATION_HEADER, correlationId);
      return response;
    } catch (err) {
      return errorResponse(err, correlationId);
    }
  };
}

export async function readJson(request) {
  const text = await request.text().catch(() => '');
  if (!text) throw Errors.validation('Request body is required');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw Errors.badRequest('Request body must be a valid JSON object', null, 'INVALID_JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Errors.badRequest('Request body must be a valid JSON object', null, 'INVALID_JSON');
  }
  return value;
}

export function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}
