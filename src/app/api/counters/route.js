import { ROLES, clientIp, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { createCounter, listCounters } from '../../../modules/transaction/counters.js';
import { runtimeDeps } from '../../../modules/transaction/deps.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission([ROLES.SUPER_ADMIN, ROLES.OFFICE_HEAD, ROLES.OFFICE_STAFF], 'campus');
const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// GET /counters?officeId= — Super Admin: every office; Office Head / Office Staff: their own office only (another office is 403).
export const GET = route(async (request) => {
  const user = await canRead(request);
  return json(await listCounters(await getDb(), user, { officeId: new URL(request.url).searchParams.get('officeId') }));
});

// POST /counters { office_id, label } — Super Admin only. The office must exist and be active in Core.
export const POST = route(async (request) => {
  const user = await canWrite(request);
  const counter = await createCounter(await getDb(), runtimeDeps().core, user, await readJson(request), { ipAddress: clientIp(request) });
  return json(counter, 201);
});
