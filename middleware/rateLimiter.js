// ============================================================================
// Rate Limiting Middleware
// Prevents abuse and ensures fair service distribution
// ============================================================================

import { createLogger } from '../logger.js';

const logger = createLogger('rate-limiter');

const defaultConfig = {
  windowMs: 15 * 60 * 1000,      // 15 minutes
  maxRequests: 100,               // 100 requests per window
  keyGenerator: (req) => req.ip,  // Use IP as key
  skip: (req) => false,           // Don't skip any requests
};

/**
 * Simple in-memory rate limiter
 * For production, consider Redis for distributed rate limiting
 */
export function createRateLimiter(config = {}) {
  const settings = { ...defaultConfig, ...config };
  const store = new Map();

  // Cleanup old entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of store.entries()) {
      if (now - data.resetTime > settings.windowMs) {
        store.delete(key);
      }
    }
  }, settings.windowMs);

  return (req, res, next) => {
    if (settings.skip(req)) {
      return next();
    }

    const key = settings.keyGenerator(req);
    const now = Date.now();
    let record = store.get(key);

    // Initialize or reset record if window expired
    if (!record || now - record.resetTime > settings.windowMs) {
      record = {
        count: 0,
        resetTime: now,
      };
      store.set(key, record);
    }

    record.count++;

    // Set rate limit headers
    const remainingRequests = Math.max(0, settings.maxRequests - record.count);
    const resetTime = Math.ceil((record.resetTime + settings.windowMs - now) / 1000);

    res.setHeader('X-RateLimit-Limit', settings.maxRequests);
    res.setHeader('X-RateLimit-Remaining', remainingRequests);
    res.setHeader('X-RateLimit-Reset', Math.floor((record.resetTime + settings.windowMs) / 1000));

    if (record.count > settings.maxRequests) {
      logger.warn(`Rate limit exceeded for ${key}`);
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: resetTime,
        message: `Maximum ${settings.maxRequests} requests per ${settings.windowMs / 1000 / 60} minutes`,
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    }

    next();
  };
}

/**
 * Stricter rate limiter for payment endpoints
 */
export function createPaymentRateLimiter() {
  return createRateLimiter({
    windowMs: 60 * 1000,           // 1 minute
    maxRequests: 10,               // 10 requests per minute
    keyGenerator: (req) => req.ip,
  });
}

/**
 * Per-user rate limiter (requires authentication)
 */
export function createPerUserRateLimiter() {
  return createRateLimiter({
    windowMs: 60 * 60 * 1000,      // 1 hour
    maxRequests: 1000,             // 1000 requests per hour
    keyGenerator: (req) => req.user?.id || req.ip,
  });
}
