import { clientIp, isUuid, json, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { OPERATOR_ROLES } from '../../../../../modules/transaction/access.js';
import { notFound } from '../../../../../modules/transaction/db.js';
import { resumeTransaction } from '../../../../../modules/transaction/hold.js';
import { runtimeDeps } from '../../../../../modules/transaction/deps.js';

export const dynamic = 'force-dynamic';

const canUse = requirePermission(OPERATOR_ROLES, 'campus');

// POST /transactions/:id/resume — adds the working minutes of the hold (from Core) to the held total.
export const POST = route(async (request, { params }) => {
  const user = await canUse(request);
  if (!isUuid(params.id)) throw notFound();
  return json(await resumeTransaction(await getDb(), runtimeDeps(), user, params.id, { ipAddress: clientIp(request) }));
});
