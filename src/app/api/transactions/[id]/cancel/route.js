import { ROLES, clientIp, isUuid, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { cancelTransaction } from '../../../../../modules/transaction/cancel.js';
import { notFound } from '../../../../../modules/transaction/db.js';

export const dynamic = 'force-dynamic';

// Office Head (own office) and Super Admin only. Office Staff and Executive get 403.
const canCancel = requirePermission([ROLES.SUPER_ADMIN, ROLES.OFFICE_HEAD], 'campus');

// POST /transactions/:id/cancel { reason }
export const POST = route(async (request, { params }) => {
  const user = await canCancel(request);
  if (!isUuid(params.id)) throw notFound();
  return json(await cancelTransaction(await getDb(), user, params.id, await readJson(request), { ipAddress: clientIp(request) }));
});
