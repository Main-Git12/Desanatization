// ============================================================================
// Monitoring & Analytics Middleware
// Tracks request metrics and payment events
// ============================================================================

import { createLogger } from '../logger.js';

const logger = createLogger('monitoring');

const metrics = {
  totalRequests: 0,
  totalErrors: 0,
  totalPayments: 0,
  averageResponseTime: 0,
  requestTimes: [],
  lastReset: Date.now(),
};

/**
 * Request tracking middleware
 */
export function trackRequests(req, res, next) {
  const startTime = Date.now();

  // Track response completion
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    metrics.totalRequests++;
    metrics.requestTimes.push(duration);

    // Keep only last 1000 request times for average calculation
    if (metrics.requestTimes.length > 1000) {
      metrics.requestTimes.shift();
    }

    // Update average response time
    metrics.averageResponseTime =
      metrics.requestTimes.reduce((a, b) => a + b, 0) / metrics.requestTimes.length;

    if (statusCode >= 400) {
      metrics.totalErrors++;
    }

    // Log slow requests
    if (duration > 5000) {
      logger.warn(
        `Slow request: ${req.method} ${req.path} took ${duration}ms (${statusCode})`
      );
    }

    // Log all requests in debug mode
    if (process.env.LOG_LEVEL === 'debug') {
      logger.debug(
        `${req.method} ${req.path} - ${statusCode} - ${duration}ms`
      );
    }
  });

  next();
}

/**
 * Track payment events
 */
export function trackPayment(paymentInfo) {
  metrics.totalPayments++;
  logger.info(
    `Payment processed: ${paymentInfo.amount} ${paymentInfo.currency} from ${paymentInfo.from}`
  );
}

/**
 * Get current metrics
 */
export function getMetrics() {
  return {
    ...metrics,
    uptime: Math.floor((Date.now() - metrics.lastReset) / 1000),
    requestsPerMinute: Math.round(
      (metrics.totalRequests / (Date.now() - metrics.lastReset)) * 60 * 1000
    ),
    errorRate: metrics.totalRequests
      ? (metrics.totalErrors / metrics.totalRequests * 100).toFixed(2) + '%'
      : '0%',
  };
}

/**
 * Reset metrics
 */
export function resetMetrics() {
  metrics.totalRequests = 0;
  metrics.totalErrors = 0;
  metrics.totalPayments = 0;
  metrics.requestTimes = [];
  metrics.lastReset = Date.now();
}

/**
 * Metrics endpoint
 */
export function metricsEndpoint(req, res) {
  res.json(getMetrics());
}
