// ============================================================================
// Outbound Notification System
//
// Fires structured events (first purchase, settlement, insights) to an
// operator channel. Dependency-free by design: every transport is plain HTTP,
// so no SMTP library is needed and the runtime dependency set stays empty.
//
// Transports:
//   none     — log only (default). Safe everywhere, including local dev.
//   webhook  — POST a JSON event envelope to NOTIFICATION_WEBHOOK_URL.
//   smtp     — POST a JSON email envelope to NOTIFICATION_SMTP_URL. The URL
//              points at an HTTP-to-email bridge (SendGrid v3, Mailgun, Resend,
//              or your own). The envelope is documented in notify().
//
// "First purchase" is durable: the fact that it already fired is persisted
// (atomic tmp+rename) so a restart never re-alerts on the same milestone.
// ============================================================================

import fsSync from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from './logger.js';

/** Known notification transports. */
export const TRANSPORTS = Object.freeze(['none', 'webhook', 'smtp']);

/** Canonical event names. */
export const NOTIFICATION_EVENT = Object.freeze({
  FIRST_PURCHASE: 'firstPurchase',
  PAYMENT_SETTLED: 'paymentSettled',
  INSIGHTS: 'insights',
  HEALTH: 'health',
});

/**
 * Fetch with a timeout, never throwing. Shared helper so transports cannot
 * hang the request path.
 *
 * @param {string} url - Absolute URL
 * @param {RequestInit} [init] - Optional fetch init
 * @returns {Promise<{status: number, ok: boolean, body: string}>}
 */
async function fetchSafe(url, init = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), ...init });
    return { status: response.status, ok: response.ok, body: await response.text() };
  } catch (error) {
    return { status: 0, ok: false, body: String(error?.cause?.message ?? error?.message ?? error) };
  }
}

/**
 * Build the event envelope every transport receives. Keeping one shape means
 * adding a new channel is a transport change, not a payload change.
 *
 * @param {string} event - Event name from NOTIFICATION_EVENT
 * @param {object} data - Event payload
 * @param {object} config - Loaded configuration
 * @returns {object} Envelope
 */
function buildEnvelope(event, data, config) {
  return {
    event,
    source: config.resource.serviceName,
    network: config.network,
    at: new Date().toISOString(),
    data,
  };
}

/**
 * Build the email-shaped payload the smtp transport sends. This is the generic
 * envelope an HTTP-to-email bridge expects; operators using a specific provider
 * point NOTIFICATION_SMTP_URL at that provider's HTTP endpoint and the fields
 * below map onto the common shapes:
 *   SendGrid  — POST /v3/mail/send with { personalizations:[{to}], from, subject, content }
 *   Mailgun   — POST /v3/messages  with form fields { from, to, subject, text }
 *   Resend    — POST /emails         with { from, to, subject, text }
 * A custom bridge can read the same fields.
 *
 * @param {string} event - Event name
 * @param {object} data - Event payload
 * @param {object} config - Loaded configuration
 * @returns {object} Email payload
 */
function buildEmailPayload(event, data, config) {
  const titles = {
    [NOTIFICATION_EVENT.FIRST_PURCHASE]: 'First purchase received — your service is earning',
    [NOTIFICATION_EVENT.PAYMENT_SETTLED]: 'Payment settled',
    [NOTIFICATION_EVENT.INSIGHTS]: 'Weekly insights',
    [NOTIFICATION_EVENT.HEALTH]: 'Health alert',
  };
  const subject = titles[event] ?? event;
  const text = typeof data?.message === 'string' ? data.message : JSON.stringify(data, null, 2);
  return {
    from: config.notifications.from,
    to: config.notifications.to,
    subject: `[${config.resource.serviceName}] ${subject}`,
    text,
    // Providers that want HTML get a minimal wrapped version; plain text is
    // the universal fallback and is what we always send.
    html: `<pre style="font-family:monospace">${String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`,
    event,
    at: new Date().toISOString(),
  };
}

/**
 * Create the notification dispatcher.
 *
 * @param {object} config - Loaded configuration
 * @param {object} logger - Pino-style logger
 * @returns {{ notify: Function, notifyFirstPurchase: Function, getState: Function, dispose: Function }} Notifier
 */
