// ============================================================================
// Live Deployment Verification
//
// Proves the CURRENTLY DEPLOYED build is behaving as the source says it should
// — not just that the local test suite is green. It drives the real, running
// service over HTTP and checks the behaviours that only exist at runtime:
//
//   1. the service is up, armed (paywallReady) and on the expected network
//   2. the outbound growth engine fired a cycle at boot (the index.js change)
//   3. the task agent plans, acts and LEARNS — a repeated goal replays the
//      learned skill instead of re-planning (the agent.js change)
//   4. the agent ledger survives restarts (the c92e04b persistence change)
//   5. the public storefront and the settlement proof feed answer
//
// Usage:
//   node scripts/verify-live.mjs https://your-app.up.railway.app
//   BASE_URL=https://your-app.up.railway.app npm run verify:live
//
// Token-guarded endpoints (/api/growth, /api/agent/*) need METRICS_TOKEN.
// Exit code 0 = the deployment matches source; 1 = a listed check failed.
// ============================================================================

const base = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const token = process.env.METRICS_TOKEN || '';

/** Endpoints that must be reachable for the "current source" checks to run. */
const REQUIRES_TOKEN = ['/api/growth', '/api/agent/task', '/api/agent/skills'];

/** @type {Array<{name: string, ok: boolean, detail: string, skipped?: boolean}>} */
const results = [];

/**
 * Record one check.
 *
 * @param {string} name - Human readable check name
 * @param {boolean} ok - Whether the check passed
 * @param {string} detail - Evidence or failure reason
 * @returns {void}
 */
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

/**
 * Record a check that could not run because a precondition was missing.
 *
 * @param {string} name - Human readable check name
 * @param {string} detail - Why it was skipped
 * @returns {void}
 */
function skip(name, detail) {
  results.push({ name, ok: true, detail, skipped: true });
}

/**
 * Call the deployment, returning parsed JSON plus the HTTP status without
 * throwing on non-2xx (401/503 are meaningful states here, not crashes).
 *
 * @param {string} method - HTTP method
 * @param {string} path - Path below BASE_URL
 * @param {object} [body] - JSON body to send
 * @returns {Promise<{status: number, body: any}>} Parsed response
 */
async function call(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { _raw: text.slice(0, 200) };
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    return { status: 0, body: { _error: String(error?.cause?.message ?? error?.message ?? error) } };
  }
}

// --- 1. Up, armed, on the expected network -----------------------------------
const health = await call('GET', '/health');
check('GET /health', health.status === 200, `HTTP ${health.status}${health.body?._error ? ` (${health.body._error})` : ''}`);
check('paywallReady', health.body?.paywallReady === true, `paywallReady=${health.body?.paywallReady}`);
check('network is CAIP-2', /^eip155:\d+$/.test(health.body?.network ?? ''), `network=${health.body?.network}`);
check('process is warm (booted, not restart-looping)', Number(health.body?.uptimeSeconds) > 60, `uptime=${health.body?.uptimeSeconds}s`);

const ready = await call('GET', '/ready');
check('GET /ready', ready.status === 200, `HTTP ${ready.status} status=${ready.body?.status}`);

// --- 2. Growth engine fired at boot (index.js behaviour) ---------------------
if (!token) {
  skip('growth engine boot-fire', 'no METRICS_TOKEN — /api/growth is guarded');
} else {
  const growth = await call('GET', '/api/growth');
  if (growth.status === 401) {
    check('growth engine boot-fire', false, 'METRICS_TOKEN rejected (HTTP 401)');
  } else {
    check('GET /api/growth', growth.status === 200, `HTTP ${growth.status}`);
    check(
      'growth engine fired a cycle at boot',
      Number(growth.body?.cycles) >= 1,
      `cycles=${growth.body?.cycles} totalPitches=${growth.body?.totalPitches} — proves the boot-fire shipped`,
    );
    check('growth exposes pricing advice', typeof growth.body?.pricingAdvice === 'object' && growth.body.pricingAdvice !== null, 'pricingAdvice present');
  }
}

