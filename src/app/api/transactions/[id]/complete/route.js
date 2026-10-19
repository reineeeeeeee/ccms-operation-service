import { clientIp, isUuid, json, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { OPERATOR_ROLES } from '../../../../../modules/transaction/access.js';
import { completeTransaction } from '../../../../../modules/transaction/complete.js';
import { notFound } from '../../../../../modules/transaction/db.js';
import { runtimeDeps } from '../../../../../modules/transaction/deps.js';
import { readOptionalJson } from '../../../../../modules/transaction/http.js';

export const dynamic = 'force-dynamic';

const canUse = requirePermission(OPERATOR_ROLES, 'campus');

// POST /transactions/:id/complete {} (or { ended_at, backdate_reason }) — saves the end time at the click, then computes the result.
export const POST = route(async (request, { params }) => {
  const user = await canUse(request);
  if (!isUuid(params.id)) throw notFound();
  const body = await readOptionalJson(request);
  return json(await completeTransaction(await getDb(), runtimeDeps(), user, params.id, body, { ipAddress: clientIp(request) }));
});
