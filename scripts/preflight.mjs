// ============================================================================
// Go-Live Preflight Gate
//
// Verifies a LIVE deployment end-to-end before you trust it with money:
//   1. health + readiness respond and the paywall is armed
//   2. the 402 challenge decodes and is internally consistent
//      (scheme/network/price/payTo/asset, and payTo is not the demo address)
//   3. the facilitator actually supports the scheme+network being advertised
//   4. the agent storefront (llms.txt, openapi.json, skill.md, receipts) is up
//
// Usage:
//   node scripts/preflight.mjs https://your-app.up.railway.app
//   BASE_URL=https://your-app.up.railway.app npm run preflight
//
// Exit code 0 = safe to send live traffic; 1 = fix the listed FAILs first.
// ============================================================================

const DEMO_PAY_TO = '0x742d35Cc6634C0532925a3b844Bc9e7595f42b15'; // x402 docs demo address
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const KNOWN_FACILITATORS = {
  'eip155:84532': 'https://x402.org/facilitator',
  'eip155:8453': 'https://api.cdp.coinbase.com/platform/v2/x402',
};

const base = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const facilitatorOverride = process.env.PREFLIGHT_FACILITATOR_URL;

/** @type {Array<{name: string, ok: boolean, detail: string}>} */
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
 * Fetch with a timeout, returning status + body without throwing.
 *
 * @param {string} url - Absolute URL
 * @param {RequestInit} [init] - Optional fetch init
 * @returns {Promise<{status: number, body: string}>}
 */
async function fetchSafe(url, init = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), ...init });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: 0, body: String(error?.cause?.message ?? error?.message ?? error) };
  }
}

// --- 1. Health + readiness ---------------------------------------------------
const health = await fetchSafe(`${base}/health`);
check('GET /health', health.status === 200, `HTTP ${health.status}`);
let paywallReady = false;
let network;
if (health.status === 200) {
  try {
    const parsed = JSON.parse(health.body);
    paywallReady = parsed.paywallReady === true;
    network = parsed.network;
  } catch {
    /* handled by checks below */
  }
}
check('paywallReady', paywallReady, `paywallReady=${paywallReady} network=${network ?? 'unknown'}`);
const ready = await fetchSafe(`${base}/ready`);
check('GET /ready', ready.status === 200, `HTTP ${ready.status}`);

// --- 2. 402 challenge ----------------------------------------------------------
const resourcePath = process.env.PREFLIGHT_RESOURCE_PATH || '/api/resource';
const probeBody = JSON.stringify({ text: 'Contact jane@example.com' });

/** @type {{status: number, headers: Headers}|undefined} */
let probe;
try {
  const response = await fetch(`${base}${resourcePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: probeBody,
    signal: AbortSignal.timeout(15_000),
  });
  probe = { status: response.status, headers: response.headers };
  await response.body?.cancel();
} catch (error) {
  check('challenge fetch', false, String(error?.cause?.message ?? error?.message ?? error));
}
check(`POST ${resourcePath} unpaid -> 402`, probe?.status === 402, `HTTP ${probe?.status ?? 0}`);

/** @type {any} */
let decoded;
const headerValue = probe?.headers.get('payment-required');
if (headerValue) {
  try {
    decoded = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
    check('challenge decodes (x402 v2)', decoded?.x402Version === 2, `version=${decoded?.x402Version}`);
    const accepts = decoded?.accepts?.[0] ?? {};
    check('scheme=exact', accepts.scheme === 'exact', `scheme=${accepts.scheme}`);
    if (network) check('network matches /health', accepts.network === network, `${accepts.network} vs ${network}`);
    check(
      'payTo is a real EVM address (not the demo)',
      EVM_ADDRESS_PATTERN.test(accepts.payTo ?? '') && accepts.payTo !== DEMO_PAY_TO,
      `payTo=${accepts.payTo}`,
    );
    check('amount is a positive integer', /^\d+$/.test(accepts.amount ?? '') && Number(accepts.amount) > 0, `amount=${accepts.amount}`);
    check('asset address valid', EVM_ADDRESS_PATTERN.test(accepts.asset ?? ''), `asset=${accepts.asset}`);
    check('bazaar discovery attached', Boolean(decoded?.extensions?.bazaar), 'extensions.bazaar present');
  } catch (error) {
    check('challenge decodes (x402 v2)', false, String(error?.message ?? error));
  }
} else if (probe?.status === 402) {
  check('payment-required header present', false, 'header missing on 402 response');
}

// --- 3. Facilitator supports what we advertise --------------------------------
// CDP requires a fresh signed JWT per request, so its /supported endpoint can
// never be probed unauthenticated. For CDP the server's own paywallReady
// (set by the boot-time AUTHENTICATED sync) is the proof of support; for
// plain facilitators we probe /supported directly.
const facilitatorUrl = facilitatorOverride ?? KNOWN_FACILITATORS[network ?? ''];
if (facilitatorUrl) {
  if (facilitatorUrl.includes('api.cdp.coinbase.com')) {
    check(
      'CDP facilitator support (via authenticated boot sync)',
      paywallReady,
      'paywallReady=true proves the signed-JWT sync against CDP succeeded',
    );
  } else {
  /** @type {Record<string, string>} */
  let authHeaders = {};
  const rawHeaders = process.env.PREFLIGHT_FACILITATOR_AUTH_HEADERS;
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') authHeaders[k] = v;
        }
      }
    } catch {
      check('preflight auth headers parse', false, 'PREFLIGHT_FACILITATOR_AUTH_HEADERS is not valid JSON');
    }
  }
  const supported = await fetchSafe(`${facilitatorUrl.replace(/\/+$/, '')}/supported`, {
    headers: authHeaders,
  });
  let supportsExact = false;
  if (supported.status === 200) {
    try {
      const parsed = JSON.parse(supported.body);
      const kinds = Array.isArray(parsed) ? parsed : (parsed.kinds ?? []);
      supportsExact = kinds.some((k) => k.scheme === 'exact' && k.network === network);
    } catch {
      /* treated as unsupported below */
    }
  }
  check('facilitator supports scheme+network', supportsExact, `${facilitatorUrl} (HTTP ${supported.status})`);
  }
} else {
  check('facilitator known for network', false, `no known facilitator for ${network} — set PREFLIGHT_FACILITATOR_URL`);
}

// --- 4. Agent storefront --------------------------------------------------------
for (const [name, path] of [
  ['llms.txt', '/llms.txt'],
  ['openapi.json', '/openapi.json'],
  ['skill.md', '/skill.md'],
  ['receipts', '/receipts'],
]) {
  const store = await fetchSafe(`${base}${path}`);
  check(`storefront ${name}`, store.status === 200, `HTTP ${store.status}`);
}

// --- Verdict --------------------------------------------------------------------
let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`);
}
console.log('');
console.log(
  failed === 0
    ? `PREFLIGHT OK — ${results.length}/${results.length} checks passed. ${base} is safe to send live traffic.`
    : `PREFLIGHT FAILED — ${failed}/${results.length} checks failed. Fix the FAILs before sending buyers.`,
);
process.exit(failed === 0 ? 0 : 1);
