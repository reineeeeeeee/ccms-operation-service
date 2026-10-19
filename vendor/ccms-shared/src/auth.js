import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import { Errors } from './errors.js';
import { isValidRole } from './roles.js';

export const DEFAULT_ISSUER = 'ccms-identity';
export const DEFAULT_AUDIENCE = 'ccms';

// Errors that mean "this token is not acceptable" (401). Anything else while verifying,
// such as the public keys being unreachable and not cached, is a 503 rather than a false 401.
const TOKEN_PROBLEM_CODES = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWK_INVALID',
  'ERR_JWKS_INVALID',
]);

/**
 * Builds an offline token verifier (RS256 only).
 * Provide one of: jwksUrl (Identity's published keys), jwks (a JWKS object) or getJwks (async).
 */
export function createTokenVerifier({
  jwksUrl,
  jwks,
  getJwks,
  issuer = DEFAULT_ISSUER,
  audience = DEFAULT_AUDIENCE,
} = {}) {
  let keySetPromise;
  const getKeySet = () => {
    if (!keySetPromise) {
      if (jwks) keySetPromise = Promise.resolve(createLocalJWKSet(jwks));
      else if (getJwks) keySetPromise = Promise.resolve(getJwks()).then((set) => createLocalJWKSet(set));
      else if (jwksUrl) {
        keySetPromise = Promise.resolve(
          createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 3000, cooldownDuration: 10_000 }),
        );
      } else throw new Error('createTokenVerifier needs jwksUrl, jwks or getJwks');
    }
    return keySetPromise;
  };

  return async function verify(token) {
    let payload;
    try {
      const keySet = await getKeySet();
      ({ payload } = await jwtVerify(token, keySet, { issuer, audience, algorithms: ['RS256'] }));
    } catch (err) {
      if (err?.code && TOKEN_PROBLEM_CODES.has(err.code)) {
        throw Errors.unauthorized('Invalid or expired token', 'INVALID_TOKEN');
      }
      if (err?.code === 'ERR_JWKS_TIMEOUT' || err?.name === 'TypeError' || err?.code === 'ERR_JOSE_GENERIC') {
        throw Errors.unavailable('Cannot verify your session right now, try again', 'AUTH_UNAVAILABLE');
      }
      throw Errors.unauthorized('Invalid or expired token', 'INVALID_TOKEN');
    }
    return claimsToUser(payload);
  };
}

export function claimsToUser(payload) {
  if (!payload?.sub || !isValidRole(payload.role)) {
    throw Errors.unauthorized('Invalid or expired token', 'INVALID_TOKEN');
  }
  return {
    id: payload.sub,
    employeeNo: payload.employee_no ?? null,
    fullName: payload.full_name ?? null,
    role: payload.role,
    officeId: payload.office_id ?? null,
  };
}

let defaultVerifier;

export function setDefaultVerifier(verifier) {
  defaultVerifier = verifier;
}

export function getDefaultVerifier() {
  if (!defaultVerifier) {
    const jwksUrl = process.env.IDENTITY_JWKS_URL;
    if (!jwksUrl) throw new Error('IDENTITY_JWKS_URL is not configured');
    defaultVerifier = createTokenVerifier({
      jwksUrl,
      issuer: process.env.JWT_ISSUER || DEFAULT_ISSUER,
      audience: process.env.JWT_AUDIENCE || DEFAULT_AUDIENCE,
    });
  }
  return defaultVerifier;
}

export function bearerToken(request) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

/** Returns the caller ({ id, employeeNo, fullName, role, officeId }) or throws a 401/503. */
export async function authenticate(request, verifier) {
  const token = bearerToken(request);
  if (!token) throw Errors.unauthorized('Missing or invalid Authorization header', 'MISSING_TOKEN');
  return (verifier ?? getDefaultVerifier())(token);
}
