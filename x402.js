// ============================================================================
// x402 Payment Wiring (protocol v2)
//
// Correctly assembles the three pieces the SDK requires:
//   1. a facilitator client   -> verifies + settles payments on-chain
//   2. a resource server      -> holds the registered scheme per network
//   3. route payment options  -> what the buyer is told to pay in the 402
//
// Getting any of these wrong means payments can never settle, so this module
// is deliberately explicit and verified at startup.
// ============================================================================

import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { createCdpAuthHeaders } from './cdp-auth.js';

/**
 * Build a facilitator HTTP client, adding auth headers when configured.
 *
 * @param {object} config - Loaded application configuration
 * @returns {HTTPFacilitatorClient} Configured facilitator client
 */
export function createFacilitatorClient(config) {
  /** @type {import('@x402/core/server').FacilitatorConfig} */
  const options = {
    url: config.facilitator.url,
    timeoutMs: config.facilitator.timeoutMs,
  };

  if (config.facilitator.cdp?.keyId && config.facilitator.cdp?.keySecret) {
    // Coinbase CDP: a fresh JWT per call, signed and bound to method+host+path.
    // Static headers are rejected here — config validation forbids both.
    options.createAuthHeaders = createCdpAuthHeaders({
      keyId: config.facilitator.cdp.keyId,
      keySecret: config.facilitator.cdp.keySecret,
      baseUrl: config.facilitator.url,
    });
  } else if (config.facilitator.authHeaders) {
    // Some facilitators (e.g. Coinbase CDP) require named API headers rather
    // than a Bearer token — pass the configured map verbatim.
    const headers = { ...config.facilitator.authHeaders };
    options.createAuthHeaders = async () => ({
      verify: headers,
      settle: headers,
      supported: headers,
      bazaar: headers,
    });
  } else if (config.facilitator.authHeader) {
    // The SDK requires headers keyed by request path, not a flat header object.
    const headers = { Authorization: config.facilitator.authHeader };
    options.createAuthHeaders = async () => ({
      verify: headers,
      settle: headers,
      supported: headers,
      bazaar: headers,
    });
  }

  return new HTTPFacilitatorClient(options);
}

/**
 * Build the route payment options advertised in the 402 challenge.
 *
 * @param {object} config - Loaded application configuration
 * @returns {Record<string, object>} Routes config for the x402 middleware
 */
/**
 * Build the route payment options advertised in the 402 challenge.
 *
 * The protocol surface is the `PAYMENT-REQUIRED` header. The route's
 * `unpaidResponseBody` mirrors the same requirements into the JSON body so a
 * client that is not yet x402-aware still receives actionable instructions.
 *
 * @param {object} config - Loaded application configuration
 * @param {object} scheme - Registered server scheme, used to resolve the price
 * @returns {Record<string, object>} Routes config for the x402 middleware
 */
