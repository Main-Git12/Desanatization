// ============================================================================
// Desanatization — text sanitization product (the thing agents actually buy)
//
// Pure, dependency-free, deterministic: strip PII (emails, phones, common
// secrets), collapse whitespace, enforce a length cap. Deterministic output
// means the free tier and the paid tier agree byte-for-byte on the same
// input — agents can trust the trial.
//
// Detection patterns live in detectors.js, shared with the gateway/ product's
// reversible tokenizer — this module only applies them destructively.
// ============================================================================

import { createDetectors, REDACTION_KEYS } from './detectors.js';

/** Maximum input characters accepted (abuse guard + price justification). */
export const MAX_INPUT_CHARS = 20_000;

/** Maximum output characters returned. */
export const MAX_OUTPUT_CHARS = 20_000;

/** Free-tier input cap: enough to verify quality, small enough to upsell. */
export const FREE_TIER_MAX_CHARS = 500;

/** Maximum items per paid batch call: one settlement, up to N texts. */
export const BATCH_MAX_ITEMS = 10;

/** In-memory result cache cap (LRU-ish: oldest evicted first). */
export const CACHE_MAX_ENTRIES = 500;

const cache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Sanitize dirty text: redact PII/secrets, normalise whitespace.
 *
 * @param {string} text - Raw input text
 * @returns {{ clean: string, redactions: Record<string, number>, inputChars: number, outputChars: number }} Result
 */
export function sanitizeText(text) {
  const redactions = Object.fromEntries(REDACTION_KEYS.map((k) => [k, 0]));
  let clean = String(text ?? '');

  for (const detector of createDetectors()) {
    clean = clean.replace(detector.pattern, (match, ...rest) => {
      if (detector.accept && !detector.accept(match)) return match;
      redactions[detector.key]++;
      return detector.destructiveReplacement(match, ...rest);
    });
  }

  clean = clean.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length > MAX_OUTPUT_CHARS) clean = clean.slice(0, MAX_OUTPUT_CHARS);

  return {
    clean,
    redactions,
    inputChars: String(text ?? '').length,
    outputChars: clean.length,
  };
}

/**
 * Validate a sanitize request body.
 *
 * @param {unknown} body - Parsed JSON body
 * @returns {{ text?: string, error?: string }} Validated text or error
 */
export function validateSanitizeBody(body) {
  if (!body || typeof body !== 'object' || typeof body.text !== 'string') {
    return { error: 'Body must be JSON { "text": "..." }' };
  }
  if (body.text.length === 0) return { error: 'Field "text" must not be empty' };
  if (body.text.length > MAX_INPUT_CHARS) {
    return { error: `Field "text" exceeds ${MAX_INPUT_CHARS} chars (received ${body.text.length})` };
  }
  return { text: body.text };
}

/**
 * Validate a batch sanitize body: up to BATCH_MAX_ITEMS texts, one payment.
 *
 * @param {unknown} body - Parsed JSON body
 * @returns {{ items?: string[], error?: string }} Validated items or error
 */
export function validateBatchBody(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) {
    return { error: 'Body must be JSON { "items": ["...", "..."] } (1-10 texts)' };
  }
  if (body.items.length === 0 || body.items.length > BATCH_MAX_ITEMS) {
    return { error: `Field "items" must hold 1-${BATCH_MAX_ITEMS} texts (received ${body.items.length})` };
  }
  for (let i = 0; i < body.items.length; i++) {
    if (typeof body.items[i] !== 'string' || body.items[i].length === 0) {
      return { error: `items[${i}] must be a non-empty string` };
    }
    if (body.items[i].length > MAX_INPUT_CHARS) {
      return { error: `items[${i}] exceeds ${MAX_INPUT_CHARS} chars` };
    }
  }
  return { items: body.items };
}

/**
 * Validate a referral id: short, URL-safe, attributable — never trusted for
 * auth, only for counting which agent sent the buyer.
 *
 * @param {unknown} raw - Raw query/header value
 * @returns {string|undefined} Clean ref or undefined
 */
export function validateRef(raw) {
  const ref = String(raw ?? '').slice(0, 64);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(ref) ? ref : undefined;
}

/**
 * Sanitize with a bounded in-process cache. Same input → same output, so
 * repeat buyers get instant responses and we skip redundant work.
 *
 * @param {string} text - Raw input text
 * @returns {{ clean: string, redactions: Record<string, number>, inputChars: number, outputChars: number, cached: boolean }} Result
 */
export function sanitizeCached(text) {
  const key = String(text ?? '');
  const hit = cache.get(key);
  if (hit) {
    cacheHits++;
    cache.delete(key);
    cache.set(key, hit);
    return { ...hit, cached: true };
  }
  cacheMisses++;
  const result = sanitizeText(key);
  cache.set(key, { ...result, cached: false });
  if (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return { ...result, cached: false };
}

/**
 * Cache telemetry for /api/insights and tests.
 *
 * @returns {{ entries: number, hits: number, misses: number }} Stats
 */
export function cacheStats() {
  return { entries: cache.size, hits: cacheHits, misses: cacheMisses };
}

/**
 * Clear the cache (tests).
 *
 * @returns {void}
 */
export function clearCache() {
  cache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}
