import { clientIp, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { OPERATOR_ROLES } from '../../../modules/transaction/access.js';
import { runtimeDeps } from '../../../modules/transaction/deps.js';
import { listTransactions } from '../../../modules/transaction/list.js';
import { startTransaction } from '../../../modules/transaction/start.js';

export const dynamic = 'force-dynamic';

// Super Admin, Office Head and Office Staff; Executive gets 403 (BR-TXN-009). The office of the service is checked in the module.
const canUse = requirePermission(OPERATOR_ROLES, 'campus');

// GET /transactions?status=&service_id=&counter_id=&office_id=&from=&to=&q=&page=&page_size= — scoped by role.
export const GET = route(async (request) => {
  const user = await canUse(request);
  return json(await listTransactions(await getDb(), user, new URL(request.url).searchParams));
});

// POST /transactions — start a transaction (CC021; with started_at / ended_at / backdate_reason it is CC026).
export const POST = route(async (request) => {
  const user = await canUse(request);
  const transaction = await startTransaction(await getDb(), runtimeDeps(), user, await readJson(request), { ipAddress: clientIp(request) });
  return json(transaction, 201);
});
