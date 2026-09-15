// ============================================================================
// CORS Middleware
//
// Hand-rolled so the project keeps a minimal dependency surface. Critically,
// it exposes the x402 protocol headers (PAYMENT-REQUIRED / PAYMENT-RESPONSE)
// to browsers and allows the PAYMENT-SIGNATURE request header — without this
// a browser-based agent can never read the challenge or send a payment.
// ============================================================================

/**
 * Headers a browser client is allowed to send.
 */
const ALLOWED_REQUEST_HEADERS = [
  'Content-Type',
  'Accept',
  'Authorization',
  'PAYMENT-SIGNATURE',
  'X-PAYMENT',
].join(', ');

/**
 * Headers a browser client is allowed to read from our responses.
 */
const EXPOSED_RESPONSE_HEADERS = [
  'PAYMENT-REQUIRED',
  'PAYMENT-RESPONSE',
  'X-PAYMENT-RESPONSE',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'X-Request-Id',
].join(', ');

/**
 * Build the CORS middleware.
 *
 * @param {string[]} allowedOrigins - Configured origins; `*` allows any origin
 * @returns {(req: object, res: object, next: Function) => void} Middleware
 */
export function createCorsMiddleware(allowedOrigins = []) {
  const allowAll = allowedOrigins.includes('*');
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.headers.origin;

    if (origin && (allowAll || allowed.has(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', EXPOSED_RESPONSE_HEADERS);
    }

    if (req.method === 'OPTIONS') {
      // Preflight: answer even when the origin is not allowed, but without
      // the allow headers, so the browser blocks it cleanly.
      if (!origin || allowAll || allowed.has(origin)) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
        res.setHeader('Access-Control-Max-Age', '86400');
      }
      res.status(204).end();
      return;
    }

    next();
  };
}