// ============================================================================
// AI Privacy Gateway — Phase 0 prototype
//
// A drop-in reverse proxy for OpenAI-compatible chat completions: a caller
// points its SDK's base URL here instead of the real provider, we tokenize
// every message's PII/PHI before forwarding, call the real upstream with a
// server-held credential the caller never sees, then reinsert real values
// into the response so the caller gets a fully useful answer.
//
// Deliberately separate from app.js / index.js: this is a different product
// for a different buyer (enterprise procurement, not AI agents paying in
// USDC), with a different auth model (a shared gateway key today, SSO/OIDC in
// a later phase) and it must never share a deploy or a brand surface with the
// x402 agent-economy product — see the roadmap's brand-separation risk.
//
// Zero-data-retention discipline: nothing in this file logs a message body,
// a token mapping, or a redacted/original value. Only counts, latency and
// entity-type telemetry are ever logged. The token mapping lives only in the
// closure of a single request handler and is discarded when the response is
// sent — there is no cache, no disk write, no persistence path at all.
//
// Not yet built (see roadmap Phase 1+): SSO/OIDC + RBAC, per-tenant policy
// config, durable tamper-evident audit export to a customer SIEM, streaming
// responses (tokens that survive a streamed/chunked response need different
// handling than this synchronous request/response prototype), NER for
// unstructured entities (names, addresses, MRNs) beyond what detectors.js's
// regex/checksum layer catches.
// ============================================================================

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { tokenize, reinsert } from './tokenizer.js';
import { safeFetch } from '../net-safety.js';

const MAX_BODY_BYTES = 2_000_000;

/**
 * Timing-safe comparison of a caller-supplied gateway key against the
 * configured one — same discipline as app.js's requireMetricsToken.
 *
 * @param {string} received - Value from the Authorization header
 * @param {string} expected - Configured GATEWAY_API_KEY
 * @returns {boolean} True when they match
 */
function safeKeyMatch(received, expected) {
  const a = Buffer.from(String(received ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Build the gateway Express app.
 *
 * @param {object} config
 * @param {string} config.gatewayApiKey - Shared key callers must present
 * @param {string} config.upstreamBaseUrl - Real provider base URL, e.g. https://api.openai.com
 * @param {string} config.upstreamApiKey - Real provider credential, held server-side only
 * @param {object} config.logger - Pino-style logger; only ever receives metadata, never content
 * @returns {import('express').Express} Configured app
 */
export function createGatewayApp({ gatewayApiKey, upstreamBaseUrl, upstreamApiKey, logger }) {
  if (!gatewayApiKey) throw new Error('GATEWAY_API_KEY is required');
  if (!upstreamBaseUrl) throw new Error('UPSTREAM_BASE_URL is required');
  if (!upstreamApiKey) throw new Error('UPSTREAM_API_KEY is required');

  const app = express();
  app.use(express.json({ limit: MAX_BODY_BYTES }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'ai-privacy-gateway' }));

  app.post('/v1/chat/completions', async (req, res) => {
    const started = Date.now();
    const auth = req.get('authorization') ?? '';
    const presented = auth.replace(/^Bearer\s+/i, '');
    if (!safeKeyMatch(presented, gatewayApiKey)) {
      return res.status(401).json({ error: { message: 'Invalid gateway API key' } });
    }

    const body = req.body;
    if (!body || !Array.isArray(body.messages)) {
      return res.status(400).json({ error: { message: 'Body must include a "messages" array' } });
    }

    // One shared token namespace across every message in this request, so a
    // token from message 3 unambiguously maps back to its own original value.
    let state = { mapping: {}, counts: {} };
    const tokenizedMessages = body.messages.map((message) => {
      if (typeof message?.content !== 'string') return message;
      const result = tokenize(message.content, state);
      state = { mapping: result.mapping, counts: result.counts };
      return { ...message, content: result.tokenized };
    });

    let upstreamResponse;
    try {
      upstreamResponse = await safeFetch(`${upstreamBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${upstreamApiKey}`,
        },
        body: JSON.stringify({ ...body, messages: tokenizedMessages }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      logger.warn(`Gateway: upstream call failed: ${error.message}`);
      return res.status(502).json({ error: { message: 'Upstream provider unreachable' } });
    }

    const upstreamText = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      logger.warn(`Gateway: upstream returned ${upstreamResponse.status}`);
      return res.status(upstreamResponse.status).type('application/json').send(upstreamText);
    }

    let upstreamJson;
    try {
      upstreamJson = JSON.parse(upstreamText);
    } catch {
      logger.warn('Gateway: upstream response was not valid JSON');
      return res.status(502).json({ error: { message: 'Upstream returned a non-JSON response' } });
    }

    // Reinsert real values into every choice's message content before
    // returning — the caller gets a fully useful answer, not a token-riddled one.
    const restored = {
      ...upstreamJson,
      choices: Array.isArray(upstreamJson.choices)
        ? upstreamJson.choices.map((choice) => {
            if (typeof choice?.message?.content !== 'string') return choice;
            return {
              ...choice,
              message: { ...choice.message, content: reinsert(choice.message.content, state.mapping) },
            };
          })
        : upstreamJson.choices,
    };

    const entityCounts = state.counts;
    const totalRedacted = Object.values(entityCounts).reduce((sum, n) => sum + n, 0);
    logger.info(
      `Gateway request: ${totalRedacted} entities tokenized (${Object.keys(entityCounts).join(',') || 'none'}), ` +
        `upstream ${upstreamResponse.status} in ${Date.now() - started}ms`,
    );

    return res.json(restored);
  });

  app.use((_req, res) => res.status(404).json({ error: { message: 'Not found' } }));

  return app;
}
