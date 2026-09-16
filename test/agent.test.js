import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import http from 'node:http';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskAgent, planNextStep, isStepSuccessful, MAX_STEPS_CAP } from '../agent.js';

const quietLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * A port that is guaranteed to refuse connections: bind one, close it, and
 * hand back the number. Hardcoded ports (e.g. 1) can be filtered instead of
 * refused on Windows, which would burn the full fetch timeout in tests.
 *
 * @returns {Promise<{port: number, url: (path: string) => string}>}
 */
async function refusedTarget() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return { port, url: (path) => `http://127.0.0.1:${port}${path}` };
}

/**
 * Start a controllable local peer: 200 while up, connection-refused when down.
 *
 * @returns {Promise<{ base: string, setUp: () => void, tearDown: () => void, close: () => Promise<void> }>}
 */
async function startPeer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/llms.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('# peer docs');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"hello":"peer"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('task agent', () => {
  test('sanitization goal completes and becomes a replayable skill', async () => {
    const agent = createTaskAgent({ logger: quietLogger });
    const goal = 'sanitize: Mail jane@example.com about the invoice';

    const first = await agent.runTask({ goal });
    assert.equal(first.ok, true);
    assert.equal(first.via, 'skill-learned');
    assert.equal(first.trace[0].result.tool, 'text_sanitize');
    assert.match(first.trace[0].result.clean, /\[redacted-email\]/);

    const second = await agent.runTask({ goal });
    assert.equal(second.ok, true);
    assert.equal(second.via, 'skill-replay', 'a repeated goal must replay the learned skill');

    const ledger = agent.getSkills();
    assert.equal(ledger.tasksRun, 2);
    assert.equal(ledger.tasksSucceeded, 2);
    assert.equal(ledger.skillReplays, 1);
    assert.equal(ledger.skillReplaysSucceeded, 1);
    assert.equal(ledger.skills[0].uses, 1);
  });

  test('environment drift degrades a skill, then observation repairs it', async () => {
    const peer = await startPeer();
    const agent = createTaskAgent({ logger: quietLogger });
    const goal = `discover ${peer.base} and learn its interface`;

    const first = await agent.runTask({ goal });
    assert.equal(first.ok, true);
    assert.equal(first.via, 'skill-learned');
    assert.equal(first.steps, 2, 'discover + docs fetch for an x402-speaking peer');

    await peer.close(); // environment changes under the agent

    const drifted = await agent.runTask({ goal });
    assert.equal(drifted.ok, false);
    assert.equal(drifted.via, 'skill-drift-then-failed');
    assert.equal(agent.getSkills().skills[0].degraded, true, 'the skill must be marked degraded');
  });

  test('unreachable targets fail inside the step budget with a full trace', async () => {
    const dead = await refusedTarget();
    const agent = createTaskAgent({ logger: quietLogger });
    const result = await agent.runTask({ goal: `discover ${dead.url('/')}`, maxSteps: 2 });
    assert.equal(result.ok, false);
    assert.ok(result.trace.length <= 2);
    assert.ok(result.note.includes('budget'));
  });

  test('planning refuses garbage and honours the hard cap', () => {
    assert.deepEqual(planNextStep('discover not-a-url', []), {
      tool: 'text_sanitize',
      args: { text: 'discover not-a-url' },
    });
    assert.equal(isStepSuccessful({ tool: 'http_fetch', ok: true }), true);
    assert.equal(isStepSuccessful({ error: 'boom' }), false);
    assert.ok(MAX_STEPS_CAP >= 8);
  });
});