export function buildRoutes(config, scheme) {
  const accepts = [
    {
      scheme: config.scheme,
      price: config.price,
      network: config.network,
      payTo: config.payToAddress,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
    },
  ];

  // "$0.001" resolves against the scheme's local default-asset table (USDC per
  // network) — no facilitator round trip, so this is safe and memoized.
  let resolvedPrice = null;
  const resolvePrice = async () => {
    if (resolvedPrice === null) {
      try {
        resolvedPrice = await scheme.parsePrice(config.price, config.network);
      } catch {
        resolvedPrice = undefined;
      }
    }
    return resolvedPrice;
  };

  const discoverablePost = declareDiscoveryExtension({
    discoverable: true,
    method: 'POST',
    bodyType: 'json',
    description:
      'Sanitize dirty text: redacts emails, phones, SSNs, card numbers and secrets. ' +
      'POST { "text": "..." } for full jobs (paid).',
    input: { text: 'Contact me at jane@example.com' },
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to sanitize' },
      },
      required: ['text'],
    },
    output: {
      example: {
        success: true,
        clean: 'Contact me at [redacted-email]',
        redactions: { emails: 1, phones: 0, ssns: 0, cards: 0, secrets: 0, urlTokens: 0 },
        inputChars: 27,
        outputChars: 27,
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: '2026-09-16T07:17:00.000Z',
      },
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          clean: { type: 'string', description: 'Sanitized text' },
          redactions: {
            type: 'object',
            properties: {
              emails: { type: 'integer' },
              phones: { type: 'integer' },
              ssns: { type: 'integer' },
              cards: { type: 'integer' },
              secrets: { type: 'integer' },
              urlTokens: { type: 'integer' },
            },
            description: 'Counts per redaction class',
          },
          inputChars: { type: 'integer' },
          outputChars: { type: 'integer' },
          requestId: { type: 'string' },
          timestamp: { type: 'string' },
        },
        required: ['success', 'clean', 'redactions'],
      },
    },
  });

  const discoverableGet = declareDiscoveryExtension({
    discoverable: true,
    method: 'GET',
    description:
      'Sanitize dirty text: redacts emails, phones, SSNs, card numbers and secrets. ' +
      'GET with ?text= for short trials.',
    input: { text: 'Contact me at jane@example.com' },
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to sanitize' },
      },
    },
    output: {
      example: {
        success: true,
        clean: 'Contact me at [redacted-email]',
        redactions: { emails: 1, phones: 0, ssns: 0, cards: 0, secrets: 0, urlTokens: 0 },
        inputChars: 27,
        outputChars: 27,
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: '2026-09-16T07:17:00.000Z',
      },
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          clean: { type: 'string', description: 'Sanitized text' },
          redactions: {
            type: 'object',
            properties: {
              emails: { type: 'integer' },
              phones: { type: 'integer' },
              ssns: { type: 'integer' },
              cards: { type: 'integer' },
              secrets: { type: 'integer' },
              urlTokens: { type: 'integer' },
            },
            description: 'Counts per redaction class',
          },
          inputChars: { type: 'integer' },
          outputChars: { type: 'integer' },
          requestId: { type: 'string' },
          timestamp: { type: 'string' },
        },
        required: ['success', 'clean', 'redactions'],
      },
    },
  });

  // Batch: up to 10 texts for ONE settlement. Fewer payment round-trips per
  // job is a genuine buyer preference — bulk agents pick us for it, and each
  // settlement is still full revenue.
  const discoverableBatch = declareDiscoveryExtension({
    discoverable: true,
    method: 'POST',
    bodyType: 'json',
    description:
      'Sanitize up to 10 texts in one payment: redacts emails, phones, SSNs, card numbers and secrets. ' +
      'POST { "items": ["...", "..."] } (1-10 texts, one settlement).',
    input: { items: ['Contact me at jane@example.com', 'Call 415-555-1234'] },
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 10,
          description: 'Up to 10 texts, sanitized in one paid call',
        },
      },
      required: ['items'],
    },
    output: {
      example: {
        success: true,
        count: 2,
        results: [
          {
            clean: 'Contact me at [redacted-email]',
            redactions: { emails: 1, phones: 0, ssns: 0, cards: 0, secrets: 0, urlTokens: 0 },
          },
          {
            clean: 'Call [redacted-phone]',
            redactions: { emails: 0, phones: 1, ssns: 0, cards: 0, secrets: 0, urlTokens: 0 },
          },
        ],
        totalRedactions: { emails: 1, phones: 1, ssns: 0, cards: 0, secrets: 0, urlTokens: 0 },
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: '2026-09-16T07:17:00.000Z',
      },
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          count: { type: 'integer', description: 'Number of texts sanitized' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                clean: { type: 'string' },
                redactions: { type: 'object' },
              },
            },
          },
          totalRedactions: { type: 'object', description: 'Redaction counts summed across all items' },
          requestId: { type: 'string' },
          timestamp: { type: 'string' },
        },
        required: ['success', 'count', 'results', 'totalRedactions'],
      },
    },
  });

  const makeRoute = (extensions) => ({
    accepts,
    description: config.resource.description,
    mimeType: config.resource.mimeType,
    serviceName: config.resource.serviceName,
    // Bazaar discovery: this is what puts the endpoint in the x402
    // catalog so agents can find it without a pre-baked integration.
    extensions,

    unpaidResponseBody: async () => {
      const resolved = await resolvePrice();
      return {
        contentType: 'application/json',
        body: {
          error: 'Payment required',
          x402Version: 2,
          protocol: 'x402',
          requirementsHeader: 'PAYMENT-REQUIRED',
          note:
            'Machine-readable requirements are in the PAYMENT-REQUIRED response header; ' +
            'this body mirrors them for convenience.',
          accepts: [
            {
              scheme: config.scheme,
              network: config.network,
              payTo: config.payToAddress,
              maxTimeoutSeconds: config.maxTimeoutSeconds,
              price: config.price,
              amount: resolved?.amount,
              asset: resolved?.asset,
              extra: resolved?.extra,
            },
          ],
          resource: {
            description: config.resource.description,
            mimeType: config.resource.mimeType,
          },
          hint:
            'Sign a payment for one of the entries in "accepts" and retry the request with ' +
            'it in the PAYMENT-SIGNATURE header (the legacy X-PAYMENT header is also accepted).',
        },
      };
    },
  });

  return {
    [`GET ${config.resource.path}`]: makeRoute(discoverableGet),
    [`POST ${config.resource.path}`]: makeRoute(discoverablePost),
    // Batch: one settlement, up to 10 texts — the volume buyer's route.
    'POST /api/sanitize/batch': makeRoute(discoverableBatch),
  };
}

