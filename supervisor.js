// ============================================================================
// Self-Healing Supervisor
//
// A dependency-free, in-process supervisor that watches the service's health
// signals and, when they degrade, attempts the cheapest recovery first and
// escalates only if that fails. It is deliberately NOT an auto-restart loop:
// it cannot restart the process, so every action it takes is safe and
// observable. Its real job is to detect a degraded state, record it, and hand
// the operator a concrete next step — including firing the notification
// channel so a human sees it without polling.
//
// Recovery actions (in order of cost):
//   1. log      — record the signal and the response
//   2. notify   — fire the configured notification channel
//   3. nudge    — ask the growth engine to skip its next cycle (reduce load)
//   4. escalate — surface in /api/health/deep and /metrics
//
// It never touches the facilitator or the payment path directly; it observes
// the readiness state the x402 layer already publishes.
// ============================================================================

import { createLogger } from './logger.js';

/**
 * @typedef {object} HealthSignal
 * @property {string} name - Signal identifier
 * @property {boolean} ok - Current reading
 * @property {string} detail - Human-readable evidence
 * @property {string} [since] - ISO timestamp of first failure
 */

/**
 * Create the supervisor.
 *
 * @param {object} options
 * @param {object} options.logger - Pino-style logger
 * @param {object} options.notifier - Notifier from createNotifier()
 * @param {object} options.growthEngine - Growth engine (optional; nudge only)
 * @param {object} options.x402 - x402 bundle (optional; reads readiness)
 * @param {number} [options.cooldownMs] - Min time between recovery attempts
 * @returns {{ check: () => HealthSignal[], escalate: (signal) => Promise<void>, snapshot: () => object, start: () => void, stop: () => void }}
 */
export function createSupervisor({ logger, notifier, growthEngine, x402, cooldownMs = 60_000 }) {
  /** @type {Map<string, HealthSignal>} */
  const failures = new Map();
  /** @type {number|undefined} */
  let lastEscalated = 0;

  /**
   * Read the current health signals from the live subsystems.
   *
   * @returns {HealthSignal[]} Current readings
   */
  function check() {
    const signals = [];

    // Facilitator readiness: the single signal that gates real revenue.
    const ready = Boolean(x402?.isReady?.());
    signals.push({
      name: 'paywallReady',
      ok: ready,
      detail: ready ? 'facilitator preflight succeeded' : 'facilitator not ready — paid routes return 503',
      since: ready ? undefined : (failures.get('paywallReady')?.since ?? new Date().toISOString()),
    });

    // Error rate: a sustained rise above 5% means something is wrong.
    // (Handled by the caller supplying metrics; this supervisor focuses on
    // the signals it owns.)

    return signals;
  }

  /**
   * Record a degraded signal and attempt the cheapest recovery.
   *
   * @param {HealthSignal} signal - The degraded reading
   * @returns {Promise<void>}
   */
  async function escalate(signal) {
    const existing = failures.get(signal.name);
    if (!existing) {
      failures.set(signal.name, { ...signal, since: new Date().toISOString() });
    }
    logger.warn(`Health degradation: ${signal.name} — ${signal.detail}`);

    // Cooldown: do not spam the notification channel.
    const now = Date.now();
    if (now - lastEscalated < cooldownMs) return;
    lastEscalated = now;

    // Cheapest recovery first: reduce background load so the revenue path has
    // more headroom. The growth engine is the only adjustable knob here.
    if (growthEngine?.nudge?.()) {
      logger.info('Supervisor: asked the growth engine to skip its next cycle.');
    }

    // Notify the operator channel. Best-effort — a broken channel must not
    // hide the fact that the service is degraded.
    if (notifier) {
      try {
        await notifier.notify('health', { message: `Health degradation: ${signal.name} — ${signal.detail}` });
      } catch (error) {
        logger.warn(`Supervisor: notification failed (${error.message})`);
      }
    }
  }

  /**
   * Clear a recovered signal.
   *
   * @param {string} name - Signal identifier
   */
  function recover(name) {
    if (failures.has(name)) {
      failures.delete(name);
      logger.info(`Health recovered: ${name}`);
    }
  }

  /**
   * Snapshot of active failures, for /api/health/deep.
   *
   * @returns {object}
   */
  function snapshot() {
    return {
      degraded: [...failures.values()],
      degradedCount: failures.size,
      lastEscalated: lastEscalated ? new Date(lastEscalated).toISOString() : null,
    };
  }

  /** @type {NodeJS.Timeout|undefined} */
  let timer;

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try {
        for (const signal of check()) {
          if (!signal.ok) {
            escalate(signal).catch((error) => logger.warn(`Supervisor: escalate failed: ${error.message}`));
          } else {
            recover(signal.name);
          }
        }
      } catch (error) {
        logger.warn(`Supervisor: check failed: ${error.message}`);
      }
    }, 30_000);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { check, escalate, recover, snapshot, start, stop };
}