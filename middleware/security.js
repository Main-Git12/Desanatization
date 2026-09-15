// ============================================================================
// Security Headers Middleware
// Framework-free equivalent of the handful of helmet defaults that matter for
// a JSON payment API. No HTML is ever served, so CSP is locked down hard.
// ============================================================================

/**
 * Build the security headers middleware.
 *
 * @returns {(req: object, res: object, next: Function) => void} Middleware
 */
export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  };
}
