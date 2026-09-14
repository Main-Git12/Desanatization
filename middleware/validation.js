// ============================================================================
// Request Validation Middleware
// Validates incoming requests for payment parameters
// ============================================================================

import { createLogger } from '../logger.js';

const logger = createLogger('validation-middleware');

/**
 * Validates payment proof header
 * Ensures required payment information is present
 */
export function validatePaymentHeaders(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    logger.debug('Missing authorization header');
    return res.status(401).json({
      error: 'Missing authorization header',
      requestId: req.id,
      timestamp: new Date().toISOString()
    });
  }

  // Extract bearer token
  const [scheme, token] = authHeader.split(' ');
  
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    logger.debug('Invalid authorization header format');
    return res.status(401).json({
      error: 'Invalid authorization header format. Expected: Bearer <token>',
      requestId: req.id,
      timestamp: new Date().toISOString()
    });
  }

  // Attach token to request for use in routes
  req.paymentProof = token;
  next();
}

/**
 * Validates request content type
 */
export function validateContentType(req, res, next) {
  if (req.method === 'POST' || req.method === 'PUT') {
    const contentType = req.headers['content-type'];
    
    if (!contentType || !contentType.includes('application/json')) {
      logger.debug(`Invalid content type: ${contentType}`);
      return res.status(400).json({
        error: 'Content-Type must be application/json',
        received: contentType || 'none',
        requestId: req.id,
        timestamp: new Date().toISOString()
      });
    }
  }
  next();
}

/**
 * Assigns unique request ID for tracking
 */
export function assignRequestId(req, res, next) {
  req.id = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  next();
}

/**
 * Validates query parameters
 */
export function validateQueryParams(allowedParams) {
  return (req, res, next) => {
    const queryKeys = Object.keys(req.query);
    const invalidParams = queryKeys.filter(key => !allowedParams.includes(key));
    
    if (invalidParams.length > 0) {
      logger.debug(`Invalid query parameters: ${invalidParams.join(', ')}`);
      return res.status(400).json({
        error: 'Invalid query parameters',
        invalid: invalidParams,
        allowed: allowedParams,
        requestId: req.id,
        timestamp: new Date().toISOString()
      });
    }
    next();
  };
}
