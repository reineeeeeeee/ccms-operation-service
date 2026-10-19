import { ROLES, clientIp, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../lib/data-source.js';
import { updateCounter } from '../../../../modules/transaction/counters.js';
import { runtimeDeps } from '../../../../modules/transaction/deps.js';

export const dynamic = 'force-dynamic';

const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// PUT /counters/:id { office_id, label } — Super Admin only. 409 while the counter has an open transaction.
export const PUT = route(async (request, { params }) => {
  const user = await canWrite(request);
  return json(await updateCounter(await getDb(), runtimeDeps().core, user, params.id, await readJson(request), { ipAddress: clientIp(request) }));
});
