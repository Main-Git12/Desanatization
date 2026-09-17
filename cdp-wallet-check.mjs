import crypto from 'node:crypto';
import fs from 'node:fs';

const env = fs.readFileSync('.env', 'utf8');
const vars = {};
for (const line of env.split('\n').filter(l => l.trim() && !l.startsWith('#'))) {
  const [k, ...rest] = line.split('=');
  vars[k.trim()] = rest.join('=').trim();
}

const keyId = vars.CDP_API_KEY_ID;
const keySecret = vars.CDP_API_KEY_SECRET;
const raw = Buffer.from(keySecret, 'base64');
const cdpKey = crypto.createPrivateKey({
  key: { kty: 'OKP', crv: 'Ed25519', d: raw.subarray(0, 32).toString('base64url'), x: raw.subarray(32).toString('base64url') },
  format: 'jwk',
});

function jwt(method, path) {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: 'EdDSA', kid: keyId, typ: 'JWT', nonce: crypto.randomBytes(16).toString('hex') };
  const p = { sub: keyId, iss: 'cdp', nbf: now, iat: now, exp: now + 120, uris: [`${method} api.cdp.coinbase.com${path}`] };
  const si = Buffer.from(JSON.stringify(h)).toString('base64url') + '.' + Buffer.from(JSON.stringify(p)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(si), cdpKey).toString('base64url');
  return `Bearer ${si}.${sig}`;
}

async function cdpFetch(method, path, body = null) {
  const headers = { authorization: jwt(method, path), 'Content-Type': 'application/json' };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.cdp.coinbase.com${path}`, opts);
  const text = await res.text();
  console.log(`${method} ${path} -> ${res.status}: ${text.substring(0, 500)}`);
  return { res, text };
}

console.log('=== CDP API wallet/fund checks ===');
await cdpFetch('GET', '/platform/v2/wallets');
await cdpFetch('POST', '/platform/v2/wallets', { name: 'buyer', blockchains: ['base'] });
await cdpFetch('GET', '/platform/v2/accounts');
await cdpFetch('POST', '/platform/v2/buys', { walletId: 'test', amount: '5', currency: 'USD', paymentMethod: 'fiat' });

// Also try listing x402 resources
await cdpFetch('GET', '/platform/v2/x402/supported');
await cdpFetch('GET', '/platform/v2/x402/bazaar');
