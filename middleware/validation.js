// ============================================================================
// Request Validation & Correlation Middleware
//
// NOTE ON x402 v1 vs v2: x402 v2 clients send the payment proof in the
// `PAYMENT-SIGNATURE` header (the `X-PAYMENT` header from v1 is still accepted
// for backward compatibility). The old `Authorization: Bearer <proof>` scheme
// this file previously enforced was x402 v1 folklore and would have rejected
// every v2 payment, so it is gone.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';

const logger = createLogger('validation-middleware');

/** Request header carrying a v2 payment payload. */
export const PAYMENT_SIGNATURE_HEADER = 'payment-signature';

/** Legacy (v1) request header carrying a payment payload. */
export const LEGACY_PAYMENT_HEADER = 'x-payment';

/**
 * Assign a unique, unguessable request ID for correlation.
 *
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {Function} next - Next middleware
 * @returns {void}
 */
export function assignRequestId(req, res, next) {
  // Honour an inbound correlation ID from an upstream proxy, otherwise mint one.
  const inbound = String(req.headers['x-request-id'] || '').slice(0, 128);
  req.id = /^[\w.:-]{8,128}$/.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

/**
 * Read the x402 payment payload from either the v2 or the legacy v1 header.
 *
 * This is informational only — it never rejects a request. The x402 middleware
 * is the single authority on whether a payment is present and valid; this
 * helper exists so logs and handlers can see which header arrived and how big
 * the payload was.
 *
 * @param {object} req - Express request
 * @param {object} _res - Express response (unused)
 * @param {Function} next - Next middleware
 * @returns {void}
 */
export function extractPaymentHeader(req, _res, next) {
  const v2 = req.headers[PAYMENT_SIGNATURE_HEADER];
  const v1 = req.headers[LEGACY_PAYMENT_HEADER];
  const header = v2 || v1;

  if (header) {
    req.x402 = {
      ...(req.x402 || {}),
      paymentHeader: header,
      paymentHeaderVersion: v2 ? 2 : 1,
      paymentHeaderBytes: header.length,
    };
    logger.debug(`Payment header present (x402 v${v2 ? 2 : 1}, ${header.length} bytes) for ${req.method} ${req.path}`);
  }

  next();
}

/**
 * Require a JSON content type on write methods.
 *
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {Function} next - Next middleware
 * @returns {void}
 */
export function validateContentType(req, res, next) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      logger.debug(`Invalid content type: ${contentType || '(none)'}`);
      return res.status(400).json({
        error: 'Content-Type must be application/json',
        received: contentType || 'none',
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    }
  }
  next();
}

/**
 * Reject requests carrying query parameters outside an allowlist.
 *
 * @param {string[]} allowedParams - Permitted query parameter names
 * @returns {(req: object, res: object, next: Function) => void} Middleware
 */
export function validateQueryParams(allowedParams) {
  return (req, res, next) => {
    const invalidParams = Object.keys(req.query).filter((key) => !allowedParams.includes(key));

    if (invalidParams.length > 0) {
      logger.debug(`Invalid query parameters: ${invalidParams.join(', ')}`);
      return res.status(400).json({
        error: 'Invalid query parameters',
        invalid: invalidParams,
        allowed: allowedParams,
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    }
    next();
  };
}

/**
 * Express 4 error handler for malformed JSON bodies.
 *
 * @param {Error} error - The thrown error
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {Function} next - Next middleware
 * @returns {void}
 */
export function handleBodyParseErrors(error, req, res, next) {
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Malformed JSON body',
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request body too large',
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  }
  return next(error);
}