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
const baseUrl = 'https://api.cdp.coinbase.com';
const host = 'api.cdp.coinbase.com';
const cdpKey = crypto.createPrivateKey({
  key: { kty: 'OKP', crv: 'Ed25519', d: Buffer.from(keySecret, 'base64').subarray(0, 32).toString('base64url'), x: Buffer.from(keySecret, 'base64').subarray(32).toString('base64url') },
  format: 'jwk',
});

function makeJwt(method, path) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', kid: keyId, typ: 'JWT', nonce: crypto.randomBytes(16).toString('hex') };
  const payload = { sub: keyId, iss: 'cdp', nbf: now, iat: now, exp: now + 120, uris: [`${method} ${host}${path}`] };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), cdpKey).toString('base64url');
  return `Bearer ${signingInput}.${signature}`;
}

async function cdpFetch(method, path, body = null) {
  const headers = { authorization: makeJwt(method, path), 'Content-Type': 'application/json' };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, opts);
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

console.log('1. Listing wallets...');
const wallets = await cdpFetch('GET', '/platform/v2/wallets');
console.log('Status:', wallets.status);
console.log('Wallets:', JSON.stringify(wallets.data).substring(0, 2000));

if (wallets.data?.wallets?.length > 0) {
  for (const w of wallets.data.wallets) {
    console.log(`\nWallet: ${w.id} (${w.name})`);
    const accounts = await cdpFetch('GET', `/platform/v2/wallets/${w.id}/accounts`);
    for (const a of (accounts.data?.accounts || [])) {
      console.log(`  Address: ${a.address?.address || 'N/A'}`);
      const balance = await cdpFetch('GET', `/platform/v2/accounts/${a.address?.address || a.id}/balance`);
      console.log(`  Balance:`, JSON.stringify(balance.data).substring(0, 500));
    }
  }
}

console.log('\n2. Listing accounts...');
const accounts = await cdpFetch('GET', '/platform/v2/accounts');
console.log('Status:', accounts.status);
console.log('Accounts:', JSON.stringify(accounts.data).substring(0, 2000));
