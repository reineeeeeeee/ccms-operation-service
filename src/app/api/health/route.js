import { Errors, json, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';

export const dynamic = 'force-dynamic';

// GET /health -> 200 { status: "UP" } when the database answers, otherwise 503 in the standard error format.
export const GET = route(async () => {
  try {
    await (await getDb()).query('SELECT 1');
  } catch {
    throw Errors.unavailable('The database is not reachable right now.', 'DATABASE_UNAVAILABLE');
  }
  return json({ status: 'UP' });
});
