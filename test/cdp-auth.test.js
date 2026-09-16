import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCdpAuthHeaders } from '../cdp-auth.js';

const KEY_ID = '7cf18512-aaaa-bbbb-cccc-ddddeeeeffff';
// 64 bytes: 32B seed (d) + 32B public (x) — the CDP portal format.
const KEY_SECRET = Buffer.alloc(64, 7).toString('base64');
const BASE = 'https://api.cdp.coinbase.com/platform/v2/x402';

function decodeJwt(bearer) {
  const [h, p] = bearer.replace(/^Bearer /, '').split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')), parts: bearer.split('.').length };
}

describe('CDP per-request JWT auth', () => {
  test('returns header sets keyed by facilitator operation', async () => {
    const getHeaders = createCdpAuthHeaders({ keyId: KEY_ID, keySecret: KEY_SECRET, baseUrl: BASE });
    const keyed = await getHeaders();
    for (const op of ['verify', 'settle', 'supported', 'bazaar']) {
      assert.match(keyed[op].authorization, /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    }
  });

  test('JWT is EdDSA, bound to the exact method+host+path of each operation', async () => {
    const getHeaders = createCdpAuthHeaders({ keyId: KEY_ID, keySecret: KEY_SECRET, baseUrl: BASE });
    const keyed = await getHeaders();
    const verify = decodeJwt(keyed.verify.authorization);
    const supported = decodeJwt(keyed.supported.authorization);
    assert.equal(verify.header.alg, 'EdDSA');
    assert.equal(verify.header.kid, KEY_ID);
    assert.equal(verify.header.typ, 'JWT');
    assert.match(verify.header.nonce, /^[0-9a-f]{32}$/);
    assert.equal(verify.payload.sub, KEY_ID);
    assert.equal(verify.payload.iss, 'cdp');
    assert.deepEqual(verify.payload.uris, ['POST api.cdp.coinbase.com/platform/v2/x402/verify']);
    assert.deepEqual(supported.payload.uris, ['GET api.cdp.coinbase.com/platform/v2/x402/supported']);
    assert.ok(verify.payload.exp > verify.payload.iat);
    assert.equal(verify.payload.exp - verify.payload.iat, 120);
  });

  test('each call produces a fresh nonce (no replayable static header)', async () => {
    const getHeaders = createCdpAuthHeaders({ keyId: KEY_ID, keySecret: KEY_SECRET, baseUrl: BASE });
    const a = decodeJwt((await getHeaders()).verify.authorization);
    const b = decodeJwt((await getHeaders()).verify.authorization);
    assert.notEqual(a.header.nonce, b.header.nonce);
  });

  test('rejects secrets that do not decode to 64 bytes with a clear message', () => {
    assert.throws(
      () => createCdpAuthHeaders({ keyId: KEY_ID, keySecret: Buffer.alloc(32).toString('base64'), baseUrl: BASE }),
      /64 bytes/,
    );
  });

  test('rejects non-https facilitator URLs', () => {
    assert.throws(
      () => createCdpAuthHeaders({ keyId: KEY_ID, keySecret: KEY_SECRET, baseUrl: 'http://api.cdp.coinbase.com/x402' }),
      /https/,
    );
  });
});
