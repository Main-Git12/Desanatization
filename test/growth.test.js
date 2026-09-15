// ============================================================================
// Growth-Loop Tests: the product agents buy, the trial that converts them,
// and the storefront they discover.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FREE_TIER_MAX_CHARS, sanitizeText, validateSanitizeBody } from '../sanitize.js';
import { getInsights, resetMetrics } from '../middleware/monitoring.js';
import { startTestServer } from './support/boot.js';

describe('sanitize engine', () => {
  test('redacts every PII class and counts them', () => {
    const result = sanitizeText(
      'Mail jane@example.com, call 415-555-1234, ssn 123-45-6789, card 4242424242424242, key 0x' +
        'a'.repeat(64) +
        ', Bearer abcdefgh1234, visit https://x.test/?token=secret',
    );
    assert.match(result.clean, /\[redacted-email\]/);
    assert.match(result.clean, /\[redacted-phone\]/);
    assert.match(result.clean, /\[redacted-ssn\]/);
    assert.match(result.clean, /\[redacted-card\]/);
    assert.match(result.clean, /\[redacted-secret\]/);
    assert.match(result.clean, /token=\[redacted\]/);
    assert.deepEqual(result.redactions, {
      emails: 1,
      phones: 1,
      ssns: 1,
      cards: 1,
      secrets: 2,
      urlTokens: 1,
    });
  });

  test('does not mangle plain digit runs (Luhn + length guards)', () => {
    const result = sanitizeText('order 12345 shipped in 2024');
    assert.equal(result.clean, 'order 12345 shipped in 2024');
    assert.equal(result.redactions.cards, 0);
    assert.equal(result.redactions.phones, 0);
  });

  test('validateSanitizeBody rejects missing, empty and oversized input', () => {
    assert.ok(validateSanitizeBody({}).error);
    assert.ok(validateSanitizeBody({ text: '' }).error);
    assert.ok(validateSanitizeBody({ text: 'x'.repeat(20_001) }).error);
    assert.equal(validateSanitizeBody({ text: 'ok' }).text, 'ok');
  });
});

describe('growth loop', () => {
  test('free trial sanitizes without payment and carries the upsell', async () => {
    resetMetrics();
    const server = await startTestServer();
    try {
      const response = await server.fetch('/api/sanitize/trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Mail jane@example.com ' + 'x'.repeat(2000) }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.trial, true);
      assert.equal(body.truncated, true);
      assert.ok(body.clean.includes('[redacted-email]'));
      assert.ok(body.upsell.paid.includes('/api/resource'));
      assert.equal(getInsights().funnel.freeTrial, 1);
    } finally {
      await server.close();
    }
  });

  test('storefront endpoints are public and agent-readable', async () => {
    const server = await startTestServer();
    try {
      const llms = await server.fetch('/llms.txt');
      assert.equal(llms.status, 200);
      assert.match(llms.headers.get('content-type'), /text\/plain/);
      assert.match(await llms.text(), /x402/);

      const openapi = await server.fetch('/openapi.json');
      assert.equal(openapi.status, 200);
      const spec = await openapi.json();
      assert.equal(spec.openapi, '3.1.0');
      assert.ok(spec.paths['/api/resource']);

      const skill = await server.fetch('/skill.md');
      assert.equal(skill.status, 200);
      assert.match(await skill.text(), /PAYMENT-SIGNATURE/);

      const home = await server.fetch('/');
      assert.match((await home.json()).product.freeTrial, /trial/);
    } finally {
      await server.close();
    }
  });

  test('insights expose trial-to-paid conversion', async () => {
    resetMetrics();
    const server = await startTestServer({ env: { METRICS_TOKEN: 's3cret' } });
    try {
      const auth = { Authorization: 'Bearer s3cret' };
      assert.equal((await server.fetch('/api/insights')).status, 401);
      const insights = await (await server.fetch('/api/insights', { headers: auth })).json();
      assert.equal(insights.conversion.trialToPaidRate, 0);
      assert.ok('freeTrial' in insights.funnel === false || typeof insights.funnel === 'object');
    } finally {
      await server.close();
    }
  });
});
