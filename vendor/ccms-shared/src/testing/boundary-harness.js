/**
 * Reusable office-boundary test harness (CC004). Every sprint adds its endpoints to a suite and
 * this checks the access rules the same way each time:
 *
 *   - Office Head / Office Staff: 403 and no data when the endpoint touches another office.
 *   - Executive: 403 on every write.
 *   - Super Admin: never blocked by role or office.
 *   - officeScoped:false + superAdminOnly:true endpoints: every non-Super-Admin role gets 403.
 *
 * Usage (node:test):
 *   runBoundarySuite({
 *     name: 'identity',
 *     describe, it, assert,
 *     tokens: { superAdmin, executive, officeHeadA, officeStaffA },   // officeStaffA / HeadA are bound to office A.
 *                                                                        // Declare the keys up front (null is fine) and
 *                                                                        // fill in the tokens in a before() hook.
 *     endpoints: [{
 *       name: 'GET /accounts/:id',
 *       write: false,
 *       superAdminOnly: false,
 *       officeScoped: true,
 *       otherOfficeMarker: 'OFFICE-B-SECRET',              // text that must never appear in a 403 body
 *       invoke: async (token, target) => Response,           // target: 'own' (office A) | 'other' (office B)
 *     }],
 *   });
 */
export function runBoundarySuite({ name, describe, it, assert, tokens, endpoints }) {
  describe(`office boundary: ${name}`, () => {
    for (const endpoint of endpoints) {
      const { write = false, superAdminOnly = false, officeScoped = true, otherOfficeMarker } = endpoint;

      if (officeScoped && !superAdminOnly) {
        for (const [label, key] of [
          ['Office Staff', 'officeStaffA'],
          ['Office Head', 'officeHeadA'],
        ]) {
          if (!(key in tokens)) continue;
          it(`${endpoint.name}: ${label} of office A gets 403 for an office B resource`, async () => {
            const response = await endpoint.invoke(tokens[key], 'other');
            const text = await response.text();
            assert.equal(response.status, 403, `expected 403 but got ${response.status}: ${text}`);
            if (otherOfficeMarker) assert.ok(!text.includes(otherOfficeMarker), 'response leaked office B data');
          });
        }
      }

      if (superAdminOnly) {
        for (const [label, key] of [
          ['Office Staff', 'officeStaffA'],
          ['Office Head', 'officeHeadA'],
          ['Executive', 'executive'],
        ]) {
          if (!(key in tokens)) continue;
          it(`${endpoint.name}: ${label} gets 403 (Super Admin only)`, async () => {
            const response = await endpoint.invoke(tokens[key], 'own');
            assert.equal(response.status, 403);
          });
        }
      }

      if (write && 'executive' in tokens && !superAdminOnly) {
        it(`${endpoint.name}: Executive gets 403 on a write`, async () => {
          for (const target of ['own', 'other']) {
            const response = await endpoint.invoke(tokens.executive, target);
            assert.equal(response.status, 403);
          }
        });
      }

      if ('superAdmin' in tokens) {
        it(`${endpoint.name}: Super Admin reaches any office's resource`, async () => {
          for (const target of ['own', 'other']) {
            const response = await endpoint.invoke(tokens.superAdmin, target);
            assert.ok(
              response.status !== 401 && response.status !== 403,
              `Super Admin was blocked (${response.status}) on the ${target} office`,
            );
          }
        });
      }
    }
  });
}
