// ============================================================================
// A2A Commerce Protocol — Agent-to-Agent bidding and service catalog
//
// Enables autonomous agents to discover, bid on, fulfill, and resell services
// in a continuous commerce loop. Each service is self-describing, price
// discoverable, and resellable with attribution.
// ============================================================================

/** Service catalog: what this agent can provide to peers. */
export const SERVICE_CATALOG = {
  sanitize: {
    name: 'PII sanitization',
    description: 'Redact emails, phones, SSNs, cards, secrets from text',
    price: '$0.001',
    network: 'eip155:8453',
    endpoint: '/api/resource',
    method: 'POST',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 20000 } } },
    outputSchema: {
      type: 'object',
      properties: {
        clean: { type: 'string' },
        redactions: { type: 'object' },
      },
    },
    tags: ['pii', 'privacy', 'security', 'compliance', 'data-processing'],
  },
  batch: {
    name: 'Bulk PII sanitization',
    description: 'Sanitize up to 10 texts in one settlement',
    price: '$0.001',
    network: 'eip155:8453',
    endpoint: '/api/sanitize/batch',
    method: 'POST',
    inputSchema: { type: 'object', required: ['items'], properties: { items: { type: 'array', maxItems: 10, items: { type: 'string' } } } },
    outputSchema: { type: 'object', properties: { results: { type: 'array' }, totalRedactions: { type: 'object' } } },
    tags: ['pii', 'bulk', 'batch', 'data-processing'],
  },
  proxy: {
    name: 'x402 payment proxy',
    description: 'Pay for a peer service using our USDC balance, markup included',
    price: '$0.002',
    network: 'eip155:8453',
    endpoint: '/api/proxy',
    method: 'POST',
    inputSchema: { type: 'object', required: ['targetUrl', 'text'], properties: { targetUrl: { type: 'string' }, text: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { clean: { type: 'string' }, proxiedFrom: { type: 'string' } } },
    tags: ['proxy', 'x402', 'payment-relay', 'interoperability'],
  },
  discover: {
    name: 'A2A peer discovery',
    description: 'Discover x402-enabled agents in any network',
    price: '$0.005',
    network: 'eip155:8453',
    endpoint: '/api/discover',
    method: 'POST',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { peers: { type: 'array' } } },
    tags: ['discovery', 'a2a', 'marketplace', 'research'],
  },
};

/**
 * Build a service catalog listing for A2A discovery.
 *
 * @param {object} config - Loaded configuration
 * @param {string} baseUrl - Our public base URL
 * @returns {object} Catalog document
 */
export function buildServiceCatalog(config, baseUrl) {
  const paidUrl = `${baseUrl}${config.resource.path}`;
  return {
    name: config.resource.serviceName,
    version: '1.0.0',
    description: 'A2A commerce node — autonomous agent-to-agent services over x402',
    network: config.network,
    operator: config.payToAddress,
    services: Object.entries(SERVICE_CATALOG).map(([key, svc]) => ({
      id: key,
      name: svc.name,
      description: svc.description,
      price: svc.price,
      network: svc.network,
      endpoint: `${baseUrl}${svc.endpoint}`,
      method: svc.method,
      tags: svc.tags,
      inputSchema: svc.inputSchema,
      outputSchema: svc.outputSchema,
      canResell: true,
    })),
    resale: {
      enabled: true,
      commissionRate: 0.1, // 10% to referrer
      attribution: '?ref=<referrer-id>',
    },
    links: {
      discovery: `${baseUrl}/.well-known/x402.json`,
      mcp: `${baseUrl}/.well-known/mcp.json`,
      openapi: `${baseUrl}/openapi.json`,
    },
  };
}

/**
 * Parse a peer's A2A bid response and determine if we can profit from it.
 *
 * @param {object} bid - Peer's bid response
 * @param {number} budget - Our USDC budget for this request
 * @returns {{ accept: boolean, profitOpportunity: boolean, netCost: number }}
 */
export function evaluateBid(bid, budget) {
  if (!bid || typeof bid !== 'object') return { accept: false, profitOpportunity: false, netCost: 0 };
  const peerPrice = typeof bid.price === 'string' ? parseFloat(bid.price.replace(/[$,]/g, '')) : bid.price;
  if (typeof peerPrice !== 'number' || isNaN(peerPrice)) return { accept: false, profitOpportunity: false, netCost: 0 };
  const netCost = peerPrice * 1.1; // 10% markup for our commission
  const accept = netCost <= budget && peerPrice > 0;
  return {
    accept,
    profitOpportunity: peerPrice > 0 && netCost < budget,
    netCost,
  };
}