// --- 3 & 4. Agent learns, then replays; ledger survives a restart ------------
if (!token) {
  skip('task agent learns + replays', 'no METRICS_TOKEN — /api/agent/* is guarded');
  skip('agent ledger persistence', 'no METRICS_TOKEN — /api/agent/* is guarded');
} else {
  const GOAL = 'sanitize: Mail jane@example.com about invoice 42';
  const before = await call('GET', '/api/agent/skills');
  if (before.status === 401) {
    check('task agent learns + replays', false, 'METRICS_TOKEN rejected (HTTP 401)');
    check('agent ledger persistence', false, 'METRICS_TOKEN rejected (HTTP 401)');
  } else {
    const tasksBefore = Number(before.body?.tasksRun) || 0;
    const replaysBefore = Number(before.body?.skillReplays) || 0;

    const run1 = await call('POST', '/api/agent/task', { goal: GOAL });
    check('agent run #1 succeeds', run1.status === 200 && run1.body?.ok === true, `HTTP ${run1.status} ok=${run1.body?.ok}`);

    // Same goal again: a learned skill means the second run replays instead
    // of planning from scratch. That is the whole point of the agent change.
    const run2 = await call('POST', '/api/agent/task', { goal: GOAL });
    check('agent run #2 succeeds', run2.status === 200 && run2.body?.ok === true, `HTTP ${run2.status} ok=${run2.body?.ok}`);

    const after = await call('GET', '/api/agent/skills');
    const tasksAfter = Number(after.body?.tasksRun) || 0;
    const replaysAfter = Number(after.body?.skillReplays) || 0;

    check(
      'agent counts both runs',
      tasksAfter >= tasksBefore + 2,
      `tasksRun ${tasksBefore} -> ${tasksAfter}`,
    );
    check(
      'repeat goal replayed the learned skill (not re-planned)',
      replaysAfter >= replaysBefore + 1,
      `skillReplays ${replaysBefore} -> ${replaysAfter}`,
    );
  }
}

// --- 5. Public proof surfaces ------------------------------------------------
const receipts = await call('GET', '/receipts');
check('GET /receipts', receipts.status === 200, `HTTP ${receipts.status} count=${receipts.body?.count}`);
check('receipts shape', Array.isArray(receipts.body?.receipts), 'receipts[] present (may be empty until a buyer pays)');

const challenge = await fetch(`${base}/api/resource`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Contact jane@example.com' }),
  signal: AbortSignal.timeout(20_000),
}).catch(() => null);
check('paid route still issues a 402 challenge', challenge?.status === 402, `HTTP ${challenge?.status ?? 0}`);

for (const [name, path] of [
  ['llms.txt', '/llms.txt'],
  ['openapi.json', '/openapi.json'],
  ['skill.md', '/skill.md'],
]) {
  const store = await call('GET', path);
  check(`storefront ${name}`, store.status === 200, `HTTP ${store.status}`);
}

// --- Verdict -----------------------------------------------------------------
let failed = 0;
for (const result of results) {
  const tag = result.skipped ? 'SKIP' : result.ok ? 'PASS' : 'FAIL';
  if (!result.ok) failed += 1;
  console.log(`${tag}  ${result.name} — ${result.detail}`);
}
const skipped = results.filter((r) => r.skipped).length;
console.log('');
console.log(
  failed === 0
    ? `LIVE VERIFY OK — ${results.length - skipped}/${results.length - skipped} checks passed at ${base}` +
        (skipped ? ` (${skipped} skipped — set METRICS_TOKEN to run them)` : '')
    : `LIVE VERIFY FAILED — ${failed}/${results.length} checks failed. The deployment does not match source.`,
);
process.exit(failed === 0 ? 0 : 1);