/**
 * Assemble the x402 resource server, HTTP resource server and Express middleware.
 *
 * @param {object} config - Loaded application configuration
 * @param {object} logger - Logger instance
 * @param {object} [deps] - Optional dependency overrides (used by tests)
 * @param {object} [deps.facilitatorClient] - Pre-built facilitator client
 * @returns {{
 *   resourceServer: x402ResourceServer,
 *   httpServer: x402HTTPResourceServer,
 *   middleware: Function,
 *   routes: Record<string, object>,
 *   initialize: () => Promise<void>,
 *   isReady: () => boolean,
 *   lastInitializationError: () => Error|null
 * }} x402 bundle
 */
export function createX402(config, logger, deps = {}) {
  const facilitatorClient = deps.facilitatorClient ?? createFacilitatorClient(config);

  // One scheme instance drives both price resolution and registration.
  const evmScheme = new ExactEvmScheme();
  const routes = buildRoutes(config, evmScheme);

  // The scheme is registered per network — this is what maps `exact` on
  // `eip155:84532` to USDC/Base-Sepolia and resolves "$0.001" into 1000 units.
  const resourceServer = new x402ResourceServer(facilitatorClient).register(config.network, evmScheme);

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  // syncFacilitatorOnStart=false keeps the middleware from firing a facilitator
  // call per cold request; this module performs an explicit, observable
  // initialization instead so readiness can be reported accurately.
  const middleware = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);

  let ready = false;
  /** @type {Error|null} */
  let initError = null;
  /** @type {Promise<void>|null} */
  let inFlight = null;
  /** @type {NodeJS.Timeout|null} */
  let retryTimer = null;

  /**
   * Load the facilitator's supported kinds. Safe to call repeatedly.
   *
   * @returns {Promise<void>} Resolves when the resource server is initialized
   */
  async function initialize() {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      await resourceServer.initialize();
      ready = true;
      initError = null;
      const kinds = resourceServer.getSupportedKind(2, config.network, config.scheme);
      logger.info(
        `x402 initialized — facilitator ${config.facilitator.url} supports ${config.scheme} on ${config.network}` +
          (kinds?.extra ? ` (extra: ${JSON.stringify(kinds.extra)})` : ''),
      );
    })()
      .catch((error) => {
        ready = false;
        // The SDK collapses facilitator failures into "no supported payment
        // kinds"; keep the root cause visible for production debugging.
        const causeMessage = error?.cause?.message ? ` Cause: ${error.cause.message}` : '';
        const wrapped = new Error(`${error.message}${causeMessage}`);
        wrapped.cause = error;
        initError = wrapped;
        throw wrapped;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  }

  /**
   * Retry initialization in the background until it succeeds, so a facilitator
   * blip at deploy time heals itself without a redeploy.
   *
   * @param {number} [intervalMs] - Delay between attempts
   */
  function scheduleRetry(intervalMs = 30_000) {
    if (retryTimer) return;
    retryTimer = setInterval(async () => {
      try {
        await initialize();
        clearInterval(retryTimer);
        retryTimer = null;
        logger.info('x402 initialization recovered.');
      } catch (error) {
        logger.warn(`x402 initialization still failing: ${error.message}`);
      }
    }, intervalMs);
    retryTimer.unref?.();
  }

  /**
   * Stop background retries (used on shutdown and in tests).
   */
  function stopRetries() {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  return {
    resourceServer,
    httpServer,
    middleware,
    routes,
    initialize,
    scheduleRetry,
    stopRetries,
    isReady: () => ready,
    lastInitializationError: () => initError,
  };
}