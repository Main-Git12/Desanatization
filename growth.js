// ============================================================================
// Outbound Growth Engine ("agents that seek agents")
//
// A self-learning outreach loop:
//   1. DISCOVER  — load peer targets from GROWTH_TARGETS (JSON) and/or an
//                  optional GROWTH_DISCOVERY_URL registry feed.
//   2. PROBE     — visit each peer's root: is it an x402 agent (402 challenge,
//                  bazaar extension, llms.txt)? What language does it speak?
//   3. PITCH     — leave a machine-readable pitch at the peer's advertised
//                  outreach surface, when it exposes one.
//   4. LEARN     — score targets by response rate; the next cycle spends
//                  effort on what worked and drops what did not.
//
// Opt-in (GROWTH_ENABLED), rate-limited and capped per cycle: it pitches a
// small number of peers politely, measures, and adapts. Never a spam cannon.
// ============================================================================

const X402_CHALLENGE_HEADER = 'payment-required';

/**
 * @typedef {object} GrowthTarget
 * @property {string} url - Peer base URL
 * @property {string} kind - Channel label used for learning (e.g. "registry")
 * @property {number} score - Rolling effectiveness score (higher = pitch first)
 * @property {number} pitches - Times pitched
 * @property {number} responses - Times the peer answered
 * @property {string} [lastResult] - Last probe outcome
 * @property {string} [lastAt] - ISO timestamp of last contact
 */

/**
 * Parse the GROWTH_TARGETS environment variable.
 *
 * @param {string|undefined} raw - JSON array of {url, kind?} objects
 * @returns {GrowthTarget[]} Initial targets (empty when unset/invalid)
 */
export function parseTargets(raw) {
  if (!raw || String(raw).trim() === '') return [];
  const input = String(raw).trim();
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t.url === 'string' && /^https?:\/\//.test(t.url))
      .map((t) => ({
        url: t.url.replace(/\/+$/, ''),
        kind: typeof t.kind === 'string' ? t.kind.slice(0, 32) : 'manual',
        score: 1,
        pitches: 0,
        responses: 0,
      }));
  } catch {
    // Fall through to the shell-friendly format below.
  }
  // Quote-proof fallback: "https://a|kind, https://b" — some hosts (Railway
  // CLI) strip double quotes from variable values, so JSON is not reliable.
  return input
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, kind] = part.split('|');
      return { url: url?.replace(/\/+$/, ''), kind: (kind ?? 'manual').slice(0, 32) };
    })
    .filter((t) => /^https?:\/\//.test(t.url))
    .map((t) => ({ ...t, score: 1, pitches: 0, responses: 0 }));
}

/**
 * Merge a discovery feed (array of URLs or {url, kind} objects) into the
 * target pool, deduplicating by URL and preserving learned scores.
 *
 * @param {GrowthTarget[]} existing - Current target pool
 * @param {Array<string|{url: string, kind?: string}>} feed - Discovered peers
 * @returns {GrowthTarget[]} Updated pool
 */
export function mergeDiscovered(existing, feed) {
  const byUrl = new Map(existing.map((t) => [t.url, t]));
  for (const entry of feed ?? []) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
    const normalised = url.replace(/\/+$/, '');
    if (byUrl.has(normalised)) continue;
    byUrl.set(normalised, {
      url: normalised,
      kind: typeof entry === 'object' && typeof entry.kind === 'string' ? entry.kind.slice(0, 32) : 'discovered',
      score: 1,
      pitches: 0,
      responses: 0,
    });
  }
  return [...byUrl.values()];
}

/**
 * Fetch with a timeout, never throwing. Shared with the task agent.
 *
 * @param {string} url - Absolute URL
 * @param {RequestInit} [init] - Optional fetch init
 * @returns {Promise<{status: number, headers: Headers, body: string, ok: boolean}>}
 */
