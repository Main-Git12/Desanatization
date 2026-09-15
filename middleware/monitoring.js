// ============================================================================
// Monitoring & Analytics Middleware
//
// Deliberately dependency-free and in-process: enough to answer "is this
// making money and staying healthy?" from the /metrics endpoint. For long-term
// retention ship these numbers to your observability stack.
// ============================================================================

import { createLogger } from '../logger.js';

const logger = createLogger('monitoring');

/** Rolling retention for latency samples. */
const MAX_SAMPLES = 1000;

const metrics = {
  startedAt: Date.now(),
  totalRequests: 0,
  totalErrors: 0,
  // 402s are the normal, expected unpaid state — they must not be counted as
  // errors or the error rate becomes meaningless.
  paymentRequiredResponses: 0,
  settledPayments: 0,
  failedPayments: 0,
  paymentFailureReasons: {},
  revenueAtomicByAsset: {},
  funnel: {},
  requestTimes: [],
};

/**
 * Human-readable status buckets, used for the /metrics breakdown.
 */
const STATUS_FAMILY = { '2': 'success', '4': 'clientError', '5': 'serverError' };

/**
 * Request tracking middleware. Records latency, status families and request
 * IDs, and logs slow or failed requests.
 *
 * @param {object} loggerInstance - Logger (defaults to the monitoring logger)
 * @returns {(req: object, res: object, next: Function) => void} Middleware
 */
export function trackRequests(loggerInstance = logger) {
  return (req, res, next) => {
    const startTime = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
      const statusCode = res.statusCode;
      const family = STATUS_FAMILY[String(statusCode).charAt(0)];

      metrics.totalRequests++;

      if (statusCode === 402) {
        metrics.paymentRequiredResponses++;

        // A 402 that arrived WITH a payment header means a buyer tried to pay
        // and was rejected — the only reliable place to observe that, because
        // the x402 verify hook fires on errors, not on declined payments.
        if (req.x402?.paymentHeader) {
          metrics.failedPayments++;
        }
      } else if (statusCode >= 400) {
        metrics.totalErrors++;
      }

      metrics.requestTimes.push(durationMs);
      if (metrics.requestTimes.length > MAX_SAMPLES) {
        metrics.requestTimes.shift();
      }

      if (durationMs > 5000) {
        loggerInstance.warn(
          `Slow request: ${req.method} ${req.originalUrl} took ${durationMs.toFixed(0)}ms (${statusCode})`,
        );
      }

      if (statusCode >= 500) {
        loggerInstance.error(`${req.method} ${req.originalUrl} -> ${statusCode} in ${durationMs.toFixed(0)}ms`);
      } else if (family) {
        loggerInstance.debug(`${req.method} ${req.originalUrl} -> ${statusCode} in ${durationMs.toFixed(0)}ms`);
      }
    });

    next();
  };
}

/**
 * Record a settled payment. Called from the x402 after-settle path so revenue
 * is observable without querying the chain.
 *
 * @param {object} payment - Payment details
 * @param {string} payment.amount - Atomic amount received
 * @param {string} [payment.asset] - Token contract address
 * @param {string} [payment.payer] - Paying address
 * @param {string} [payment.network] - Network the payment settled on
 * @param {string} [payment.transaction] - Settlement transaction hash
 * @returns {void}
 */
export function trackPayment({ amount, asset = 'unknown', payer, network, transaction } = {}) {
  metrics.settledPayments++;
  const key = `${asset}`;
  metrics.revenueAtomicByAsset[key] = String(BigInt(metrics.revenueAtomicByAsset[key] || '0') + BigInt(amount || '0'));
  logger.info(
    `Payment settled: ${amount} of ${asset} on ${network || 'unknown'} from ${payer || 'unknown'} (tx ${transaction || 'n/a'})`,
  );
}

/**
 * Record why a payment failed. Feeds the reason breakdown only —
 * `failedPayments` itself is counted once, from the HTTP 402 response, so a
 * payment is never double counted when both signals fire.
 *
 * @param {string} reason - Why the payment failed
 * @returns {void}
 */
export function trackPaymentFailure(reason) {
  const key = String(reason || 'unknown').slice(0, 120);
  metrics.paymentFailureReasons[key] = (metrics.paymentFailureReasons[key] || 0) + 1;
  logger.warn(`Payment failure: ${key}`);
}

/**
 * Track a conversion-funnel event (free trial use, upsell view, paid call…).
 * Backed by the same counters object so /metrics and /api/insights agree.
 *
 * @param {string} event - Event name (e.g. 'freeTrial', 'paidCall')
 * @returns {void}
 */
export function trackFunnel(event) {
  const key = String(event || 'unknown').slice(0, 60);
  metrics.funnel[key] = (metrics.funnel[key] || 0) + 1;
}

/**
 * Snapshot of buyer-behaviour signals for the growth loop.
 *
 * @returns {object} Funnel + revenue signals
 */
export function getInsights() {
  const funnel = { ...metrics.funnel };
  const freeTrial = funnel.freeTrial || 0;
  const paidCalls = metrics.settledPayments;
  return {
    funnel,
    conversion: {
      freeTrials: freeTrial,
      paidCalls,
      // Paid calls per free trial — the single number pricing experiments move.
      trialToPaidRate: freeTrial ? Number((paidCalls / freeTrial).toFixed(4)) : 0,
    },
    demand: {
      unpaidChallenges: metrics.paymentRequiredResponses,
      failedPayments: metrics.failedPayments,
      failureReasons: { ...metrics.paymentFailureReasons },
    },
    revenueAtomicByAsset: { ...metrics.revenueAtomicByAsset },
  };
}
/**
 * Snapshot current metrics.
 *
 * @returns {object} Metrics snapshot
 */
export function getMetrics() {
  const uptimeSeconds = Math.max(1, Math.floor((Date.now() - metrics.startedAt) / 1000));
  const samples = metrics.requestTimes;
  const averageMs = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  const sorted = [...samples].sort((a, b) => a - b);

  return {
    uptimeSeconds,
    totalRequests: metrics.totalRequests,
    totalErrors: metrics.totalErrors,
    paymentRequiredResponses: metrics.paymentRequiredResponses,
    settledPayments: metrics.settledPayments,
    failedPayments: metrics.failedPayments,
    paymentFailureReasons: { ...metrics.paymentFailureReasons },
    revenueAtomicByAsset: { ...metrics.revenueAtomicByAsset },
    funnel: { ...metrics.funnel },
    requestsPerMinute: Number(((metrics.totalRequests / uptimeSeconds) * 60).toFixed(2)),
    errorRatePercent: metrics.totalRequests
      ? Number(((metrics.totalErrors / metrics.totalRequests) * 100).toFixed(2))
      : 0,
    latencyMs: {
      average: Number(averageMs.toFixed(2)),
      p50: sorted.length ? Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(2)) : 0,
      p95: sorted.length ? Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)) : 0,
      samples: sorted.length,
    },
  };
}

/**
 * Reset all counters. Primarily used by tests.
 *
 * @returns {void}
 */
export function resetMetrics() {
  metrics.startedAt = Date.now();
  metrics.totalRequests = 0;
  metrics.totalErrors = 0;
  metrics.paymentRequiredResponses = 0;
  metrics.settledPayments = 0;
  metrics.failedPayments = 0;
  metrics.paymentFailureReasons = {};
  metrics.revenueAtomicByAsset = {};
  metrics.funnel = {};
  metrics.requestTimes = [];
}