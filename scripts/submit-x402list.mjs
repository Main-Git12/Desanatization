#!/usr/bin/env node
// Submit Desanatization to x402-list.com, paying the $1 listing fee on Base —
// via a Coinbase-managed CDP Server Wallet, not a locally-held private key.
//
// CDP creates and holds the signing key on its own infrastructure; this
// script only ever sees CDP_API_KEY_ID / CDP_API_KEY_SECRET (already used
// elsewhere in this repo for the facilitator) plus a CDP_WALLET_SECRET that
// authorizes wallet operations through the API. No raw EVM private key or
// seed phrase is generated, displayed, copied, or transmitted by this flow —
// there is nothing here that can be pasted into the wrong place or emailed
// to yourself by mistake.
//
// One-time setup:
//   1. In the CDP portal, generate a Wallet Secret for your project and set
//      CDP_WALLET_SECRET alongside your existing CDP_API_KEY_ID/SECRET.
//   2. Run this script once to have it print the wallet's address.
//   3. Fund that address with a little USDC (and ETH for gas, unless your
//      CDP project has gas sponsorship) on Base mainnet — from an exchange
//      account or any wallet, the same way you'd send to any address. The
//      address is public information; it is safe to paste anywhere.
//   4. Run this script again to actually submit and pay.
//
// Usage: node scripts/submit-x402list.mjs
//
// NOTE: this has not been executed against the live API from this
// environment — Coinbase's CDP endpoints are not reachable from this
// sandbox. Run it from an environment with normal internet access.

import { CdpX402Client } from '@coinbase/cdp-sdk/x402';
import { x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';

try {
  process.loadEnvFile?.('.env');
} catch {}

const required = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error(
    'CDP_API_KEY_ID/CDP_API_KEY_SECRET are the same CDP API key already used for the ' +
      'facilitator elsewhere in this repo. CDP_WALLET_SECRET is separate — generate it ' +
      'in the CDP portal under Server Wallets before running this script.',
  );
  process.exit(1);
}

// Base mainnet by default (real USDC). Set CDP_X402_ENVIRONMENT=development
// to use Base Sepolia testnet instead while testing this script itself.
const environment = process.env.CDP_X402_ENVIRONMENT === 'development' ? 'development' : undefined;
const client = new CdpX402Client(environment ? { environment } : {});

// Cap what a single payment can ever spend, independent of anything a
// facilitator or 402 challenge claims — defense in depth against a
// compromised or misbehaving endpoint. Applied only if this SDK version
// exposes it; never fatal if it doesn't.
client.setSpendControls?.({ maxAmountPerPayment: '$1.00' });

const { evmAddress } = await client.getAddresses();
console.log(`CDP-managed wallet address: ${evmAddress}`);
console.log(
  'If this run fails below with an insufficient-funds error, fund this address with ' +
    'USDC (and a little ETH for gas, if needed) on Base mainnet, then run this script again.',
);

const httpClient = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const body = JSON.stringify({
  url: 'https://desanatization-production.up.railway.app',
  email: 'andrew.peal12@gmail.com',
  service_name: 'Desanatization',
  description:
    'Deterministic PII sanitization for AI agents over x402 v2. Redacts emails, phones, SSNs, credit-card numbers, private keys, Bearer tokens and URL query secrets. Free trial for the first 500 chars, then $0.01 per full job on Base mainnet, or $0.08 for a batch of up to 10.',
  website_url: 'https://desanatization-production.up.railway.app',
  category: 'AI',
  endpoints: ['/api/resource', '/api/sanitize/trial', '/api/sanitize/batch'],
  notes:
    'x402 v2 with CDP facilitator on Base mainnet. Bazaar discovery enabled. PayTo: 0x79e6cdb37c20bec46156c81d0c274827eb2754e4.',
});

async function main() {
  const res = await fetchWithPayment('https://x402-list.com/api/v1/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const result = await httpClient.processResponse(res);
  console.log('Status:', result.status);
  console.log('Body:', JSON.stringify(result.body, null, 2));
  if (result.header) {
    console.log('Settlement receipt:');
    console.dir(result.header, { depth: null });
  }
}

main().catch((error) => {
  console.error('Request failed:', error?.message ?? error);
  if (error?.cause) console.error('  Cause:', error.cause?.message ?? error.cause);
  process.exit(1);
});
