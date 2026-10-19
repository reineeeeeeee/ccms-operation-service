import { json, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../lib/data-source.js';
import { OPERATOR_ROLES } from '../../../../modules/transaction/access.js';
import { getTransaction } from '../../../../modules/transaction/list.js';

export const dynamic = 'force-dynamic';

const canUse = requirePermission(OPERATOR_ROLES, 'campus');

// GET /transactions/:id — outside the caller's scope: 403 and no data.
export const GET = route(async (request, { params }) => {
  const user = await canUse(request);
  return json(await getTransaction(await getDb(), user, params.id));
});
