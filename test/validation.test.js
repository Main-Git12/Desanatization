// ============================================================================
// Middleware Unit Tests
//
// Covers the middleware that used to be dead code: it is now wired into the
// request path, so it needs to be correct.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { getMetrics, resetMetrics, trackPayment } from '../middleware/monitoring.js';
import {
  assignRequestId,
  extractPaymentHeader,
  validateContentType,
  validateQueryParams,
} from '../middleware/validation.js';

/**
 * Start an Express app exposing a request echo, so middleware effects are
 * observable over real HTTP.
 *
 * @param {Function[]} middleware - Middleware to mount before the route
 * @param {Function} [route] - Route handler override
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>} Server handle
 */
async function startApp(middleware, route) {
  const app = express();
  app.use(express.json());
  for (const mw of middleware) {
    app.use(mw);
  }
  app.all(
    '/echo',
    route ??
      ((req, res) => {
        res.json({ id: req.id, x402: req.x402 ?? null, query: req.query });
      }),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      }),
  };
}

describe('request id middleware', () => {
  test('assigns a UUID when no usable inbound id is present', async () => {
    const server = await startApp([assignRequestId]);
    try {
      const response = await fetch(`${server.baseUrl}/echo`);
      const body = await response.json();
      assert.match(body.id, /^[0-9a-f-]{36}$/);
      assert.equal(response.headers.get('x-request-id'), body.id);
    } finally {
      await server.close();
    }
  });
});

describe('payment header middleware', () => {
  test('reads the v2 PAYMENT-SIGNATURE header', async () => {
    const server = await startApp([assignRequestId, extractPaymentHeader]);
    try {
      const response = await fetch(`${server.baseUrl}/echo`, {
        headers: { 'PAYMENT-SIGNATURE': 'v2-payload' },
      });
      const body = await response.json();
      assert.equal(body.x402.paymentHeaderVersion, 2);
      assert.equal(body.x402.paymentHeaderBytes, 10);
    } finally {
      await server.close();
    }
  });

  test('reads the legacy v1 X-PAYMENT header', async () => {
    const server = await startApp([assignRequestId, extractPaymentHeader]);
    try {
      const response = await fetch(`${server.baseUrl}/echo`, { headers: { 'X-PAYMENT': 'v1-payload' } });
      const body = await response.json();
      assert.equal(body.x402.paymentHeaderVersion, 1);
    } finally {
      await server.close();
    }
  });

  test('never rejects a request that carries no payment header', async () => {
    const server = await startApp([assignRequestId, extractPaymentHeader]);
    try {
      const response = await fetch(`${server.baseUrl}/echo`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).x402, null);
    } finally {
      await server.close();
    }
  });
});

describe('content type middleware', () => {
  test('rejects a non-JSON POST with 400', async () => {
    const server = await startApp([assignRequestId, validateContentType]);
    try {
      const response = await fetch(`${server.baseUrl}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'nope',
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /application\/json/);
    } finally {
      await server.close();
    }
  });
describe('query parameter middleware', () => {
  test('rejects unknown parameters and lists the allowed ones', async () => {
    const server = await startApp([assignRequestId, validateQueryParams(['verbose'])]);
    try {
      const rejected = await fetch(`${server.baseUrl}/echo?evil=1`);
      assert.equal(rejected.status, 400);
      const body = await rejected.json();
      assert.deepEqual(body.invalid, ['evil']);
      assert.deepEqual(body.allowed, ['verbose']);

      assert.equal((await fetch(`${server.baseUrl}/echo?verbose=1`)).status, 200);
    } finally {
      await server.close();
    }
  });
});

describe('rate limiter middleware', () => {
  test('throttles over-limit requests and reports the window', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const server = await startApp([limiter]);
    try {
      const first = await fetch(`${server.baseUrl}/echo`);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('x-ratelimit-limit'), '2');
      assert.equal(first.headers.get('x-ratelimit-remaining'), '1');

      await fetch(`${server.baseUrl}/echo`);

      const limited = await fetch(`${server.baseUrl}/echo`);
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      assert.equal((await limited.json()).error, 'Too many requests');
    } finally {
      await server.close();
      limiter.dispose();
    }
  });

  test('skip() bypasses throttling', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, skip: () => true });
    const server = await startApp([limiter]);
    try {
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await fetch(`${server.baseUrl}/echo`)).status, 200);
      }
    } finally {
      await server.close();
      limiter.dispose();
    }
  });
});

describe('monitoring', () => {
  test('accumulates settled revenue per asset', () => {
    resetMetrics();
    trackPayment({ amount: '1000', asset: '0xaaa', payer: '0x1', network: 'eip155:84532', transaction: '0xtx' });
    trackPayment({ amount: '2500', asset: '0xaaa' });
    trackPayment({ amount: '700', asset: '0xbbb' });

    const metrics = getMetrics();
    assert.equal(metrics.settledPayments, 3);
    assert.equal(metrics.revenueAtomicByAsset['0xaaa'], '3500');
    assert.equal(metrics.revenueAtomicByAsset['0xbbb'], '700');
  });

  test('resetMetrics clears counters', () => {
    trackPayment({ amount: '5', asset: '0xccc' });
    resetMetrics();
    const metrics = getMetrics();
    assert.equal(metrics.settledPayments, 0);
    assert.deepEqual(metrics.revenueAtomicByAsset, {});
    assert.equal(metrics.requestsPerMinute, 0);
  });
});

  test('allows a GET without a content type', async () => {
    const server = await startApp([assignRequestId, validateContentType]);
    try {
      assert.equal((await fetch(`${server.baseUrl}/echo`)).status, 200);
    } finally {
      await server.close();
    }
  });
});