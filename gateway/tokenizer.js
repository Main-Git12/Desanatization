// ============================================================================
// Reversible tokenize/reinsert — the gateway product's core difference from
// Desanatization's destructive '[redacted-x]' sanitizer.
//
// tokenize() replaces each detected entity with an opaque placeholder and
// returns a per-request mapping; reinsert() substitutes real values back into
// an LLM's response so the end user gets a fully useful answer, never a
// mutilated one. The mapping is a plain in-memory object scoped to a single
// call — nothing here persists it, logs it, or writes it to disk. Callers
// (the proxy) must hold it only for the lifetime of one request and must
// never log, cache, or store it.
// ============================================================================

import { createDetectors } from '../detectors.js';

/**
 * Detect and replace every PII/secret match with an opaque, reversible token.
 *
 * @param {string} text - Raw input text
 * @param {{ mapping?: Record<string, string>, counts?: Record<string, number> }} [state] -
 *   Pass the previous call's returned `{ mapping, counts }` to keep one token
 *   namespace across several texts in the same request (e.g. a chat's several
 *   messages) — otherwise each call restarts numbering at 1, and two
 *   different messages' first email would collide on the same token.
 * @returns {{ tokenized: string, mapping: Record<string, string>, counts: Record<string, number> }}
 *   `mapping` is token -> original matched substring. `counts` mirrors
 *   sanitize.js's redaction tallies, keyed by tokenLabel instead of key, for
 *   telemetry that never touches the original values.
 */
export function tokenize(text, state) {
  const mapping = state?.mapping ?? {};
  const counts = state?.counts ?? {};
  let tokenized = String(text ?? '');

  for (const detector of createDetectors()) {
    tokenized = tokenized.replace(detector.pattern, (match) => {
      if (detector.accept && !detector.accept(match)) return match;
      const n = (counts[detector.tokenLabel] = (counts[detector.tokenLabel] ?? 0) + 1);
      const token = `{{PII_${detector.tokenLabel}_${n}}}`;
      mapping[token] = match;
      return token;
    });
  }

  return { tokenized, mapping, counts };
}

/**
 * Substitute tokens back into text (an LLM response) with their original
 * values. Unknown/missing tokens (the model paraphrased or dropped one) are
 * left as-is rather than throwing — a gateway must degrade gracefully, never
 * crash a real user's request over a single unreturned placeholder.
 *
 * @param {string} text - Text containing `{{PII_LABEL_N}}` placeholders
 * @param {Record<string, string>} mapping - Token -> original value, from tokenize()
 * @returns {string} Text with every recognized token restored
 */
export function reinsert(text, mapping) {
  let result = String(text ?? '');
  for (const [token, original] of Object.entries(mapping ?? {})) {
    result = result.split(token).join(original);
  }
  return result;
}
