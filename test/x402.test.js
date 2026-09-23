// ============================================================================
// x402 Payment Flow Tests
//
// These exercise the real SDK middleware (not mocks of it) with a stub
// facilitator, so a broken scheme registration, route pattern, or middleware
// argument order fails the build instead of silently blocking revenue.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { resetMetrics, getMetrics } from '../middleware/monitoring.js';
import { startTestServer } from './support/boot.js';
import {
  BASE_MAINNET_USDC,
  BASE_SEPOLIA_USDC,
  createOfflineFacilitator,
  createStubFacilitator,
} from './support/stubFacilitator.js';

/** Matches PAY_TO_ADDRESS in the test environment. */
const PAY_TO = '0x742d35Cc6634C0532925a3b844Bc9e7595f42b15';

/** Throwaway signing key: no funds, no value, only a valid EIP-3009 signature. */
const TEST_ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

/**
 * Build an x402 client that can sign payments for the given network.
 *
 * @param {string} [network] - Network to register the scheme for
 * @returns {object} Client with the documented convenience helpers
 */
function createSigningClient(network = 'eip155:84532') {
  const coreClient = new x402Client();
  coreClient.setSpendControls({ maxAmountPerPayment: '$1' });
  coreClient.register(network, new ExactEvmScheme(TEST_ACCOUNT));
  return {
    coreClient,
    httpClient: new x402HTTPClient(coreClient),
    fetchWithPayment: wrapFetchWithPayment(fetch, coreClient),
  };
}

/**
 * Perform the documented two-step unpaid -> signed -> retry flow.
 * POSTs a sanitize job (the real product); GET variants are covered by the
 * legacy test below.
 *
 * @param {object} server - Test server handle
 * @param {string} path - Path to request
 * @param {object} signing - Result of createSigningClient()
 * @param {object} [body] - JSON body to POST
 * @returns {Promise<{ challenge: object, paymentPayload: object, response: Response }>}
 */
async function payAndRetry(server, path, signing, body = { text: 'Contact jane@example.com' }) {
  const challengeResponse = await server.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const challenge = signing.httpClient.getPaymentRequiredResponse(
    (name) => challengeResponse.headers.get(name),
    await challengeResponse.json(),
  );
  const paymentPayload = await signing.coreClient.createPaymentPayload(challenge);
  const headers = {
    ...signing.httpClient.encodePaymentSignatureHeader(paymentPayload),
    'Content-Type': 'application/json',
  };
  const response = await server.fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { challenge, paymentPayload, response };
}

