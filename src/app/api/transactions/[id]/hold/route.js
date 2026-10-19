import { clientIp, isUuid, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { OPERATOR_ROLES } from '../../../../../modules/transaction/access.js';
import { notFound } from '../../../../../modules/transaction/db.js';
import { holdTransaction } from '../../../../../modules/transaction/hold.js';
import { runtimeDeps } from '../../../../../modules/transaction/deps.js';

export const dynamic = 'force-dynamic';

const canUse = requirePermission(OPERATOR_ROLES, 'campus');

// POST /transactions/:id/hold { reason } — the user who started it, the Office Head of its office, Super Admin.
export const POST = route(async (request, { params }) => {
  const user = await canUse(request);
  if (!isUuid(params.id)) throw notFound();
  return json(await holdTransaction(await getDb(), user, params.id, await readJson(request), { now: runtimeDeps().now, ipAddress: clientIp(request) }));
});
