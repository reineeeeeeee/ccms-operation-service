import { createHash, timingSafeEqual } from 'node:crypto';
import { Errors } from './errors.js';
import { json, route } from './http.js';

/**
 * Vercel Cron calls a plain GET on the path in vercel.json and, when the CRON_SECRET environment
 * variable is set, sends it as "Authorization: Bearer <CRON_SECRET>". Nothing else may run a job,
 * so a missing or wrong secret is a 401 - and with no CRON_SECRET configured the job never runs.
 */
export function requireCronSecret(request, expected = process.env.CRON_SECRET) {
  if (!expected) throw Errors.unauthorized('Cron secret is not configured', 'CRON_NOT_CONFIGURED');
  const provided = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const digest = (v) => createHash('sha256').update(v).digest();
  if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
    throw Errors.unauthorized('Cron secret required', 'INVALID_CRON_SECRET');
  }
}

/**
 * Wraps a run-once job as a cron route handler: checks the secret, runs the job once, and returns
 * its result as JSON ({ job, ...result }). Failures use the standard error format.
 *
 *   export const GET = cronRoute('outbox', () => runOutboxDispatch());
 */
export function cronRoute(name, job) {
  return route(async (request) => {
    requireCronSecret(request);
    const result = await job();
    return json({ job: name, ...result });
  });
}
