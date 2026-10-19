import { ROLES, ROLE_LIST, clientIp, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { getSettings, updateSettings } from '../../../modules/transaction/settings.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission(ROLE_LIST, 'campus');
const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// GET /settings — any signed-in role (the screens use it to show or hide Hold/Resume and the counter picker).
export const GET = route(async (request) => {
  await canRead(request);
  return json(await getSettings(await getDb()));
});

// PUT /settings — Super Admin only. The full settings and the version that was read; 409 SETTINGS_VERSION_CONFLICT if it moved on.
export const PUT = route(async (request) => {
  const user = await canWrite(request);
  return json(await updateSettings(await getDb(), user, await readJson(request), { ipAddress: clientIp(request) }));
});
