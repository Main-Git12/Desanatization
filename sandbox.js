// ============================================================================
// Sandbox & Backtesting Framework for A2A Agent Optimization
//
// A lightweight simulation environment that models the production growth engine's
// probe-pitch-learn loop against synthetic peers with tunable responsiveness
// rates. No network calls are made — the entire cycle is simulated in-process,
// so strategies can be compared quickly and reproducibly.
// ============================================================================

/**
 * Synthetic peer profile for sandbox simulations.
 *
 * @typedef {object} SandboxPeer
 * @property {string} url - Peer base URL
 * @property {string} kind - Channel label (bazaar, framework, provider, etc.)
 * @property {number} responsiveness - Probability this peer responds to a pitch (0-1)
 * @property {number} revenuePotential - Expected revenue per successful conversion (USD)
 * @property {number} latencyMs - Simulated round-trip latency in milliseconds
 */

/**
 * Default synthetic market: 40 peers across 5 channel types.
 * Calibration targets: the real CDP Bazaar has ~200 services; we simulate a
 * representative slice with tunable parameters per channel type.
 */
const DEFAULT_PEERS = [
  ...Array.from({ length: 12 }, (_, i) => ({ url: `https://a2a-market-${i}.com`, kind: 'bazaar', responsiveness: 0.18, revenuePotential: 0.002, latencyMs: 300 })),
  ...Array.from({ length: 8 }, (_, i) => ({ url: `https://ai-agent-${i}.com`, kind: 'agent-network', responsiveness: 0.14, revenuePotential: 0.003, latencyMs: 500 })),
  ...Array.from({ length: 6 }, (_, i) => ({ url: `https://crypto-${i}.com`, kind: 'crypto', responsiveness: 0.09, revenuePotential: 0.005, latencyMs: 800 })),
  ...Array.from({ length: 8 }, (_, i) => ({ url: `https://dev-hub-${i}.com`, kind: 'developer-hub', responsiveness: 0.22, revenuePotential: 0.001, latencyMs: 200 })),
  ...Array.from({ length: 6 }, (_, i) => ({ url: `https://api-market-${i}.com`, kind: 'api-marketplace', responsiveness: 0.16, revenuePotential: 0.004, latencyMs: 400 })),
];

/**
 * Deterministic PRNG so backtests are reproducible across runs.
 * Mulberry32: fast, seedable, no dependencies.
 */
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Compute a hash from a string seed for reproducible PRNG initialization.
 */