describe('growth engine adaptation', () => {
  test('context adaptation: hot conversion widens the cycle, cold narrows it', async () => {
    const { createGrowthEngine } = await import('../growth.js');
    const dead = await refusedTarget();
    const many = JSON.stringify(
      Array.from({ length: 6 }, (_, i) => ({ url: dead.url(`/${i}`), kind: 'ctx' })),
    );
    const hot = createGrowthEngine({
      config: { growth: { targets: many } },
      logger: quietLogger,
      selfBaseUrl: 'http://self.test',
      getContext: () => ({ trialToPaidRate: 0.9, freeTrials: 50, inboundPitches: 0 }),
    });
    const hotCycle = await hot.runCycle();
    const cold = createGrowthEngine({
      config: { growth: { targets: many } },
      logger: quietLogger,
      selfBaseUrl: 'http://self.test',
      getContext: () => ({ trialToPaidRate: 0, freeTrials: 0, inboundPitches: 0 }),
    });
    const coldCycle = await cold.runCycle();
    assert.equal(hotCycle.effectiveMax, 4, 'hot environment spends the full cap');
    assert.equal(coldCycle.effectiveMax, 2, 'cold environment conserves effort');
  });

  test('pricing advice: hold by default, double when hot, halve when cold, match rivals', async () => {
    const { createGrowthEngine } = await import('../growth.js');
    const make = (context, inbox = []) => {
      const engine = createGrowthEngine({
        config: { growth: {}, price: '$0.001' },
        logger: quietLogger,
        selfBaseUrl: 'http://self.test',
        getContext: () => context,
      });
      for (const p of inbox) engine.recordInbound(p, 'test');
      return engine.getPricingAdvice();
    };

    assert.match(make({}).suggested, /^\$0\.001$/);
    assert.match(make({ trialToPaidRate: 0.8, freeTrials: 30 }).suggested, /^\$0\.002$/);
    assert.match(make({ trialToPaidRate: 0.02, freeTrials: 40 }).suggested, /^\$0\.0005$/);
    const undercut = make(
      {},
      [{ from: 'http://rival.test', offer: 'same job for $0.0005', at: new Date().toISOString() }],
    );
    assert.equal(undercut.suggested, '$0.0005');
    assert.match(undercut.reason, /competitors/);
  });

  test('a heated market makes the pitch lead with differentiation', async () => {
    const { buildPitch } = await import('../growth.js');
    const calm = buildPitch({ resource: { serviceName: 'S', path: '/r' }, price: '$0.001' }, 'http://self.test', {
      pitches: 1,
    });
    const hot = buildPitch({ resource: { serviceName: 'S', path: '/r' }, price: '$0.001' }, 'http://self.test', {
      pitches: 5,
      min: 0.0005,
    });
        assert.equal(calm.differentiation, undefined);
    assert.match(hot.differentiation, /Active market: 5 services/);
  });
});

describe('task agent persistence', () => {
  const quietLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  test('learned skills + counters survive a restart (durable state)', async () => {
    const { createTaskAgent } = await import('../agent.js');
    const statePath = path.join(os.tmpdir(), `agent-state-${process.pid}-${Date.now()}.json`);
    // First agent: learns a skill and writes it to disk.
    const first = createTaskAgent({ logger: quietLogger, statePath });
    const goal = 'sanitize: Mail jane@example.com about invoice 42';
    const r1 = await first.runTask({ goal });
    assert.equal(r1.ok, true);
    assert.equal(r1.via, 'skill-learned');
    assert.ok(fsSync.existsSync(statePath), 'state file must be written after learning');

    // Second agent, same file: must restore the skill and REPLAY it (not re-learn).
    const second = createTaskAgent({ logger: quietLogger, statePath });
    const r2 = await second.runTask({ goal });
    assert.equal(r2.ok, true);
    assert.equal(r2.via, 'skill-replay', 'restored skill must be replayed, not re-learned');
    const stats = second.getSkills();
    assert.equal(stats.tasksRun, 2, 'run counter restored + incremented');
    assert.equal(stats.tasksSucceeded, 2, 'success counter restored + incremented');
    assert.equal(stats.skillReplays, 1, 'replay counter restored');
    assert.equal(stats.skills.length, 1, 'skill library restored');
    assert.equal(stats.skills[0].uses, 1, 'use count restored + incremented');
    fsSync.rmSync(statePath, { force: true });
  });

  test('a missing or corrupt state file starts fresh instead of crashing', async () => {
    const { createTaskAgent } = await import('../agent.js');
    const missing = path.join(os.tmpdir(), `agent-missing-${process.pid}-${Date.now()}.json`);
    const first = createTaskAgent({ logger: quietLogger, statePath: missing });
    assert.equal(first.getSkills().tasksRun, 0, 'missing file -> fresh start, no crash');

    const corrupt = path.join(os.tmpdir(), `agent-corrupt-${process.pid}-${Date.now()}.json`);
    fsSync.writeFileSync(corrupt, '{ not valid json');
    const second = createTaskAgent({ logger: quietLogger, statePath: corrupt });
    assert.equal(second.getSkills().tasksRun, 0);
    assert.equal(second.getSkills().skills.length, 0, 'corrupt file -> empty library, no crash');
    fsSync.rmSync(corrupt, { force: true });
  });
});
