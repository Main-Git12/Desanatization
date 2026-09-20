#!/usr/bin/env node
// Refresh this service's entry in the CDP x402 Bazaar by making one real,
// settled payment against our own paid endpoint — from a Coinbase-managed CDP
// Server Wallet, never a locally-held private key.
//
// WHY THIS EXISTS
//
// The Bazaar has no registration form. CDP catalogs a resource as a side
// effect of a payment settling through its facilitator: the facilitator reads
// the `bazaar` extension and the resource metadata out of the PaymentPayload
// at settle time and writes the catalog entry from it.
//
// That has two consequences:
//
//   1. The catalog entry is a SNAPSHOT of whatever the config was at the
//      moment of the last settlement. Change PAY_TO_ADDRESS or PRICE
//      afterwards and the catalog keeps advertising the old values. An agent
//      that trusts the stale entry signs a payment for the wrong amount to
//      the wrong address, our server rejects it, and the sale is lost —
//      while the service looks perfectly healthy from the outside.
//
//   2. Entries go stale by inactivity. CDP drops resources with no
//      settlement for 30 days.
//
// Running this re-settles with the CURRENT config, which rewrites the catalog
// entry to the current payTo/price and resets the inactivity clock.
//
// COST: one call at the service's own price (cents), paid from your wallet to
// your own PAY_TO_ADDRESS, minus the facilitator fee and gas. It is close to a
// round trip, not a real expense.
//
// ONE-TIME SETUP
//   1. In the CDP portal, generate a Wallet Secret and set CDP_WALLET_SECRET
//      alongside the CDP_API_KEY_ID / CDP_API_KEY_SECRET this repo already
//      uses for the facilitator.
//   2. Run this script once — it prints the CDP wallet address and stops.
//   3. Send that address a few dollars of USDC on Base mainnet (plus a little
//      ETH for gas unless your CDP project sponsors it). The address is public
//      information and safe to paste anywhere.
//   4. Run it again to actually buy and settle.
//
// Usage:
//   node scripts/refresh-bazaar-listing.mjs
//   RESOURCE_URL=https://host/api/resource node scripts/refresh-bazaar-listing.mjs
//   EXPECT_PAY_TO=0x… node scripts/refresh-bazaar-listing.mjs   # refuse to pay anyone else

import { x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';

try {
  process.loadEnvFile?.('.env');
} catch {}

const RESOURCE_URL =
  process.env.RESOURCE_URL || 'https://desanatization-production.up.railway.app/api/resource';
const EXPECT_PAY_TO = (process.env.EXPECT_PAY_TO || '').trim().toLowerCase() || null;
const BAZAAR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const MAX_PER_PAYMENT = process.env.MAX_PER_PAYMENT || '$0.50';

// --check compares the live endpoint against the catalog and stops. It needs
// no credentials, no funded wallet and spends nothing, so it is always safe
// to run just to see whether the listing has drifted.
const CHECK_ONLY = process.argv.includes('--check');

const required = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'];
const missing = CHECK_ONLY ? [] : required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error(
    'CDP_API_KEY_ID/CDP_API_KEY_SECRET are the same CDP API key this repo already uses for ' +
      'the facilitator. CDP_WALLET_SECRET is separate — generate it in the CDP portal under ' +
      'Server Wallets. No raw private key is involved in either.',
  );
  process.exit(1);
}

/**
 * Read the live 402 challenge without paying, so the operator can see exactly
 * what is about to be paid, to whom, before any money moves.
 *
 * @param {string} url - Paid resource URL
 * @returns {Promise<{payTo: string, amount: string, network: string, asset: string}|null>} Terms
 */
async function readChallenge(url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'bazaar listing refresh' }),
  });
  if (response.status !== 402) {
    console.error(`Expected a 402 challenge from ${url}, got HTTP ${response.status}.`);
    return null;
  }
  const header = response.headers.get('payment-required');
  if (!header) return null;
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  return decoded?.accepts?.[0] ?? null;
}

/**
 * Look up this resource's current Bazaar catalog entry, paging the index.
 *
 * @param {string} resourceUrl - Resource URL to find
 * @returns {Promise<object|null>} The catalog entry, or null when absent
 */
async function findInBazaar(resourceUrl) {
  const needle = new URL(resourceUrl).host.toLowerCase();
  for (let offset = 0; offset < 30_000; ) {
    const response = await fetch(`${BAZAAR_URL}?limit=500&offset=${offset}`);
    if (!response.ok) return null;
    const page = await response.json();
    const items = page?.items ?? [];
    if (items.length === 0) return null;
    for (const item of items) {
      if (JSON.stringify(item).toLowerCase().includes(needle)) return item;
    }
    offset += items.length;
    const total = page?.pagination?.total;
    if (total && offset >= total) return null;
  }
  return null;
}

