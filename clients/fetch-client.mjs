#!/usr/bin/env node
// ============================================================================
// Desanatization — buyer example (x402 v2)
//
// Makes a request to a paid endpoint, signs the payment the server asks for,
// and prints the settlement receipt.
//
// Usage:
//   EVM_PRIVATE_KEY=0x... node clients/fetch-client.mjs
//   EVM_PRIVATE_KEY=0x... RESOURCE_URL=https://host/api/resource node clients/fetch-client.mjs
//
// The private key is read from the environment and never committed. Use a
// throwaway wallet funded with a little USDC on the server's network.
// ============================================================================

import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

/** Load .env for local development, if present. */
try {
  process.loadEnvFile?.('.env');
} catch {
  // No .env file — environment variables win anyway.
}

const privateKey = process.env.EVM_PRIVATE_KEY;
const resourceUrl =
  process.env.RESOURCE_URL ?? 'https://desanatization-production.up.railway.app/api/resource';
const maxAmountPerPayment = process.env.MAX_AMOUNT_PER_PAYMENT ?? '$0.10';

if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  console.error('✖ EVM_PRIVATE_KEY must be a 32-byte hex private key (0x + 64 hex chars).');
  console.error('  Example: EVM_PRIVATE_KEY=0xabc… node clients/fetch-client.mjs');
  process.exit(1);
}

/**
 * Run the paid request.
 *
 * @returns {Promise<void>} Resolves when the request completes
 */
async function main() {
  const account = privateKeyToAccount(privateKey);
  console.log(`Wallet:   ${account.address}`);
  console.log(`Endpoint: ${resourceUrl}`);

  const client = new x402Client();
  // Safety rail: refuse to sign for more than this per request, whatever the
  // server asks for.
  client.setSpendControls({ maxAmountPerPayment });
  // `eip155:*` covers every EVM chain; the server's challenge decides which.
  client.register('eip155:*', new ExactEvmScheme(account));

  const httpClient = new x402HTTPClient(client);
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const started = performance.now();
  const text = process.env.TEXT ?? 'Contact me at jane@example.com, SSN 123-45-6789, card 4111-1111-1111-1111';
  const url = resourceUrl.includes('?') ? `${resourceUrl}&text=${encodeURIComponent(text)}` : `${resourceUrl}?text=${encodeURIComponent(text)}`;
  const response = await fetchWithPayment(url, { method: 'GET' });
  const elapsed = ((performance.now() - started) / 1000).toFixed(3);

  const result = await httpClient.processResponse(response);
  console.log(`Status:   ${result.status} (payment: ${result.paymentStatus})`);
  console.dir(result.body, { depth: null });

  if (result.header) {
    console.log('Settlement receipt:');
    console.dir(result.header, { depth: null });
  }

  console.log(`Completed in ${elapsed}s`);
}

main().catch((error) => {
  console.error('✖ Request failed:', error?.message ?? error);
  if (error?.cause) {
    console.error('  Cause:', error.cause?.message ?? error.cause);
  }
  if (String(error?.message).includes('No scheme registered')) {
    console.error('  The server asked for a network this client has no scheme for.');
  }
  process.exit(1);
});