export async function fetchSafe(url, init = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), ...init });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
      ok: response.ok,
    };
  } catch (error) {
    return { status: 0, headers: new Headers(), body: String(error?.message ?? error), ok: false };
  }
}

/**
 * Build the machine-readable pitch we leave for peers. A pitch is a small,
 * honest advertisement of what we sell and how to resell it — never a claim
 * of payment received, never a request for funds.
 *
 * @param {object} config - Loaded application configuration
 * @param {string} selfBaseUrl - Our public base URL
 * @returns {object} Pitch document
 */
export function buildPitch(config, selfBaseUrl, market) {
  const pitch = {
    type: 'x402-service-pitch',
    from: selfBaseUrl,
    service: {
      name: config?.resource?.serviceName ?? 'x402 service',
      endpoint: `${selfBaseUrl}${config?.resource?.path ?? '/api/resource'}`,
      price: config?.price ?? null,
      network: config?.network ?? null,
      freeTrial: `${selfBaseUrl}/api/sanitize/trial`,
      batch: `${selfBaseUrl}/api/sanitize/batch`,
      docs: `${selfBaseUrl}/llms.txt`,
      openapi: `${selfBaseUrl}/openapi.json`,
      proof: `${selfBaseUrl}/receipts`,
    },
    offer:
      'Deterministic PII sanitization for your agent traffic — free trial, $0.001 per full job, ' +
      'batch pricing available. Resell freely with your own ?ref= tag and appear on our leaderboard.',
  };
  // Context adaptation: when several peers are actively pitching us, lead
  // with what separates us instead of the generic line.
  if (market?.pitches >= 3) {
    pitch.differentiation =
      `Active market: ${market.pitches} services pitched us` +
      (market.min ? `, price floor observed $${market.min}` : '') +
      '. We differ: deterministic output, public /receipts, referral revenue share.';
  }
  return pitch;
}

/**
 * Probe one peer and (when it offers an outreach surface) pitch it.
 *
 * @param {GrowthTarget} target - Peer to visit
 * @param {object} pitch - Pitch document from buildPitch()
 * @returns {Promise<GrowthTarget>} Updated target with fresh learning data
 */
