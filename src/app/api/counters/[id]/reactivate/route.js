import { ROLES, clientIp, json, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { setCounterActive } from '../../../../../modules/transaction/counters.js';

export const dynamic = 'force-dynamic';

const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// PATCH /counters/:id/reactivate — Super Admin only. A counter is never deleted.
export const PATCH = route(async (request, { params }) => {
  const user = await canWrite(request);
  return json(await setCounterActive(await getDb(), user, params.id, true, { ipAddress: clientIp(request) }));
});
