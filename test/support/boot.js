// ============================================================================
// Test Support: boot the real application on an ephemeral port
//
// Uses the production app factory and the production x402 wiring; only the
// facilitator is stubbed. Port 0 means the OS assigns a free port, so tests
// never collide with each other or a running dev server.
// ============================================================================

import { createApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createX402 } from '../../x402.js';
import { createLogger } from '../../logger.js';
import { createStubFacilitator } from './stubFacilitator.js';

// Keep test output readable; individual tests can raise this.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

/** Valid baseline environment used by every test unless overridden. */
export const BASE_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  PAY_TO_ADDRESS: '0x742d35Cc6634C0532925a3b844Bc9e7595f42b15',
  NETWORK: 'eip155:84532',
  PRICE: '$0.001',
  FACILITATOR_URL: 'https://x402.org/facilitator',
};

/**
 * Start the application on an ephemeral port.
 *
 * @param {object} [options] - Test setup
 * @param {object} [options.env] - Environment overrides merged over BASE_ENV
 * @param {object} [options.facilitatorClient] - Facilitator (defaults to a stub)
 * @param {boolean} [options.initialize=true] - Run the facilitator preflight
 * @returns {Promise<object>} Test server handle
 */
export async function startTestServer({ env = {}, facilitatorClient, initialize = true } = {}) {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const logger = createLogger('test');
  const facilitator = facilitatorClient ?? createStubFacilitator({ network: config.network });
  const x402 = createX402(config, logger, { facilitatorClient: facilitator });
  const { app, dispose } = createApp({ config, logger, x402 });

  if (initialize) {
    await x402.initialize();
  }

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const { port } = server.address();

  return {
    config,
    baseUrl: `http://127.0.0.1:${port}`,
    facilitator,
    x402,
    server,

    /**
     * GET/POST against the test server.
     *
     * @param {string} path - Request path
     * @param {RequestInit} [init] - fetch options
     * @returns {Promise<Response>} fetch response
     */
    fetch: (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),

    /** Stop the server and release timers. */
    async close() {
      dispose();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeIdleConnections?.();
    },
  };
}