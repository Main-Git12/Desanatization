// ============================================================================
// Rate Limiting Middleware
//
// In-memory fixed-window limiter. Sized for a single Railway instance; swap the
// store for Redis if you ever scale horizontally.
// ============================================================================

import { createLogger } from '../logger.js';

const logger = createLogger('rate-limiter');

const defaultConfig = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 60,
  keyGenerator: (req) => req.ip,
  skip: () => false,
  // Upper bound on tracked keys. Prevents unbounded memory growth when the
  // endpoint is hit by many distinct IPs (e.g. a botnet).
  maxTrackedKeys: 10_000,
};

/**
 * Create a fixed-window rate limiter.
 *
 * @param {object} [config] - Overrides for the defaults above
 * @returns {(req: object, res: object, next: Function) => void} Middleware
 */
export function createRateLimiter(config = {}) {
  const settings = { ...defaultConfig, ...config };
  const store = new Map();

  // Cleanup expired entries. `unref()` keeps this timer from holding the
  // process open on shutdown.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, data] of store.entries()) {
      if (now - data.resetTime >= settings.windowMs) {
        store.delete(key);
      }
    }
  }, Math.max(settings.windowMs, 1000));
  cleanup.unref?.();

  const handler = (req, res, next) => {
    if (settings.skip(req)) {
      return next();
    }

    const key = settings.keyGenerator(req);
    const now = Date.now();
    let record = store.get(key);

    if (!record || now - record.resetTime >= settings.windowMs) {
      if (store.size >= settings.maxTrackedKeys && !store.has(key)) {
        // Evict the oldest window rather than growing without bound.
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
      }
      record = { count: 0, resetTime: now };
      store.set(key, record);
    }

    record.count++;
    res.setHeader('X-RateLimit-Limit', settings.maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, settings.maxRequests - record.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil((record.resetTime + settings.windowMs) / 1000));

    if (record.count > settings.maxRequests) {
      const retryAfter = Math.ceil((record.resetTime + settings.windowMs - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      logger.warn(`Rate limit exceeded for ${key} on ${req.method} ${req.path}`);
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter,
        limit: settings.maxRequests,
        windowMs: settings.windowMs,
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    }

    next();
  };

  /** Release the cleanup timer (used by tests and graceful shutdown). */
  handler.dispose = () => clearInterval(cleanup);

  return handler;
}

/**
 * Limiter intended for the payment-gated routes.
 *
 * Deep enough that a paying agent is never throttled mid-purchase, tight
 * enough to stop unpaid 402-scraping from being free.
 *
 * @param {object} [overrides] - Optional overrides
 * @returns {(req: object, res: object, next: Function) => void} Middleware
 */
export function createPaymentRateLimiter(overrides = {}) {
  return createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 120,
    ...overrides,
  });
}

/**
 * Stop the cleanup timer. Exposed for tests and graceful shutdown.
 *
 * @param {Function} middleware - Middleware returned by createRateLimiter
 * @returns {void}
 */
export function disposeRateLimiter(middleware) {
  middleware?.dispose?.();
}