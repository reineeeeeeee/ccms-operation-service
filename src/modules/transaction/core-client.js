import { randomUUID } from 'node:crypto';

/**
 * The only way Operations talks to Core (Catalogue + Calendar): fetch with the shared service key, a 5 second timeout
 * and ONE retry on a network error, a timeout or a 5xx answer. A 4xx answer is Core's decision and is passed on unchanged.
 *
 *   CoreUnavailableError   Core could not be reached (or answered 5xx / an unreadable body) even after the retry
 *   CoreRejectedError      Core answered 4xx: { status, code, message, details } from its standard error body
 */
export class CoreUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoreUnavailableError';
  }
}

export class CoreRejectedError extends Error {
  constructor(status, error = {}) {
    super(error.message ?? `Core answered ${status}`);
    this.name = 'CoreRejectedError';
    this.status = status;
    this.code = error.code ?? null;
    this.details = error.details ?? null;
  }
}

/** CORE_URL with or without the trailing /api (the gateway's CORE_URL has none, LOGS_SERVICE_URL has one). */
export function coreBaseUrl(env = process.env) {
  const raw = String(env.CORE_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  return raw.endsWith('/api') ? raw : `${raw}/api`;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isWholeNumber = (value) => Number.isInteger(value) && value >= 0;
const invalid = (what) => new CoreUnavailableError(`Core sent an unreadable ${what}`);

export function createCoreClient({ baseUrl = coreBaseUrl(), serviceKey = process.env.SERVICE_KEY, fetchImpl = fetch, timeoutMs = 5000, retries = 1 } = {}) {
  async function call(method, path, body) {
    if (!baseUrl) throw new CoreUnavailableError('CORE_URL is not configured');
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            'x-service-key': serviceKey ?? '',
            'x-correlation-id': randomUUID(),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastError = new CoreUnavailableError(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'Core did not answer in time' : `Core could not be reached: ${err?.message ?? err}`);
        continue;
      }
      if (response.status >= 500) {
        await response.arrayBuffer?.().catch(() => {});
        lastError = new CoreUnavailableError(`Core answered ${response.status}`);
        continue;
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        /* not JSON */
      }
      if (!response.ok) throw new CoreRejectedError(response.status, isObject(payload?.error) ? payload.error : {});
      if (!isObject(payload)) throw invalid('answer');
      return payload;
    }
    throw lastError;
  }

  return {
    /** GET /services/:id/standard?asOf= -> the standard in force on a Manila date, with the service fields. */
    async standardAsOf(serviceId, asOf) {
      const data = await call('GET', `/services/${encodeURIComponent(serviceId)}/standard?asOf=${encodeURIComponent(asOf)}`);
      const ok =
        typeof data.standard_id === 'string' &&
        isWholeNumber(data.duration_days) &&
        isWholeNumber(data.duration_hours) &&
        isWholeNumber(data.duration_minutes) &&
        typeof data.service_code === 'string' &&
        typeof data.service_name === 'string' &&
        typeof data.office_id === 'string' &&
        typeof data.office_code === 'string' &&
        typeof data.classification === 'string';
      if (!ok) throw invalid('standard');
      // Rolling deployment compatibility: older Core lookup replies omit the additive name field.
      // Resolve it through Core's existing trusted office API, never from the caller or an office code.
      if (data.office_name === undefined) {
        const fallback = await call('GET', `/offices/${encodeURIComponent(data.office_id)}`);
        if (!isObject(fallback.office) || fallback.office.office_id !== data.office_id) throw invalid('office');
        data.office_name = fallback.office.office_name;
      }
      if (typeof data.office_name !== 'string' || !data.office_name.trim()) throw invalid('office name');
      return data;
    },

    /** GET /offices/:id -> { office_id, office_code, office_name, is_active } (the service key also sees inactive offices). */
    async office(officeId) {
      const data = await call('GET', `/offices/${encodeURIComponent(officeId)}`);
      if (!isObject(data.office) || typeof data.office.is_active !== 'boolean') throw invalid('office');
      return data.office;
    },

    /** POST /working-minutes -> whole working minutes between two instants (Date or ISO text). */
    async workingMinutes({ start, end, officeId }) {
      const data = await call('POST', '/working-minutes', { start: iso(start), end: iso(end), officeId });
      if (!isWholeNumber(data.working_minutes)) throw invalid('working-minutes answer');
      return data.working_minutes;
    },

    /** POST /deadline -> the instant (ms) of the deadline day's closing time, plus held working minutes. */
    async deadline({ start, workingDays, officeId, heldMinutes = 0 }) {
      const data = await call('POST', '/deadline', { start: iso(start), workingDays, officeId, heldMinutes });
      return instantOf(data.deadline, 'deadline');
    },

    /** POST /add-working-minutes -> the instant (ms) reached after `minutes` working minutes. */
    async addWorkingMinutes({ datetime, minutes, officeId }) {
      const data = await call('POST', '/add-working-minutes', { datetime: iso(datetime), minutes, officeId });
      return instantOf(data.datetime, 'datetime');
    },
  };
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function instantOf(value, what) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw invalid(what);
  return ms;
}