/**
 * Summarise the payment terms a catalog entry advertises.
 *
 * @param {object|null} entry - Bazaar catalog entry
 * @returns {string} One-line summary
 */
function describeEntry(entry) {
  const accept = entry?.accepts?.[0];
  if (!accept) return 'not listed';
  return `payTo=${accept.payTo} amount=${accept.amount} network=${accept.network}`;
}

console.log(`Target resource:    ${RESOURCE_URL}`);

const before = await findInBazaar(RESOURCE_URL);
console.log(`Bazaar entry before: ${describeEntry(before)}`);

const terms = await readChallenge(RESOURCE_URL);
if (!terms) {
  console.error('Could not read a payment challenge from the resource — aborting.');
  process.exit(1);
}
console.log(`Live 402 asks for:   payTo=${terms.payTo} amount=${terms.amount} (${terms.network})`);

if (EXPECT_PAY_TO && terms.payTo?.toLowerCase() !== EXPECT_PAY_TO) {
  console.error(
    `\nREFUSING TO PAY: the live endpoint asks to pay ${terms.payTo}, but EXPECT_PAY_TO is ` +
      `${EXPECT_PAY_TO}. Nothing has been sent. Confirm the service's PAY_TO_ADDRESS before retrying.`,
  );
  process.exit(1);
}

let drifted = false;
if (before && before.accepts?.[0]) {
  const stale = before.accepts[0];
  const payToDrifted = stale.payTo?.toLowerCase() !== terms.payTo?.toLowerCase();
  const amountDrifted = String(stale.amount) !== String(terms.amount);
  drifted = payToDrifted || amountDrifted;
  if (drifted) {
    console.log(
      '\nThe catalog entry is STALE — this is what agents discovering us currently see:' +
        (payToDrifted ? `\n  payTo:  catalog ${stale.payTo}  vs live ${terms.payTo}` : '') +
        (amountDrifted ? `\n  amount: catalog ${stale.amount}  vs live ${terms.amount}` : '') +
        '\nAn agent trusting those terms would have its payment rejected. Settling rewrites them.',
    );
  } else {
    console.log('\nCatalog entry matches the live endpoint — nothing to refresh.');
  }
}

if (CHECK_ONLY) {
  console.log(
    drifted
      ? '\n--check only: nothing was paid. Re-run without --check (with CDP credentials) to fix it.'
      : '\n--check only: nothing was paid.',
  );
  process.exit(drifted ? 2 : 0);
}

// Imported after the credential check so a missing `npm install` reports
// itself plainly instead of as a raw module-resolution stack trace.
let CdpX402Client;
try {
  ({ CdpX402Client } = await import('@coinbase/cdp-sdk/x402'));
} catch (error) {
  console.error(`Could not load @coinbase/cdp-sdk: ${error?.message ?? error}`);
  console.error('It is a declared dependency — run `npm install` in this repo first.');
  process.exit(1);
}

const client = new CdpX402Client(
  process.env.CDP_X402_ENVIRONMENT === 'development' ? { environment: 'development' } : {},
);

// Hard ceiling on a single payment, independent of whatever the challenge
// claims — defense in depth against a misbehaving or spoofed endpoint.
client.setSpendControls?.({ maxAmountPerPayment: MAX_PER_PAYMENT });

const { evmAddress } = await client.getAddresses();
console.log(`CDP-managed wallet: ${evmAddress}`);

const httpClient = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log('\nPaying…');
const response = await fetchWithPayment(RESOURCE_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Bazaar listing refresh: jane@example.com 415-555-1234' }),
});
const result = await httpClient.processResponse(response);

console.log(`HTTP ${result.status}`);
if (result.status !== 200) {
  console.error('Payment did not unlock the resource:', JSON.stringify(result.body, null, 2));
  process.exit(1);
}
console.log('Settlement receipt:');
console.dir(result.header, { depth: null });

// CDP writes the catalog entry asynchronously after settlement; give it a
// moment rather than declaring failure on a read that was simply too early.
console.log('\nWaiting for CDP to re-catalog the resource…');
for (let attempt = 1; attempt <= 10; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const after = await findInBazaar(RESOURCE_URL);
  const accept = after?.accepts?.[0];
  if (accept && String(accept.amount) === String(terms.amount) &&
      accept.payTo?.toLowerCase() === terms.payTo?.toLowerCase()) {
    console.log(`Catalog entry now:   ${describeEntry(after)}`);
    console.log('\nListing refreshed — it now advertises the live wallet and price.');
    process.exit(0);
  }
  console.log(`  attempt ${attempt}/10 — still ${describeEntry(after)}`);
}
console.log(
  '\nThe payment settled, but the catalog still shows the old terms. CDP may simply be slow to ' +
    'reindex; re-run this script later to check, and confirm the receipt above landed on-chain.',
);
