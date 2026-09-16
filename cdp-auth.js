// ============================================================================
// Coinbase CDP facilitator authentication (per-request Ed25519 JWT)
//
// The CDP x402 facilitator rejects static API-key headers: every call must
// carry a fresh JWT signed with the API key's private key and bound to the
// exact method + host + path of the operation. This module reproduces the
// construction used by @coinbase/cdp-sdk (auth/utils/jwt) with pure
// node:crypto — no extra dependencies.
//
// Contract (extracted verbatim from cdp-sdk source):
//   payload : { sub: <keyId>, iss: "cdp", nbf, iat, exp: now+120,
//               uris: ["POST api.cdp.coinbase.com/platform/v2/x402/verify"] }
//   header  : { alg: "EdDSA", kid: <keyId>, typ: "JWT", nonce: <16B hex> }
//   key     : CDP_API_KEY_SECRET = base64(64B) = 32B seed (d) + 32B pub (x)
// ============================================================================

import crypto from 'node:crypto';

/** JWT lifetime in seconds (cdp-sdk default). */
const CDP_JWT_TTL_SECONDS = 120;

/**
 * Load an Ed25519 private key from a CDP API key secret.
 *
 * @param {string} keySecret - base64 payload of the 64-byte CDP key
 * @returns {crypto.KeyObject} Signing key
 * @throws {Error} When the secret does not decode to 64 bytes
 */
function loadEd25519Key(keySecret) {
  const raw = Buffer.from(String(keySecret), 'base64');
  if (raw.length !== 64) {
    throw new Error(
      `CDP_API_KEY_SECRET must decode to 64 bytes (32B seed + 32B public key); received ${raw.length} bytes. ` +
        'Copy the key verbatim from the Coinbase Developer Portal.',
    );
  }
  const jwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    d: raw.subarray(0, 32).toString('base64url'),
    x: raw.subarray(32).toString('base64url'),
  };
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

/**
 * Build the `createAuthHeaders` provider the CDP facilitator requires.
 *
 * @param {object} options
 * @param {string} options.keyId - CDP_API_KEY_ID (JWT `sub`/`kid`)
 * @param {string} options.keySecret - CDP_API_KEY_SECRET (base64 Ed25519 key)
 * @param {string} options.baseUrl - CDP facilitator base URL
 * @returns {() => Promise<Record<string, Record<string, string>>>} Keyed
 *   header sets: { verify, settle, supported, bazaar }
 */
export function createCdpAuthHeaders({ keyId, keySecret, baseUrl }) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error(`CDP facilitator requires https (received "${baseUrl}")`);
  }
  const host = parsed.hostname;
  const basePath = parsed.pathname.replace(/\/+$/, '');
  const privateKey = loadEd25519Key(keySecret);

  /**
   * Sign one Bearer JWT bound to `method host basePath`.
   *
   * @param {string} method - HTTP verb the request will use
   * @param {string} path - Facilitator path including base path
   * @returns {Record<string, string>} Headers object with `authorization`
   */
  function bearerFor(method, path) {
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: 'EdDSA',
      kid: keyId,
      typ: 'JWT',
      nonce: crypto.randomBytes(16).toString('hex'),
    };
    const payload = {
      sub: keyId,
      iss: 'cdp',
      nbf: now,
      iat: now,
      exp: now + CDP_JWT_TTL_SECONDS,
      uris: [`${method} ${host}${path}`],
    };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(
      JSON.stringify(payload),
    ).toString('base64url')}`;
    const signature = crypto.sign(null, Buffer.from(signingInput), privateKey).toString('base64url');
    return { authorization: `Bearer ${signingInput}.${signature}` };
  }

  return async () => ({
    verify: bearerFor('POST', `${basePath}/verify`),
    settle: bearerFor('POST', `${basePath}/settle`),
    supported: bearerFor('GET', `${basePath}/supported`),
    bazaar: bearerFor('GET', `${basePath}/bazaar`),
  });
}
