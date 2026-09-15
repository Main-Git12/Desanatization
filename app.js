// ============================================================================
// Express Application Factory
//
// Kept separate from index.js so tests can build the real app (with the real
// x402 middleware) on an ephemeral port without starting a process.
// ============================================================================

import express from 'express';
import { describeConfig } from './config.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { getMetrics, trackPayment, trackPaymentFailure, trackRequests } from './middleware/monitoring.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { securityHeaders } from './middleware/security.js';
import {
  assignRequestId,
  extractPaymentHeader,
  handleBodyParseErrors,
} from './middleware/validation.js';

const STARTED_AT = Date.now();

/**
 * Optional bearer-token guard for the metrics endpoint.
 *
 * @param {object} config - Loaded configuration
 * @returns {(req: object, res: object, next: Function) => void} Middleware
 */
function requireMetricsToken(config) {
  return (req, res, next) => {
    if (!config.metricsToken) return next();
    if (req.headers.authorization === `Bearer ${config.metricsToken}`) return next();
    return res.status(401).json({
      error: 'Metrics are protected. Send Authorization: Bearer <METRICS_TOKEN>.',
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  };
}

/**
 * Build the Express application.
 *
 * @param {object} params - Dependencies
 * @param {object} params.config - Loaded configuration
 * @param {object} params.logger - Logger instance
 * @param {object} params.x402 - x402 bundle from createX402()
 * @returns {{ app: import('express').Express, dispose: () => void }} App + cleanup
 */
export function createApp({ config, logger, x402 }) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  // --- Baseline hardening -------------------------------------------------
  app.use(securityHeaders());
  app.use(createCorsMiddleware(config.allowedOrigins));
  app.use(assignRequestId);
  app.use(express.json({ limit: '64kb' }));
  app.use(handleBodyParseErrors);
  app.use(extractPaymentHeader);
  app.use(trackRequests(logger));

  // --- Revenue & failure telemetry ----------------------------------------
  // Wired onto the real x402 lifecycle so settled payments are observable
  // without querying the chain.
  x402.resourceServer
    .onAfterSettle(async ({ requirements, result }) => {
      trackPayment({
        amount: result?.amount ?? requirements?.amount ?? '0',
        asset: requirements?.asset ?? 'unknown',
        payer: result?.payer,
        network: result?.network ?? requirements?.network,
        transaction: result?.transaction,
      });
    })
    .onSettleFailure(async ({ error }) => {
      trackPaymentFailure(`settle error: ${error?.message ?? 'unknown'}`);
    })
    .onVerifyFailure(async ({ error, result }) => {
      trackPaymentFailure(`verify failed: ${result?.invalidReason ?? error?.message ?? 'unknown'}`);
    });

  // --- Public endpoints ---------------------------------------------------
  app.get('/', (req, res) => {
    res.json({
      service: config.resource.serviceName,
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      description:
        'x402 (v2) payment-gated API. Requests to the paid endpoint without a valid ' +
        'payment receive HTTP 402 with machine-readable payment requirements.',
      payments: {
        protocol: 'x402',
        version: 2,
        scheme: config.scheme,
        network: config.network,
        price: config.price,
        payTo: config.payToAddress,
      },
      endpoints: {
        discovery: 'GET /',
        liveness: 'GET /health',
        readiness: 'GET /ready',
        metrics: 'GET /api/metrics',
        paid: `GET ${config.resource.path}`,
      },
      paywallReady: x402.isReady(),
      config: describeConfig(config),
      timestamp: new Date().toISOString(),
    });
  });

  // Liveness: the process is up. Never fails on downstream dependencies, so a
  // facilitator outage cannot trigger a Railway restart loop.
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      network: config.network,
      paywallReady: x402.isReady(),
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness: can we actually take money right now?
  app.get('/ready', (req, res) => {
    const ready = x402.isReady();
    const error = x402.lastInitializationError();
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not-ready',
      network: config.network,
      facilitator: config.facilitator.url,
      payTo: config.payToAddress,
      reason: ready ? undefined : error?.message ?? 'x402 initialization has not run yet',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/metrics', requireMetricsToken(config), (req, res) => {
    res.json({ ...getMetrics(), paywallReady: x402.isReady(), timestamp: new Date().toISOString() });
  });

// --- Global rate limiting ----------------------------------------------
  // Protects every route, including unpaid 402 scraping. Health checks are
  // skipped so an orchestrator probe can never be throttled.
  const limiter = createRateLimiter({
    windowMs: config.rateLimit.windowMs,
    maxRequests: config.rateLimit.maxRequests,
    skip: (req) => req.path === '/health' || req.path === '/ready',
  });
  app.use(limiter);

  // --- Paid endpoint ------------------------------------------------------
  // NOTE: the x402 middleware must be mounted at the ROOT. Mounting it under
  // `app.use('/api/resource', …)` makes Express strip the prefix from
  // `req.path`, so the SDK's route matcher never fires and every request would
  // be served unpaid. Route decisions are made by the SDK itself.
  const isPaidRequest = (req) =>
    x402.httpServer.requiresPayment({ path: req.path, method: req.method });

  // 503 while the facilitator preflight has never succeeded — retryable, and
  // far more honest than a 500 or a 402 we could never settle.
  const requirePaywallReady = (req, res, next) => {
    if (!isPaidRequest(req)) return next();
    if (x402.isReady()) return next();
    res.setHeader('Retry-After', '30');
    return res.status(503).json({
      error: 'Payment service temporarily unavailable',
      detail: config.isProduction ? undefined : x402.lastInitializationError()?.message,
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  };

  app.use(requirePaywallReady);

  // The x402 middleware is the single authority on payment: on an unpaid
  // request it short-circuits with a 402 challenge, otherwise it verifies,
  // settles, and calls next().
  app.use(x402.middleware);

  app.get(config.resource.path, (req, res) => {
    logger.debug(`Serving paid resource (x402 v${req.x402?.paymentHeaderVersion ?? '?'} client)`);
    res.json({
      success: true,
      message: 'Payment verified! Access granted to protected resource.',
      data: {
        service: config.resource.serviceName,
        content: 'This payload is only returned to clients that paid.',
      },
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  });

  // --- Errors -------------------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not found',
      method: req.method,
      path: req.path,
      hint: 'GET / lists every available endpoint',
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  });

  // Express identifies error handlers by arity: all four parameters are required.
  app.use((error, req, res, _next) => {
    logger.error(`${req.method} ${req.originalUrl} failed: ${error?.stack || error}`);
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  });

  return {
    app,
    dispose: () => {
      limiter.dispose?.();
      x402.stopRetries?.();
    },
  };
}