// ============================================================================
// Desanatization — x402 Payment Server (bootstrap)
//
// Starts the HTTP server, performs the x402 facilitator preflight, and shuts
// down cleanly on SIGTERM/SIGINT.
// ============================================================================

import { ConfigError, describeConfig, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './app.js';
import { createX402 } from './x402.js';
import fsSync from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

/**
 * Well-known demo addresses. Paying into one of these means paying a stranger,
 * so it is always worth a loud warning.
 */
const PLACEHOLDER_ADDRESSES = new Set(['0x742d35cc6634c0532925a3b844bc9e7595f42b15']);

/**
 * Load `.env` for local development. Railway (and any real host) injects
 * environment variables directly, so a missing file is not an error.
 *
 * @returns {void}
 */
function loadDotEnvFile() {
  if (typeof process.loadEnvFile !== 'function') {
    return;
  }
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file (production) or unreadable — environment wins either way.
  }
}

/**
 * Boot the server.
 *
 * @returns {Promise<void>} Resolves once the server is listening
 */
async function main() {
  loadDotEnvFile();

  const logger = createLogger('bootstrap');

  /** @type {ReturnType<typeof loadConfig>} */
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Printed directly: the logger is configured by LOG_LEVEL, and a
      // configuration failure must always be visible.
      console.error(`\n✖ ${error.message}\n`);
      console.error('See .env.example for the full list of supported variables.\n');
      process.exit(1);
    }
    throw error;
  }

  logger.info('Effective configuration:');
  logger.info(JSON.stringify(describeConfig(config), null, 2));

  for (const warning of config.warnings) {
    logger.warn(`⚠ ${warning}`);
  }

  if (PLACEHOLDER_ADDRESSES.has(config.payToAddress.toLowerCase())) {
    logger.warn(
      '⚠ PAY_TO_ADDRESS is the x402 documentation demo address. Payments sent here go to a ' +
        'third party, not to you. Set PAY_TO_ADDRESS to your own wallet before charging real money.',
    );
  }

  const x402 = createX402(config, logger);
  const { app, dispose, growthEngine, notifier, supervisor } = createApp({ config, logger, x402 });

  // Ensure the data directory exists for persistent state (growth ledger,
  // agent skills, notification milestones). In Docker/Railway this is a
  // mounted volume at /app/data. In local dev it is a sibling directory.
  try {
    const dataDir = config.growth?.statePath || config.growth?.agentStatePath || config.notifications?.statePath || 'data';
    const dir = dirname(resolvePath(dataDir));
    fsSync.mkdirSync(dir, { recursive: true });
  } catch (error) {
    logger.warn(`Could not create data directory for state persistence: ${error.message}`);
  }

  const server = app.listen(config.port, config.host, () => {
    logger.info(`HTTP server listening on ${config.host}:${config.port}`);
    logger.info(`Paid endpoint: GET ${config.resource.path} for ${JSON.stringify(config.price)} on ${config.network}`);
  });

  // Outbound growth loop: growthEngine.start() fires the first cycle at boot
  // (then the interval takes over). A cold engine that waits 6h for its first
  // probe learns nothing for hours — the goal is agents finding us within
  // minutes of deploy. start() owns the boot-fire; nothing here calls it
  // again, or the engine would run cycle 1 twice.
  growthEngine.start();

  // Railway terminates TLS and forwards; keep sockets from idling forever.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;

  /**
   * Graceful shutdown: stop accepting connections, then exit.
   *
   * @param {string} reason - Why we are shutting down (logged)
   * @param {number} [exitCode] - Process exit code
   * @returns {void}
   */
  function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Shutting down (${reason})…`);

    x402.stopRetries();
    growthEngine.stop?.();
    dispose();

    const forceExit = setTimeout(() => {
      logger.warn('In-flight requests did not finish within 10s — forcing exit.');
      process.exit(exitCode || 1);
    }, 10_000);
    forceExit.unref();

    server.close(() => {
      logger.info('HTTP server closed. Bye.');
      clearTimeout(forceExit);
      process.exit(exitCode);
    });
    server.closeIdleConnections?.();
  }

  // Preflight the facilitator so a misconfigured network/scheme fails loudly
  // instead of silently returning 500s to paying agents.
  try {
    await x402.initialize();
  } catch (error) {
    logger.error(
      `✖ x402 preflight failed against facilitator ${config.facilitator.url}: ${error.message}`,
    );
    logger.error(
      '  Check FACILITATOR_URL, NETWORK and (for some production facilitators) FACILITATOR_AUTH_HEADER. ' +
        `/health still reports liveness; /ready reports not-ready until this succeeds.`,
    );

    if (config.strictStartup) {
      logger.error('STRICT_STARTUP is enabled — exiting so the deployment fails visibly.');
      shutdown('x402 preflight failure', 1);
      return;
    }

    logger.warn('Continuing to serve; initialization will be retried in the background.');
    x402.scheduleRetry();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception — exiting', error);
    shutdown('uncaught exception', 1);
  });
}

main().catch((error) => {
  console.error('Fatal startup error:');
  console.error(error);
  process.exit(1);
});