// ============================================================================
// Self-Healing Supervisor
//
// The supervisor is dependency-free and must never block the revenue path, so
// every action it takes is observable and reversible. These tests pin the
// escalation, cooldown and recovery behaviour.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSupervisor } from '../supervisor.js';

function makeLogger() {
  return { info() {}, warn() {}, error() {} };
}

describe('self-healing supervisor', () => {
  test('escalates a degraded paywall and notifies through the channel', async () => {
    const notifications = [];
    const notifier = {
      notify: async (event, data) => {
        notifications.push({ event, data });
        return true;
      },
    };
    const x402 = { isReady: () => false };
    const supervisor = createSupervisor({ logger: makeLogger(), notifier, x402, cooldownMs: 0 });

    await supervisor.escalate({ name: 'paywallReady', ok: false, detail: 'facilitator not ready' });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].event, 'health');
    assert.match(notifications[0].data.message, /paywallReady/);

    const snap = supervisor.snapshot();
    assert.equal(snap.degradedCount, 1);
    assert.equal(snap.degraded[0].name, 'paywallReady');
  });

  test('honours the notification cooldown so a channel is not spammed', async () => {
    let calls = 0;
    const notifier = { notify: async () => { calls += 1; return true; } };
    const x402 = { isReady: () => false };
    // cooldownMs=0 means every call escalates; a large cooldown means only the
    // first one fires.
    const supervisor = createSupervisor({ logger: makeLogger(), notifier, x402, cooldownMs: 60_000 });

    await supervisor.escalate({ name: 'paywallReady', ok: false, detail: 'down' });
    await supervisor.escalate({ name: 'paywallReady', ok: false, detail: 'down' });
    assert.equal(calls, 1, 'second escalation suppressed by cooldown');
  });

  test('recovers a signal once it is healthy again', () => {
    const supervisor = createSupervisor({ logger: makeLogger(), notifier: { notify: async () => true }, x402: { isReady: () => false } });
    supervisor.escalate({ name: 'paywallReady', ok: false, detail: 'down' });
    assert.equal(supervisor.snapshot().degradedCount, 1);
    supervisor.recover('paywallReady');
    assert.equal(supervisor.snapshot().degradedCount, 0);
  });

  test('nudges the growth engine to skip its next cycle on escalation', async () => {
    let nudged = false;
    const growthEngine = { nudge: () => { nudged = true; return true; } };
    const supervisor = createSupervisor({ logger: makeLogger(), notifier: { notify: async () => true }, growthEngine, x402: { isReady: () => false }, cooldownMs: 0 });
    await supervisor.escalate({ name: 'paywallReady', ok: false, detail: 'down' });
    assert.equal(nudged, true);
  });

  test('check() reads paywall readiness from the x402 bundle', () => {
    const supervisor = createSupervisor({ logger: makeLogger(), notifier: { notify: async () => true }, x402: { isReady: () => true } });
    const signals = supervisor.check();
    assert.equal(signals.length, 1);
    assert.equal(signals[0].name, 'paywallReady');
    assert.equal(signals[0].ok, true);
  });
});