describe('x402 payment flow', () => {
  test('unpaid POST returns 402 with a machine-readable challenge', async () => {
    const server = await startTestServer();
    try {
      const response = await server.fetch('/api/resource', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });

      assert.equal(response.status, 402);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');

      // The protocol surface: the PAYMENT-REQUIRED header.
      const header = response.headers.get('payment-required');
      assert.ok(header, 'PAYMENT-REQUIRED header must be present');

      const challenge = decodePaymentRequiredHeader(header);
      assert.equal(challenge.x402Version, 2);
      assert.equal(challenge.accepts.length, 1);

      const accept = challenge.accepts[0];
      assert.equal(accept.scheme, 'exact');
      assert.equal(accept.network, 'eip155:84532');
      assert.equal(accept.payTo, PAY_TO);
      assert.equal(accept.amount, '1000', '$0.001 of a 6-decimal token is 1000 units');
      assert.equal(accept.asset, BASE_SEPOLIA_USDC);
      assert.equal(accept.maxTimeoutSeconds, 300);
      assert.equal(accept.extra?.name, 'USDC');

      // The human/agent-friendly mirror in the body.
      const body = await response.json();
      assert.equal(body.error, 'Payment required');
      assert.equal(body.accepts[0].amount, '1000');
      assert.equal(body.accepts[0].asset, BASE_SEPOLIA_USDC);
      assert.equal(body.accepts[0].price, '$0.001');
    } finally {
      await server.close();
    }
  });

  test('the 402 body points a wallet-less agent at the free trial', async () => {
    const server = await startTestServer();
    try {
      // An agent that hits the paywall and cannot pay is the cheapest buyer
      // we will ever get a second chance at — but only if the 402 tells it
      // there is a free way to see the output work.
      const response = await server.fetch('/api/resource', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      assert.equal(response.status, 402);

      const { freeTrial } = await response.json();
      assert.equal(freeTrial.endpoint, '/api/sanitize/trial');
      assert.equal(freeTrial.method, 'POST');
      assert.equal(freeTrial.maxChars, 500);
      assert.match(freeTrial.cost, /free/i);

      // The advertised endpoint must actually exist and be free — a 402 that
      // points at a dead path is worse than one that points nowhere.
      const trial = await server.fetch(freeTrial.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Contact jane@example.com' }),
      });
      assert.equal(trial.status, 200);
      assert.equal((await trial.json()).clean, 'Contact [redacted-email]');
    } finally {
      await server.close();
    }
  });

  test('the batch 402 also advertises the trial, and says the trial is single-text only', async () => {
    const server = await startTestServer();
    try {
      const response = await server.fetch('/api/sanitize/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ['a'] }),
      });
      const { freeTrial } = await response.json();
      assert.equal(freeTrial.endpoint, '/api/sanitize/trial');
      assert.match(freeTrial.note, /batch route has no trial/);
    } finally {
      await server.close();
    }
  });

  test('batch settles at the same price as a single job when BATCH_PRICE is unset', async () => {
    const server = await startTestServer();
    try {
      const response = await server.fetch('/api/sanitize/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ['a'] }),
      });
      assert.equal(response.status, 402);
      const challenge = decodePaymentRequiredHeader(response.headers.get('payment-required'));
      assert.equal(challenge.accepts[0].amount, '1000'); // same as the $0.001 single-job price
    } finally {
      await server.close();
    }
  });

  test('BATCH_PRICE prices the batch route independently of the single-job price', async () => {
    const server = await startTestServer({ env: { BATCH_PRICE: '$0.005' } });
    try {
      const single = await server.fetch('/api/resource', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      const single402 = decodePaymentRequiredHeader(single.headers.get('payment-required'));
      assert.equal(single402.accepts[0].amount, '1000', 'single-job price is unaffected by BATCH_PRICE');

      const batch = await server.fetch('/api/sanitize/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ['a', 'b', 'c'] }),
      });
      assert.equal(batch.status, 402);
      const batch402 = decodePaymentRequiredHeader(batch.headers.get('payment-required'));
      assert.equal(batch402.accepts[0].amount, '5000', '$0.005 of a 6-decimal token is 5000 units');

      const batchBody = await batch.json();
      assert.equal(batchBody.accepts[0].price, '$0.005');
    } finally {
      await server.close();
    }
  });

  test('a signed payment is verified, settled, and unlocks the resource', async () => {
    resetMetrics();
    const server = await startTestServer();
    try {
      const signing = createSigningClient();
      const { response } = await payAndRetry(server, '/api/resource', signing);

      assert.equal(response.status, 200);

      const receipt = decodePaymentResponseHeader(response.headers.get('payment-response'));
      assert.equal(receipt.success, true);
      assert.equal(receipt.network, 'eip155:84532');
      assert.equal(receipt.amount, '1000');

      const body = await response.json();
      assert.equal(body.success, true);
      // Real product shape: sanitized output, not a placeholder message.
      assert.equal(body.clean, 'Contact [redacted-email]');

      // The facilitator was actually driven through verify + settle.
      assert.equal(server.facilitator.calls.verify, 1);
      assert.equal(server.facilitator.calls.settle, 1);

      // Revenue is observed without querying the chain.
      const metrics = getMetrics();
      assert.equal(metrics.settledPayments, 1);
      assert.equal(metrics.revenueAtomicByAsset[BASE_SEPOLIA_USDC], '1000');
      assert.equal(metrics.failedPayments, 0);
    } finally {
      await server.close();
    }
  });

  test('legacy paid GET with ?text= still settles', async () => {
    const server = await startTestServer();
    try {
      const signing = createSigningClient();
      const challengeResponse = await server.fetch('/api/resource?text=hi');
      const challenge = signing.httpClient.getPaymentRequiredResponse(
        (name) => challengeResponse.headers.get(name),
        await challengeResponse.json(),
      );
      const paymentPayload = await signing.coreClient.createPaymentPayload(challenge);
      const headers = signing.httpClient.encodePaymentSignatureHeader(paymentPayload);
      const response = await server.fetch('/api/resource?text=hi', { headers });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).success, true);
    } finally {
      await server.close();
    }
  });
