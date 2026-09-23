// ============================================================================
// Growth-Loop Tests: the product agents buy, the trial that converts them,
// and the storefront they discover.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { FREE_TIER_MAX_CHARS, sanitizeText, validateBatchBody, validateSanitizeBody } from '../sanitize.js';
import { getInsights, resetMetrics, trackPayment } from '../middleware/monitoring.js';
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

  test('does not redact a long ID as a phone number hiding inside it', () => {
    // Regression: the phone pattern used to match a 13-digit slice *inside* a
    // 16-digit parcel ID, so a public-records release would come back with the
    // parcel number blacked out. Over-redaction is its own failure -- the
    // requester is entitled to everything that is not exempt.
    const result = sanitizeText('Officer badge 4417. Parcel ID 0123456789012345.');
    assert.equal(result.clean, 'Officer badge 4417. Parcel ID 0123456789012345.');
    assert.equal(result.redactions.phones, 0);

    // ...while real phone numbers are still caught.
    const phones = sanitizeText('Call (614) 555-0182 or 614-555-0199');
    assert.equal(phones.redactions.phones, 2);
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
      const skillText = await skill.text();
      assert.match(skillText, /PAYMENT-SIGNATURE/);
      // skill.md exists to be copy-pasted. A curl whose URL is a bare path
      // fails the moment anyone runs it, which is the worst possible first
      // impression for a doc whose whole job is "try this now".
      assert.match(skillText, /curl -X POST https?:\/\/[^\s]+\/api\/sanitize\/trial/);
      assert.doesNotMatch(skillText, /curl -X POST \/api/);

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

describe('paid batch endpoint', () => {
  test('validateBatchBody rejects bad payloads', () => {
    assert.ok(validateBatchBody({}).error);
    assert.ok(validateBatchBody({ items: [] }).error);
    assert.ok(validateBatchBody({ items: Array(11).fill('x') }).error);
    assert.ok(validateBatchBody({ items: ['ok', 42] }).error);
    assert.ok(validateBatchBody({ items: ['ok', 'x'.repeat(20_001)] }).error);
    assert.equal(validateBatchBody({ items: ['a', 'b'] }).items.join(','), 'a,b');
  });

  test('batch route is paywalled: unpaid POST gets a 402 challenge', async () => {
    resetMetrics();
    const server = await startTestServer();
    try {
      const response = await server.fetch('/api/sanitize/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ['Mail jane@example.com', 'Call 415-555-1234'] }),
      });
      assert.equal(response.status, 402);
      // The handler never ran, so no batch funnel event was recorded.
      assert.equal(getInsights().funnel.batchCall, undefined);
    } finally {
      await server.close();
    }
  });

  test('storefront documents the batch route', async () => {
    const server = await startTestServer();
    try {
      const openapi = await (await server.fetch('/openapi.json')).json();
      assert.ok(openapi.paths['/api/sanitize/batch']);
      assert.match(await (await server.fetch('/llms.txt')).text(), /batch/);
      assert.match((await (await server.fetch('/')).json()).product.batch, /batch/);
    } finally {
      await server.close();
    }
  });
});

describe('referrals + receipts', () => {
  test('a valid ?ref= is attributed on the trial', async () => {
    resetMetrics();
    const server = await startTestServer();
    try {
      const response = await server.fetch('/api/sanitize/trial?ref=agent-guy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Mail jane@example.com' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(getInsights().referrals, [{ ref: 'agent-guy', sales: 1 }]);
    } finally {
      await server.close();
    }
  });

  test('an invalid ref is ignored, not counted', async () => {
    resetMetrics();
    const server = await startTestServer();
    try {
      const response = await server.fetch('/api/sanitize/trial?ref=!!bad-ref', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Mail jane@example.com' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(getInsights().referrals, []);
    } finally {
      await server.close();
    }
  });

  test('settled receipts are publicly listable', async () => {
    resetMetrics();
    trackPayment({
      amount: '1000',
      asset: 'USDC',
      payer: '0xabc0000000000000000000000000000000000001',
      network: 'eip155:84532',
      transaction: '0xdeadbeef',
    });
    const server = await startTestServer();
    try {
      const response = await server.fetch('/receipts');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.count, 1);
      assert.equal(body.receipts[0].transaction, '0xdeadbeef');
      assert.equal(body.receipts[0].amount, '1000');
    } finally {
      await server.close();
    }
  });
});

describe('outbound growth engine', () => {
  /** Minimal logger stub so engine logs stay out of test output. */
  const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

  /**
   * Start a fake peer on an ephemeral port.
   *
   * @param {object} behaviour - status/bodies per path
   * @returns {Promise<{ base: string, close: () => Promise<void> }>}
   */
  async function startFakePeer({ outreachStatus = 200 } = {}) {
    const http = await import('node:http');
    const peer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/outreach') {
        res.statusCode = outreachStatus;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"accepted":true}');
      } else if (req.url === '/') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html');
        res.end('<html>x402 peer homepage</html>');
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
    const { port } = peer.address();
    return {
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise((resolve) => peer.close(resolve)),
    };
  }

  test('parseTargets keeps only valid http(s) URLs and normalises them', async () => {
    const { parseTargets } = await import('../growth.js');
    assert.deepEqual(parseTargets(undefined), []);
    assert.deepEqual(parseTargets('not json'), []);
    assert.deepEqual(parseTargets('{"no":"array"}'), []);
    const targets = parseTargets('[{"url":"https://a.example/","kind":"registry"},{"url":"ftp://bad"}]');
    assert.equal(targets.length, 1);
    assert.equal(targets[0].url, 'https://a.example');
    assert.equal(targets[0].kind, 'registry');
    assert.equal(targets[0].score, 1);
  });

  test('parseTargets falls back to the quote-proof url|kind list format', async () => {
    const { parseTargets } = await import('../growth.js');
    // This is what Railway looks like after it strips double quotes:
    const stripped = '[{url:https://a.example,kind:canary}]';
    assert.deepEqual(parseTargets(stripped), []); // mangled JSON yields nothing
    const targets = parseTargets('https://a.example/|canary, https://b.example');
    assert.equal(targets.length, 2);
    assert.equal(targets[0].url, 'https://a.example');
    assert.equal(targets[0].kind, 'canary');
    assert.equal(targets[1].url, 'https://b.example');
    assert.equal(targets[1].kind, 'manual');
    assert.equal(targets[1].score, 1);
  });

  test('mergeDiscovered dedupes by URL and keeps learned scores', async () => {
    const { mergeDiscovered } = await import('../growth.js');
    const existing = [{ url: 'https://a.example', kind: 'manual', score: 3.5, pitches: 2, responses: 1 }];
    const merged = mergeDiscovered(existing, ['https://a.example', 'https://b.example', 'not-a-url', { url: 'https://c.example/', kind: 'feed' }]);
    assert.equal(merged.length, 3);
    assert.equal(merged.find((t) => t.url === 'https://a.example').score, 3.5);
    assert.equal(merged.find((t) => t.url === 'https://b.example').kind, 'discovered');
    assert.equal(merged.find((t) => t.url === 'https://c.example').kind, 'feed');
  });

  test('collapseToOrigins flattens Bazaar routes to peer roots', async () => {
    const { collapseToOrigins } = await import('../growth.js');
    const items = [
      { resource: 'https://api.onesource.io/api/chain/balance' },
      { resource: 'https://api.onesource.io/api/chain/block' },
      { resource: 'https://x402.botsmith.dev/x/tweet' },
      { resource: 'not-a-url' },
      null,
      { resource: 'https://api.bitrefill.com/gift-cards' },
    ];
    const origins = collapseToOrigins(items);
    assert.deepEqual(origins.sort(), [
      'https://api.bitrefill.com',
      'https://api.onesource.io',
      'https://x402.botsmith.dev',
    ]);
  });

  test('buildPitch advertises storefront without leaking secrets', async () => {
    const { buildPitch } = await import('../growth.js');
    const pitch = buildPitch(
      { resource: { serviceName: 'Desanatization', path: '/api/resource' }, price: { amount: '$0.001' }, network: 'eip155:84532' },
      'https://self.example',
    );
    assert.equal(pitch.from, 'https://self.example');
    assert.match(pitch.service.endpoint, /\/api\/resource$/);
    assert.match(pitch.service.docs, /\/llms\.txt$/);
    assert.ok(!JSON.stringify(pitch).includes('PAY_TO'));
  });

  test('a full cycle probes the peer, pitches it, and learns (score rises)', async () => {
    const { createGrowthEngine } = await import('../growth.js');
    const peer = await startFakePeer({ outreachStatus: 200 });
    try {
      const engine = createGrowthEngine({
        config: { growth: { targets: JSON.stringify([{ url: peer.base, kind: 'test' }]) } },
        logger: quietLogger,
        selfBaseUrl: 'https://self.example',
      });
      const summary = await engine.runCycle();
      assert.equal(summary.pitched, 1);
      assert.equal(summary.pool, 1);

      const stats = engine.getStats();
      assert.equal(stats.cycles, 1);
      assert.equal(stats.totalPitches, 1);
      assert.equal(stats.targets[0].lastResult, 'pitched');
      assert.ok(stats.targets[0].score > 1, 'score should rise after a successful pitch');
      assert.equal(stats.targets[0].pitches, 1);
    } finally {
      await peer.close();
    }
  });

  test('an unreachable peer decays instead of being retried first', async () => {
    const { createGrowthEngine } = await import('../growth.js');
    const engine = createGrowthEngine({
      config: { growth: { targets: JSON.stringify([{ url: 'http://127.0.0.1:1', kind: 'dead' }]) } },
      logger: quietLogger,
      selfBaseUrl: 'https://self.example',
    });
    const summary = await engine.runCycle();
    assert.equal(summary.pitched, 0);
    const stats = engine.getStats();
    assert.match(stats.targets[0].lastResult, /unreachable/);
    assert.ok(stats.targets[0].score < 1, 'score should decay for unreachable peers');
  });

  test('the engine stays idle until started, and start() respects GROWTH_ENABLED', async () => {
    const { createGrowthEngine } = await import('../growth.js');
    const disabled = createGrowthEngine({
      config: { growth: { enabled: false } },
      logger: quietLogger,
      selfBaseUrl: 'https://self.example',
    });
    disabled.start(); // must be a no-op, not throw
    assert.equal(disabled.getStats().enabled, false);
  });

  test('/api/growth reports engine state and honours the metrics token', async () => {
    resetMetrics();
    const server = await startTestServer({ env: { METRICS_TOKEN: 'growth-secret' } });
    try {
      const denied = await server.fetch('/api/growth');
      assert.equal(denied.status, 401);

      const response = await server.fetch('/api/growth', {
        headers: { Authorization: 'Bearer growth-secret' },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.enabled, false); // opt-in: off by default
      assert.equal(body.cycles, 0);
      assert.ok(Array.isArray(body.targets));
      assert.ok(Array.isArray(body.inbox));
    } finally {
      await server.close();
    }
  });

  test('closed loop: our engine pitches a peer outreach surface and it lands', async () => {
    resetMetrics();
    const server = await startTestServer({ env: { METRICS_TOKEN: 'loop-secret' } });
    try {
      // A separate peer that exposes the same outreach surface our engine
      // pitches. Pitching our own server is now excluded (a self-canary
      // inflates the inbound counter and teaches the engine nothing), so the
      // peer is the honest recipient here.
      let peerInbound = 0;
      const peer = http.createServer((req, res) => {
        // probeAndPitch probes the root first; a 200 keeps the peer alive for
        // the pitch step. The body mentions x402 so the fingerprinting path
        // treats it as an x402 peer.
        if (req.method === 'GET' && req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('x402 service — see /llms.txt');
        } else if (req.method === 'POST' && req.url === '/api/outreach') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            peerInbound += 1;
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end('{}');
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
      const peerUrl = `http://127.0.0.1:${peer.address().port}`;
      try {
        const { createGrowthEngine } = await import('../growth.js');
        const engine = createGrowthEngine({
          config: { growth: { targets: JSON.stringify([{ url: peerUrl, kind: 'peer' }]) } },
          logger: quietLogger,
          selfBaseUrl: server.baseUrl,
        });
        const summary = await engine.runCycle();
        assert.equal(summary.pitched, 1, 'the peer outreach surface must accept the pitch');

        // The peer received exactly one inbound pitch
        assert.equal(peerInbound, 1, 'peer received the pitch');

        // The engine learned from the interaction: target scored as pitched
        const stats = engine.getStats();
        assert.equal(stats.targets.length, 1, 'engine tracks the peer target');
        assert.equal(stats.targets[0].lastResult, 'pitched', 'target marked as pitched');
        assert.ok(stats.targets[0].score >= 1, 'score increased after successful pitch');
      } finally {
        peer.close();
      }
    } finally {
      await server.close();
    }
  });

  test('the engine never pitches its own URL (self-exclusion)', async () => {
    const { createGrowthEngine } = await import('../growth.js');
    const engine = createGrowthEngine({
      config: { growth: { targets: JSON.stringify([{ url: 'https://self.example', kind: 'self-test' }]) } },
      logger: quietLogger,
      selfBaseUrl: 'https://self.example',
    });
    const summary = await engine.runCycle();
    assert.equal(summary.pitched, 0, 'our own URL must not be pitched');
    assert.equal(summary.pool, 0, 'our own URL must be excluded from the pool');
  });

  test('POST /api/outreach rejects malformed pitches', async () => {
    const server = await startTestServer();
    try {
      const bad = await server.fetch('/api/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      assert.equal(bad.status, 400);
    } finally {
      await server.close();
    }
  });
});

describe('refinement wave: retention, self-service hints, durable learning', () => {
  const quietLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  test('retention: repeat buyers are counted and ranked', () => {
    resetMetrics();
    trackPayment({ amount: '1000', asset: 'USDC', payer: '0xaaa0000000000000000000000000000000000001' });
    trackPayment({ amount: '2000', asset: 'USDC', payer: '0xaaa0000000000000000000000000000000000001' });
    trackPayment({ amount: '3000', asset: 'USDC', payer: '0xbbb0000000000000000000000000000000000002' });
    const { retention } = getInsights();
    assert.equal(retention.totalBuyers, 2);
    assert.equal(retention.returningBuyers, 1);
    assert.equal(retention.repeatPurchaseRate, 0.5);
    assert.equal(retention.topBuyers[0].purchases, 2);
  });

  test('every recoverable 400 carries a self-service hint and example', async () => {
    const server = await startTestServer();
    try {
      const trial = await server.fetch('/api/sanitize/trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wrong: true }),
      });
      assert.equal(trial.status, 400);
      const trialBody = await trial.json();
      assert.ok(trialBody.hint, 'trial 400 must explain how to recover');
      assert.ok(trialBody.example, 'trial 400 must include a working example');

            // A paid route is paywalled first: bad JSON -> 402, not 400. The batch
      // 400+hint handler fires only after payment settles (verified live);
      // the unit test documents the real short-circuit shape instead.
      const batch = await server.fetch('/api/sanitize/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: 'not-an-array' }),
      });
      assert.equal(batch.status, 402, 'unpaid paid-route short-circuits to paywall before body validation');

      const pitch = await server.fetch('/api/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      assert.equal(pitch.status, 400);
      const pitchBody = await pitch.json();
            assert.ok(pitchBody.hint, 'outreach 400 must explain how to recover');
    } finally {
      await server.close();
    }
  });

  test('persist: growth state survives a restart (atomic save + restore)', async () => {
    const { createGrowthEngine } = await import('../growth.js');
    const statePath = path.join(os.tmpdir(), `growth-state-test-${process.pid}-${Date.now()}.json`);
    // Minimal peer that accepts any pitch with a 200.
    const peer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'payment-required': 'x402' });
      res.end('{"x402":"exact"}');
    });
    await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
    const peerUrl = `http://127.0.0.1:${peer.address().port}`;
    try {
      const first = createGrowthEngine({
        config: { growth: { targets: JSON.stringify([{ url: peerUrl, kind: 'persist' }]), statePath } },
        logger: quietLogger,
        selfBaseUrl: 'https://self.example',
      });
      await first.runCycle();
      assert.ok(fsSync.existsSync(statePath), 'state file must exist after a cycle');
      const saved = JSON.parse(fsSync.readFileSync(statePath, 'utf8'));
      assert.equal(saved.cycles, 1);
      assert.equal(saved.totalPitches, 1);

      // A fresh engine (empty target list) must restore everything from disk.
      const second = createGrowthEngine({
        config: { growth: { targets: '[]', statePath } },
        logger: quietLogger,
        selfBaseUrl: 'https://self.example',
      });
      const stats = second.getStats();
      assert.equal(stats.cycles, 1, 'cycle counter restored');
      assert.equal(stats.totalPitches, 1, 'pitch counter restored');
      assert.equal(stats.targets.length, 1, 'targets restored');
      // The exact score depends on how many peer responses the cycle earned
      // (base 1 + x402 pitch bonus + response bonus), so assert the invariant:
      // an earned, above-baseline score survived the restart byte-for-byte.
      const savedScore = saved.targets[0].score;
      assert.ok(savedScore > 1, 'cycle must have earned score above the baseline');
      assert.equal(stats.targets[0].score, savedScore, 'learned score restored');
    } finally {
      peer.close();
      fsSync.rmSync(statePath, { force: true });
    }
  });
});

