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

import { x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';

try {
  process.loadEnvFile?.('.env');
} catch {}

// Same two payment routes as scripts/refresh-bazaar-listing.mjs. A CDP Server
// Wallet is the better default (the signing key never leaves Coinbase), but it
// needs an API key and a wallet secret from the SAME CDP project and fails as
// an opaque 401 when they are mismatched. PAYER_PRIVATE_KEY is the escape
// hatch: any Base wallet holding USDC works, with no ETH needed, because the
// `exact` scheme signs off-chain and the facilitator pays the gas.
const PAYER_PRIVATE_KEY = process.env.PAYER_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY || '';
const hasCdpCredentials =
  process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET;

if (!PAYER_PRIVATE_KEY && !hasCdpCredentials) {
  console.error('No way to pay the listing fee is configured. Provide either:');
  console.error('  PAYER_PRIVATE_KEY=0x…  a Base wallet holding at least the listing fee, or');
  console.error(
    '  CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET, all from the SAME CDP project.',
  );
  process.exit(1);
}

/** Cap on this submission's fee, independent of what the endpoint asks for. */
const MAX_PER_PAYMENT = process.env.MAX_PER_PAYMENT || '$1.00';

let client;
if (PAYER_PRIVATE_KEY) {
  const { privateKeyToAccount } = await import('viem/accounts');
  const { x402Client } = await import('@x402/fetch');
  const { ExactEvmScheme } = await import('@x402/evm/exact/client');

  const account = privateKeyToAccount(
    PAYER_PRIVATE_KEY.startsWith('0x') ? PAYER_PRIVATE_KEY : `0x${PAYER_PRIVATE_KEY}`,
  );
  client = new x402Client();
  client.setSpendControls({ maxAmountPerPayment: MAX_PER_PAYMENT });
  client.register(process.env.SUBMIT_NETWORK || 'eip155:8453', new ExactEvmScheme(account));
  console.log(`Paying the listing fee from: ${account.address} (no ETH needed)`);
} else {
  // Base mainnet by default (real USDC). Set CDP_X402_ENVIRONMENT=development
  // to use Base Sepolia testnet instead while testing this script itself.
  const { CdpX402Client } = await import('@coinbase/cdp-sdk/x402');
  const environment =
    process.env.CDP_X402_ENVIRONMENT === 'development' ? 'development' : undefined;
  client = new CdpX402Client(environment ? { environment } : {});
  client.setSpendControls?.({ maxAmountPerPayment: MAX_PER_PAYMENT });
}

// A CDP Server Wallet provisions its address lazily, so print it here to show
// where the fee will come from (and where to send funds if it turns out to be
// empty). The local-key path already printed its own address above.
if (!PAYER_PRIVATE_KEY) {
  const { evmAddress } = await client.getAddresses();
  console.log(`CDP-managed wallet address: ${evmAddress}`);
  console.log(
    'If this run fails below with an insufficient-funds error, fund this address with ' +
      'USDC on Base mainnet, then run this script again.',
  );
}

const httpClient = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const SERVICE_URL = (
  process.env.SERVICE_URL || 'https://desanatization-production.up.railway.app'
).replace(/\/+$/, '');

/**
 * Read a route's live payment terms straight off its 402 challenge.
 *
 * The price and payout address are NOT hardcoded here, deliberately. This
 * submission has already been rejected once for advertising terms that did
 * not match the live service, and the payout address has now changed twice
 * ($0.001 -> $0.01, and three different wallets). A directory listing that
 * contradicts the endpoint is worse than no listing: an agent signs the
 * advertised amount to the advertised address, the endpoint rejects it, and
 * the sale is lost while everything looks healthy.
 *
 * @param {string} path - Route path to read terms from
 * @returns {Promise<{payTo: string, price: string}>} Live terms
 * @throws {Error} When the route does not answer with a readable 402
 */
async function readLiveTerms(path) {
  const response = await fetch(`${SERVICE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(path.endsWith('/batch') ? { items: ['terms probe'] } : { text: 'terms probe' }),
  });
  if (response.status !== 402) {
    throw new Error(`Expected a 402 challenge from ${path}, got HTTP ${response.status}.`);
  }
  const accept = (await response.json())?.accepts?.[0];
  if (!accept?.payTo || !accept?.price) {
    throw new Error(`The 402 from ${path} did not carry readable payTo/price terms.`);
  }
  return { payTo: accept.payTo, price: accept.price };
}

const single = await readLiveTerms('/api/resource');
const batch = await readLiveTerms('/api/sanitize/batch');

if (batch.payTo.toLowerCase() !== single.payTo.toLowerCase()) {
  console.error(
    `Routes disagree on the payout address (${single.payTo} vs ${batch.payTo}) — refusing to ` +
      'submit terms that contradict themselves.',
  );
  process.exit(1);
}

console.log(`Live terms read from ${SERVICE_URL}:`);
console.log(`  single: ${single.price}   batch: ${batch.price}   payTo: ${single.payTo}`);

const body = JSON.stringify({
  url: SERVICE_URL,
  email: process.env.SUBMIT_CONTACT_EMAIL || 'andrew.peal12@gmail.com',
  service_name: 'Desanatization',
  description:
    'Deterministic PII sanitization for AI agents over x402 v2. Redacts emails, phones, SSNs, ' +
    'credit-card numbers, private keys, Bearer tokens and URL query secrets. Free trial for the ' +
    `first 500 chars, then ${single.price} per full job on Base mainnet, or ${batch.price} for a ` +
    'batch of up to 10.',
  website_url: SERVICE_URL,
  category: 'AI',
  endpoints: ['/api/resource', '/api/sanitize/trial', '/api/sanitize/batch'],
  notes:
    'x402 v2 with CDP facilitator on Base mainnet. Bazaar discovery enabled. ' +
    `PayTo: ${single.payTo}.`,
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
