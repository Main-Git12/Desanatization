#!/usr/bin/env node
// Submit Desanatization to x402-list.com, paying the $1 free-host fee on Base.
// Usage: EVM_PRIVATE_KEY=0x... node scripts/submit-x402list.mjs

import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

try {
  process.loadEnvFile?.('.env');
} catch {}

const privateKey = process.env.EVM_PRIVATE_KEY;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  console.error('EVM_PRIVATE_KEY must be a 32-byte hex private key.');
  process.exit(1);
}

const account = privateKeyToAccount(privateKey);
const client = new x402Client();
client.setSpendControls({ maxAmountPerPayment: '$1.00' });
client.register('eip155:*', new ExactEvmScheme(account));

const httpClient = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const body = JSON.stringify({
  url: 'https://desanatization-production.up.railway.app',
  email: 'andrew.peal12@gmail.com',
  service_name: 'Desanatization',
  description:
    'Deterministic PII sanitization for AI agents over x402 v2. Redacts emails, phones, SSNs, credit-card numbers, private keys, Bearer tokens and URL query secrets. Free trial for the first 500 chars, then $0.001 per full job on Base mainnet. Batch pricing available.',
  website_url: 'https://desanatization-production.up.railway.app',
  category: 'AI',
  endpoints: ['/api/resource', '/api/sanitize/trial', '/api/sanitize/batch'],
  notes:
    'x402 v2 with CDP facilitator on Base mainnet. Bazaar discovery enabled. PayTo: 0x8d9372cdF4Cef4EBA4BA63D3552755aA476eDb92.',
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