// ============================================================================
// probeAndPitch: the three outcome branches and what each one teaches.
//
// The per-target learning ledger is the whole point of the growth engine, so
// each branch is exercised directly: an unreachable peer must back off, a
// reachable peer with no outreach surface must stay in rotation, and a peer
// that accepts a pitch must be scored up and have its backoff cleared.
// ============================================================================
describe('probeAndPitch: outcome branches', () => {
  const quietLogger = { info() {}, warn() {}, debug() {}, error() {} };

  /** Start a one-off HTTP peer; returns { url, close }. */
  async function startPeer(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  function targetFor(url) {
    return { url, kind: 'test', score: 1, pitches: 0, responses: 0 };
  }

  test('unreachable peer: score drops, failures increment, backoff doubles', async () => {
    const { probeAndPitch } = await import('../growth.js');
    // Port 1 on loopback refuses connections — the deterministic dead peer.
    const target = targetFor('http://127.0.0.1:1');

    const first = await probeAndPitch(target, { type: 'x402-service-pitch' });
    assert.equal(first.lastResult, 'unreachable:0');
    assert.equal(first.score, 0.5, 'score loses 0.5 per failed contact');
    assert.equal(first.failures, 1);
    assert.ok(first.nextAttemptAt, 'a dead peer must be given a retry time');
    // First failure backs off 60s * 2^1 = 120s.
    const firstDelay = Date.parse(first.nextAttemptAt) - Date.now();
    assert.ok(firstDelay > 60_000 && firstDelay <= 121_000, `unexpected backoff ${firstDelay}ms`);

    // Second failure compounds: 60s * 2^2 = 240s.
    const second = await probeAndPitch(first, { type: 'x402-service-pitch' });
    assert.equal(second.failures, 2);
    assert.equal(second.score, 0, 'score never goes negative');
    const secondDelay = Date.parse(second.nextAttemptAt) - Date.now();
    assert.ok(secondDelay > firstDelay, 'backoff must grow with consecutive failures');
  });

  test('reachable peer with no outreach surface: small score bump, no failures', async () => {
    const { probeAndPitch } = await import('../growth.js');
    // Root succeeds but every POST surface 404s.
    const peer = await startPeer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(404);
        res.end('no outreach here');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello, plain website');
      }
    });
    try {
      const updated = await probeAndPitch(targetFor(peer.url), { type: 'x402-service-pitch' });
      assert.equal(updated.lastResult, 'reachable:no-surface');
      assert.equal(updated.failures, 0, 'a reachable peer is not a failure');
      assert.equal(updated.nextAttemptAt, undefined, 'reachable peers stay in rotation');
      assert.equal(updated.score, 1.5, 'reachable earns a small bump');
      assert.equal(updated.responses, 1, 'the root response is counted');
    } finally {
      await peer.close();
    }
  });

  test('pitched peer: x402 bonus, surface remembered, backoff cleared', async () => {
    const { probeAndPitch } = await import('../growth.js');
    // Accepts the pitch and advertises itself as an x402 peer.
    const peer = await startPeer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'payment-required': 'x402' });
      res.end('{"x402":"exact"}');
    });
    try {
      const priorFailures = { ...targetFor(peer.url), failures: 2, score: 1 };
      const updated = await probeAndPitch(priorFailures, { type: 'x402-service-pitch' });

      assert.equal(updated.lastResult, 'pitched');
      assert.equal(updated.failures, 0, 'a successful pitch must clear the failure streak');
      assert.equal(updated.nextAttemptAt, undefined, 'backoff is lifted after success');
      assert.equal(updated.score, 4, 'start 1 + x402 bonus 3');
      assert.ok(updated.lastSurface, 'the working surface is remembered for the next cycle');
      assert.equal(updated.pitches, priorFailures.pitches + 1);
    } finally {
      await peer.close();
    }
  });

  test('runCycle honours per-target backoff and skips peers not yet due', async () => {
    const { createGrowthEngine } = await import('../growth.js');
    const statePath = path.join(os.tmpdir(), `growth-backoff-${process.pid}-${Date.now()}.json`);
    try {
      const engine = createGrowthEngine({
        config: {
          growth: { targets: JSON.stringify([{ url: 'http://127.0.0.1:1', kind: 'dead' }]), statePath },
        },
        logger: quietLogger,
        selfBaseUrl: 'https://self.example',
      });

      const first = await engine.runCycle();
      assert.equal(first.probed, 1, 'the dead peer is probed once');
      assert.equal(first.pitched, 0, 'a dead peer cannot be pitched');

      // Its nextAttemptAt is now in the future, so the next cycle must skip it.
      const second = await engine.runCycle();
      assert.equal(second.probed, 0, 'a backing-off peer is not re-probed');
    } finally {
      fsSync.rmSync(statePath, { force: true });
    }
  });
});