function stringToSeed(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/**
 * Simulate a probe+pitch to a single peer.
 * Models the production probeAndPitch() behavior: each peer is probed, and
 * if it responds (based on its responsiveness rate) and has an outreach
 * surface, the pitch is accepted.
 *
 * @param {SandboxPeer} peer - The peer to pitch
 * @param {function(): number} rng - Random number generator
 * @returns {{ responded: boolean, pitched: boolean, latency: number, revenue: number, learned: boolean }}
 */
function simulateProbeAndPitch(peer, rng) {
  const probeLatency = peer.latencyMs + rng() * 100;
  const responded = rng() < peer.responsiveness;
  const pitched = responded && rng() < 0.7; // 70% of responsive peers accept a pitch
  const revenue = pitched ? peer.revenuePotential * (0.8 + rng() * 0.4) : 0;

  // Learning: pitched peers get a score boost, non-responsive peers decay.
  const learned = pitched;
  return { responded, pitched, latency: probeLatency, revenue, learned };
}

/**
 * Run a backtest simulation: replay a strategy against synthetic peers.
 *
 * The simulation models the growth engine's behavior:
 * - Selects up to maxPerCycle peers per cycle (highest-scoring first)
 * - Probes and pitches each (using responsiveness rates)
 * - Learns: pitched peers are boosted, dead peers are deprioritized
 * - Context adaptation: hot conversion widens the cycle
 *
 * @param {object} options - Backtest configuration
 * @param {string} options.strategyName - Human-readable strategy label
 * @param {object} options.params - Strategy parameters { maxPerCycle, intervalMs, targetConversion }
 * @param {SandboxPeer[]} [options.peers] - Synthetic peer set
 * @param {string} [options.seedQuery] - Seed for RNG reproducibility
 * @param {number} [options.cycles] - Number of cycles to simulate
 * @returns {Promise<object>} Backtest results
 */
export async function backtestStrategy({ strategyName, params, peers = DEFAULT_PEERS, seedQuery = 'default', cycles = 100 }) {
  const seed = stringToSeed(seedQuery + strategyName);
  const rng = mulberry32(seed);

  const maxPerCycle = params.maxPerCycle ?? 5;
  const targetConversion = params.targetConversion ?? 0.15;
  const intervalMs = params.intervalMs ?? 120_000;

  // Clone peers into target objects with learnable scores
  /** @type {Array<SandboxPeer & {score: number, pitches: number, responses: number, failures: number}>} */
  const pool = peers.map((p) => ({ ...p, score: 1, pitches: 0, responses: 0, failures: 0 }));

  let totalRevenue = 0;
  let totalPitches = 0;
  let totalResponses = 0;
  let totalLatency = 0;
  let totalProbes = 0;
  let cyclesCompleted = 0;
  const cycleResults = [];

  for (let i = 0; i < cycles; i++) {
    cyclesCompleted += 1;

    // CONTEXT ADAPTATION: if recent conversion is high, widen the cycle.
    const recentConversion = totalPitches > 0 ? totalResponses / totalPitches : 0;
    const heat = Math.min(1, recentConversion * 3 + (totalPitches > 0 ? 0.3 : 0));
    const effectiveMax = Math.max(
      2,
      Math.min(maxPerCycle, Math.round(maxPerCycle * (0.4 + 0.4 * heat))),
    );

    // Order by score (high first), then by fewest prior pitches (explore low-score new peers)
    const ordered = [...pool].sort((a, b) => b.score - a.score || a.pitches - b.pitches);
    const batch = ordered.slice(0, effectiveMax);
    totalProbes += batch.length;

    let cycleRevenue = 0;
    let cycleResponses = 0;
    let cycleLatency = 0;

    for (const target of batch) {
      const result = simulateProbeAndPitch(target, rng);
      target.pitches += 1;
      target.responses += result.responded ? 1 : 0;

      if (result.pitched) {
        cycleResponses += 1;
        cycleRevenue += result.revenue;
        target.score += 2; // Boost successful peers
        target.failures = 0;
      } else {
        // Decay: unresponsive or unreachable peers get lower priority
        target.score = Math.max(0, target.score - 0.3);
        target.failures += 1;
      }
      cycleLatency += result.latency;
    }

    totalPitches += batch.length;
    totalResponses += cycleResponses;
    totalRevenue += cycleRevenue;
    totalLatency += cycleLatency;

    cycleResults.push({
      cycle: i + 1,
      probes: batch.length,
      responses: cycleResponses,
      revenue: cycleRevenue,
      latency: cycleLatency,
      conversion: batch.length > 0 ? cycleResponses / batch.length : 0,
    });
  }

  return {
    strategyName,
    params,
    cycles: cyclesCompleted,
    totalRevenue: Math.round(totalRevenue * 1e6) / 1e6,
    totalPitches,
    totalProbes,
    totalResponses,
    conversionRate: totalPitches > 0 ? totalResponses / totalPitches : 0,
    avgRevenuePerCycle: totalRevenue / Math.max(1, cyclesCompleted),
    avgPitchesPerCycle: totalPitches / Math.max(1, cyclesCompleted),
    avgLatencyPerPitch: totalLatency / Math.max(1, totalProbes),
    efficiency: totalRevenue / Math.max(1, totalLatency),
    cycleResults: cycleResults.slice(-20),
  };
}

/**
 * Run multiple strategies and rank them by efficiency.
 *
 * @param {Array<object>} strategies - Strategy configs to compare
 * @returns {Promise<Array<object>>} Ranked results (best first)
 */
export async function backtestMultiple(strategies) {
  const results = [];
  for (const strategy of strategies) {
    const result = await backtestStrategy(strategy);
    results.push(result);
  }
  return results.sort((a, b) => b.efficiency - a.efficiency);
}

/**
 * Predefined strategy templates for common A2A commerce scenarios.
 */
export const STRATEGY_TEMPLATES = {
  aggressive: { maxPerCycle: 15, intervalMs: 60_000, targetConversion: 0.2, seedQuery: 'aggressive' },
  conservative: { maxPerCycle: 3, intervalMs: 180_000, targetConversion: 0.15, seedQuery: 'conservative' },
  balanced: { maxPerCycle: 8, intervalMs: 120_000, targetConversion: 0.18, seedQuery: 'balanced' },
  saturation: { maxPerCycle: 25, intervalMs: 30_000, targetConversion: 0.1, seedQuery: 'saturation' },
  discovery: { maxPerCycle: 5, intervalMs: 300_000, targetConversion: 0.12, seedQuery: 'discovery' },
  highValue: { maxPerCycle: 5, intervalMs: 120_000, targetConversion: 0.25, seedQuery: 'highValue' },
};

export { DEFAULT_PEERS };
