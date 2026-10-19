import { Errors, readJson } from 'ccms-shared';

/** The JSON object of a request, or {} when the request has no body (for example Complete without a manual end time). */
export async function readOptionalJson(request) {
  const text = await request.clone().text().catch(() => '');
  if (!text.trim()) return {};
  return readJson(request);
}

/** A route parameter that must be a UUID; anything else is a 404 for that kind of resource. */
export function idParam(params, isUuid, notFoundError) {
  if (!isUuid(params.id)) throw notFoundError;
  return params.id;
}

export { Errors };