test('mainnet configuration prices in mainnet USDC', async () => {
    const server = await startTestServer({
      env: { NETWORK: 'eip155:8453', FACILITATOR_URL: 'https://facilitator.example' },
    });
    try {
      const response = await server.fetch('/api/resource');
      const challenge = decodePaymentRequiredHeader(response.headers.get('payment-required'));
      assert.equal(challenge.accepts[0].network, 'eip155:8453');
      assert.equal(challenge.accepts[0].asset, BASE_MAINNET_USDC);
      assert.equal(challenge.accepts[0].payTo, PAY_TO);
    } finally {
      await server.close();
    }
  });

  test('a payment the facilitator rejects returns 402 and never settles', async () => {
    resetMetrics();
    const server = await startTestServer({
      facilitatorClient: createStubFacilitator({ verifyOk: false }),
    });
    try {
      const signing = createSigningClient();
      const { response } = await payAndRetry(server, '/api/resource', signing);

      assert.equal(response.status, 402, 'a rejected payment must not unlock the resource');
      assert.equal(server.facilitator.calls.settle, 0, 'nothing may settle after a failed verify');
      assert.equal(getMetrics().failedPayments, 1);
    } finally {
      await server.close();
    }
  });

  test('unpaid 402s are not counted as errors', async () => {
    resetMetrics();
    const server = await startTestServer();
    try {
      await server.fetch('/api/resource');
      const metrics = getMetrics();
      assert.equal(metrics.paymentRequiredResponses, 1);
      assert.equal(metrics.totalErrors, 0);
      assert.equal(metrics.errorRatePercent, 0);
    } finally {
      await server.close();
    }
  });

  test('serves 503 (retryable) to buyers while the facilitator is unreachable', async () => {
    const server = await startTestServer({
      facilitatorClient: createOfflineFacilitator(),
      initialize: false,
    });
    try {
      const paid = await server.fetch('/api/resource');
      assert.equal(paid.status, 503);
      assert.equal(paid.headers.get('retry-after'), '30');

      const ready = await server.fetch('/ready');
      assert.equal(ready.status, 503);
      assert.equal((await ready.json()).status, 'not-ready');

      // Liveness must stay 200 so an orchestrator never restart-loops.
      const health = await server.fetch('/health');
      assert.equal(health.status, 200);
      assert.equal((await health.json()).paywallReady, false);
    } finally {
      await server.close();
    }
  });

  test('a failed preflight surfaces the reason without crashing the process', async () => {
    const server = await startTestServer({
      facilitatorClient: createOfflineFacilitator(),
      initialize: false,
    });
    try {
      await assert.rejects(() => server.x402.initialize(), /unreachable/);
      assert.equal(server.x402.isReady(), false);
      assert.match(server.x402.lastInitializationError().message, /unreachable/);
    } finally {
      await server.close();
    }
  });

  test('a custom RESOURCE_PATH is the protected route', async () => {
    const server = await startTestServer({ env: { RESOURCE_PATH: '/api/premium/data' } });
    try {
      assert.equal((await server.fetch('/api/premium/data')).status, 402);
      // The old default path is no longer protected, and no longer exists.
      assert.equal((await server.fetch('/api/resource')).status, 404);
    } finally {
      await server.close();
    }
  });
});