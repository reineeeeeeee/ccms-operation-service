import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { DEFAULT_AUDIENCE, DEFAULT_ISSUER, createTokenVerifier } from '../auth.js';

export { runBoundarySuite } from './boundary-harness.js';
export { createTestDatabase, DEFAULT_TEST_PG_URL } from './database.js';

/**
 * A throwaway RS256 keypair for tests, so services can be tested before Identity is involved.
 * signToken({ role, office_id, ... }) mints a token the returned verifier accepts.
 */
export async function createTestKeys({ issuer = DEFAULT_ISSUER, audience = DEFAULT_AUDIENCE, kid = 'test-key' } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwks = { keys: [jwk] };

  async function signToken({
    sub = randomUUID(),
    employee_no = 'EMP-0001',
    full_name = 'Test User',
    role,
    office_id = null,
    exp,
    expiresIn = '15m',
    ...extra
  } = {}) {
    return new SignJWT({ employee_no, full_name, role, office_id, ...extra })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject(sub)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(exp ?? expiresIn)
      .sign(privateKey);
  }

  return {
    jwks,
    privateKey,
    signToken,
    issuer,
    audience,
    verifier: createTokenVerifier({ jwks, issuer, audience }),
  };
}

export function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

export function jsonRequest(url, { method = 'GET', body, token, headers = {} } = {}) {
  return new Request(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? bearer(token) : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
