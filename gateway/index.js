// ============================================================================
// AI Privacy Gateway — standalone bootstrap
//
// Separate process/deploy target from index.js (the x402 product). Run with:
//   GATEWAY_API_KEY=... UPSTREAM_BASE_URL=https://api.openai.com \
//   UPSTREAM_API_KEY=... GATEWAY_PORT=4000 node gateway/index.js
// ============================================================================

import { createLogger } from '../logger.js';
import { createGatewayApp } from './proxy.js';

function loadDotEnvFile() {
  if (typeof process.loadEnvFile !== 'function') return;
  try {
    process.loadEnvFile('.env.gateway');
  } catch {
    // No local env file — real env vars win either way.
  }
}

function main() {
  loadDotEnvFile();
  const logger = createLogger('gateway');

  const gatewayApiKey = process.env.GATEWAY_API_KEY;
  const upstreamBaseUrl = process.env.UPSTREAM_BASE_URL ?? 'https://api.openai.com';
  const upstreamApiKey = process.env.UPSTREAM_API_KEY;
  const port = Number(process.env.GATEWAY_PORT ?? 4000);

  if (!gatewayApiKey || !upstreamApiKey) {
    console.error(
      '✖ GATEWAY_API_KEY and UPSTREAM_API_KEY are both required. See gateway/index.js for the full env var list.',
    );
    process.exit(1);
  }

  const app = createGatewayApp({ gatewayApiKey, upstreamBaseUrl, upstreamApiKey, logger });
  const server = app.listen(port, () => {
    logger.info(`AI Privacy Gateway listening on :${port}, forwarding to ${upstreamBaseUrl}`);
  });

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

main();