export function createNotifier(config, logger) {
  const n = config.notifications ?? {};
  const transport = TRANSPORTS.includes(n.transport) ? n.transport : 'none';

  /** Whether the first-purchase milestone already fired (and was persisted). */
  let firstPurchaseFired = false;

  /**
   * Persist the first-purchase milestone so restarts do not re-alert.
   */
  function persistState() {
    if (!n.statePath) return;
    try {
      fsSync.mkdirSync(dirname(n.statePath), { recursive: true });
      const tmp = `${n.statePath}.tmp`;
      fsSync.writeFileSync(tmp, JSON.stringify({ firstPurchaseFired, savedAt: new Date().toISOString() }));
      fsSync.renameSync(tmp, n.statePath);
    } catch (error) {
      logger.warn(`Notifications: could not persist state (${error.message}) — milestone may re-fire after restart.`);
    }
  }

  // Restore the milestone from disk when a state path is configured.
  if (n.statePath) {
    try {
      const saved = JSON.parse(fsSync.readFileSync(n.statePath, 'utf8'));
      firstPurchaseFired = Boolean(saved.firstPurchaseFired);
    } catch {
      // Missing or corrupt file — start fresh. Not fatal.
    }
  }

  /**
   * Fire one event at the configured transport. Never throws: a notification
   * channel failing must never take the revenue path down.
   *
   * @param {string} event - Event name
   * @param {object} data - Event payload
   * @returns {Promise<boolean>} True when the channel acknowledged
   */
  async function notify(event, data) {
    const envelope = buildEnvelope(event, data, config);

    if (transport === 'none') {
      logger.info(`notify[${event}] ${JSON.stringify(data)}`);
      return true;
    }

    if (transport === 'webhook') {
      if (!n.webhookUrl) {
        logger.warn('NOTIFICATION_TRANSPORT=webhook but no NOTIFICATION_WEBHOOK_URL set — skipping.');
        return false;
      }
      const result = await fetchSafe(n.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      });
      if (!result.ok) logger.warn(`notify[${event}] webhook ${result.status}: ${result.body.slice(0, 200)}`);
      return result.ok;
    }

    if (transport === 'smtp') {
      if (!n.smtpUrl || !n.from || !n.to) {
        logger.warn(
          'NOTIFICATION_TRANSPORT=smtp requires NOTIFICATION_SMTP_URL, NOTIFICATION_FROM and NOTIFICATION_TO — skipping.',
        );
        return false;
      }
      const payload = buildEmailPayload(event, data, config);
      const result = await fetchSafe(n.smtpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!result.ok) logger.warn(`notify[${event}] email bridge ${result.status}: ${result.body.slice(0, 200)}`);
      else logger.info(`notify[${event}] email sent to ${n.to}`);
      return result.ok;
    }

    return true;
  }

  /**
   * Fire the first-purchase milestone exactly once, durably.
   *
   * @param {object} payment - Settlement details from trackPayment()
   * @returns {Promise<void>}
   */
  async function notifyFirstPurchase(payment) {
    if (firstPurchaseFired) return;
    firstPurchaseFired = true;
    persistState();
    const message =
      `First successful purchase: ${payment?.amount ?? '?'} ${payment?.asset ?? 'USDC'} ` +
      `on ${payment?.network ?? 'unknown'} from ${payment?.payer ?? 'unknown'} ` +
      `(tx ${payment?.transaction ?? 'n/a'}). The service is earning real revenue.`;
    await notify(NOTIFICATION_EVENT.FIRST_PURCHASE, { payment, message });
  }

  /**
   * Current milestone state (for GET /api/notifications).
   *
   * @returns {object} Status snapshot
   */
  function getState() {
    return {
      transport,
      configured: transport !== 'none',
      firstPurchaseFired,
      channels: {
        webhook: Boolean(n.webhookUrl),
        smtp: Boolean(n.smtpUrl && n.from && n.to),
      },
    };
  }

  return { notify, notifyFirstPurchase, getState };
}