export async function probeAndPitch(target, pitch) {
  const updated = { ...target, pitches: target.pitches + 1, lastAt: new Date().toISOString() };

  const root = await fetchSafe(target.url);
  if (!root.ok && root.status !== 402) {
    updated.lastResult = `unreachable:${root.status}`;
    updated.score = Math.max(0, target.score - 0.5);
    // Environment adaptation: exponential backoff instead of retrying a dead
    // peer every cycle. Backoff caps at one hour.
    updated.failures = (target.failures ?? 0) + 1;
    updated.nextAttemptAt = new Date(
      Date.now() + Math.min(3_600_000, 60_000 * 2 ** updated.failures),
    ).toISOString();
    return updated;
  }

  const isX402Peer =
    root.status === 402 ||
    Boolean(root.headers.get(X402_CHALLENGE_HEADER)) ||
    root.body.includes('x402');
  const hasLlms = root.body.includes('llms.txt') || (await fetchSafe(`${target.url}/llms.txt`)).ok;

  // An x402 peer that also exposes an outreach surface gets the pitch.
  // Peers with no surface are recorded as "seen" only — we do not brute-force.
  let pitched = false;
  for (const surface of ['/api/outreach', '/api/pitch', '/contact']) {
    const attempt = await fetchSafe(`${target.url}${surface}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pitch),
    });
    if (attempt.ok) {
      pitched = true;
      break;
    }
  }

  updated.responses = target.responses + (root.ok ? 1 : 0);
  updated.failures = 0;
  updated.nextAttemptAt = undefined;
  updated.lastResult = pitched
    ? 'pitched'
    : isX402Peer
      ? 'peer-seen:no-surface'
      : hasLlms
        ? 'reachable:no-x402'
        : 'reachable';
  // Learning: peers that accept a pitch are worth the most; plain x402 peers
  // less; silent or unreachable peers decay toward the back of the queue.
  updated.score = pitched ? target.score + 2 : isX402Peer ? target.score + 0.5 : Math.max(0, target.score - 0.25);
  return updated;
}

/**
 * Create the growth engine loop.
 *
 * @param {object} options
 * @param {object} options.config - Loaded application configuration
 * @param {object} options.logger - Pino-style logger
 * @param {string} options.selfBaseUrl - Our public base URL
 * @param {number} [options.intervalMs] - Milliseconds between cycles
 * @param {number} [options.maxPerCycle] - Pitch cap per cycle
 * @returns {{ runCycle: () => Promise<object>, getStats: () => object, start: () => void, stop: () => void }}
 */
export function createGrowthEngine({
  config,
  logger,
  selfBaseUrl,
  intervalMs = 6 * 60 * 60_000,
  maxPerCycle = 5,
  getContext,
}) {
  /** @type {GrowthTarget[]} */
  let targets = parseTargets(config.growth?.targets);
  let cycles = 0;
  let totalPitches = 0;
  /** @type {Array<object>} Inbound pitches from peers, newest first (capped). */
  let inbox = [];
  /** @type {object} Latest environment reading (conversion, market heat). */
  let lastContext = {};

  /**
   * Run one discover -> pitch -> learn cycle.
   *
   * @returns {Promise<object>} Cycle summary
   */
  async function runCycle() {
    cycles += 1;

    // DISCOVER: an optional registry feed expands the pool every cycle.
    if (config.growth?.discoveryUrl) {
      const feed = await fetchSafe(config.growth.discoveryUrl);
      if (feed.ok) {
        try {
          const parsed = JSON.parse(feed.body);
          const items = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.resources ?? []);
          targets = mergeDiscovered(targets, items);
        } catch {
          logger.warn('Growth: discovery feed was not valid JSON — skipping.');
        }
      }
    }

    if (targets.length === 0) {
      logger.info('Growth cycle: no targets configured (set GROWTH_TARGETS or GROWTH_DISCOVERY_URL).');
      return { cycles, pitched: 0, pool: 0 };
    }

    // LEARN: adapt effort to the environment. Cold conversion damps effort,
    // hot conversion or a heated market (peers pitching us) raises it to the
    // cap. Peers in backoff are skipped entirely.
    lastContext = getContext?.() ?? {};
    const heat = Math.min(
      1,
      (lastContext.trialToPaidRate ?? 0) * 2 + (lastContext.inboundPitches >= 3 ? 0.5 : 0),
    );
    const effectiveMax = Math.max(
      1,
      Math.min(maxPerCycle, Math.round(maxPerCycle * (0.4 + 0.4 * heat))),
    );
    const now = Date.now();
    const ordered = [...targets].sort((a, b) => b.score - a.score || a.pitches - b.pitches);
    const batch = ordered
      .filter((t) => !t.nextAttemptAt || Date.parse(t.nextAttemptAt) <= now)
      .slice(0, effectiveMax);
    const pitch = buildPitch(config, selfBaseUrl, getMarketSummary());

    let pitched = 0;
    for (const target of batch) {
      const updated = await probeAndPitch(target, pitch);
      targets = targets.map((t) => (t.url === updated.url ? updated : t));
      if (updated.lastResult === 'pitched') pitched += 1;
    }
    totalPitches += pitched;

    logger.info(
      `Growth cycle ${cycles}: probed ${batch.length}, pitched ${pitched}, pool ${targets.length} ` +
        `(top: ${ordered[0]?.url ?? 'n/a'})`,
    );
    return { cycles, pitched, probed: batch.length, pool: targets.length, effectiveMax };
  }

  /** @type {NodeJS.Timeout|undefined} */
  let timer;

  /**
   * Record a pitch received from a peer (POST /api/outreach). Capped so a
   * rude peer cannot balloon memory; everything else is ignored.
   *
   * @param {object} pitch - Parsed JSON body the peer sent
   * @param {string} [source] - Peer URL or IP for context
   * @returns {boolean} True when accepted into the inbox
   */
  function recordInbound(pitch, source) {
    if (!pitch || typeof pitch !== 'object') return false;
    inbox.unshift({
      type: typeof pitch.type === 'string' ? pitch.type.slice(0, 64) : 'unknown',
      from: typeof pitch.from === 'string' ? pitch.from.slice(0, 200) : source ?? 'unknown',
      service: pitch.service ?? null,
      offer: typeof pitch.offer === 'string' ? pitch.offer.slice(0, 500) : undefined,
      receivedAt: new Date().toISOString(),
    });
    if (inbox.length > 20) inbox.length = 20;
    return true;
  }

  /**
   * Competition radar: what the inbox says about the market.
   *
   * @returns {object} Pitch volume, distinct peers, observed price points
   */
  function getMarketSummary() {
    const prices = [];
    const peers = new Set();
    for (const p of inbox) {
      if (p.from) peers.add(String(p.from).replace(/^https?:\/\//, '').split('/')[0]);
      const matches = typeof p.offer === 'string' ? p.offer.match(/\$\s?([0-9]*\.?[0-9]+)/g) : null;
      if (matches) for (const raw of matches) prices.push(parseFloat(raw.replace(/[$\s]/g, '')));
    }
    return {
      pitches: inbox.length,
      distinctPeers: peers.size,
      pricePoints: prices,
      min: prices.length ? Math.min(...prices) : null,
    };
  }

  /**
   * Competition response: recommend a price from our funnel + the market.
   * Advisory only — flipping PRICE is a deliberate, logged decision.
   *
   * @returns {object} Current, suggested, reason
   */
  function getPricingAdvice() {
    const current = typeof config?.price === 'string' ? config.price : (config?.price?.amount ?? '$0.001');
    const value = parseFloat(String(current).replace(/[^0-9.]/g, '')) || 0.001;
    const market = getMarketSummary();
    const ctx = getContext ? getContext() : lastContext;
    const rate = ctx.trialToPaidRate ?? 0;
    const trials = ctx.freeTrials ?? 0;
    let suggested = value;
    let reason = 'hold — no strong signal yet';
    if (trials >= 20 && rate < 0.1) {
      suggested = Math.max(value / 2, 0.0001);
      reason = 'conversion cold after 20+ trials — halve to find demand';
    } else if (rate >= 0.5) {
      suggested = Math.min(value * 2, 0.01);
      reason = 'conversion hot — double while demand holds';
    } else if (market.min && market.min < value) {
      suggested = market.min;
      reason = 'competitors price below us — match to stay competitive';
    }
    const fmt = (n) => '$' + Number(n.toFixed(6)).toString();
    return { current, suggested: fmt(suggested), reason, market };
  }

  return {
    runCycle,
    recordInbound,
    /**
     * Learning report for /api/growth (token-guarded).
     *
     * @returns {object} Pool state, scores and cycle counters
     */
    getStats: () => ({
      enabled: Boolean(config.growth?.enabled),
      cycles,
      totalPitches,
      intervalMs,
      maxPerCycle,
      context: lastContext,
      market: getMarketSummary(),
      inbox,
      targets: targets.map((t) => ({
        url: t.url,
        kind: t.kind,
        score: Number(t.score.toFixed(2)),
        pitches: t.pitches,
        responses: t.responses,
        lastResult: t.lastResult,
        lastAt: t.lastAt,
      })),
    }),
    getPricingAdvice,
    start: () => {
      if (!config.growth?.enabled) return;
      timer = setInterval(() => {
        runCycle().catch((error) => logger.warn(`Growth cycle failed: ${error.message}`));
      }, intervalMs);
      timer.unref();
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}

