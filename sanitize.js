// ============================================================================
// Desanatization — text sanitization product (the thing agents actually buy)
//
// Pure, dependency-free, deterministic: strip PII (emails, phones, common
// secrets), collapse whitespace, enforce a length cap. Deterministic output
// means the free tier and the paid tier agree byte-for-byte on the same
// input — agents can trust the trial.
// ============================================================================

/** Maximum input characters accepted (abuse guard + price justification). */
export const MAX_INPUT_CHARS = 20_000;

/** Maximum output characters returned. */
export const MAX_OUTPUT_CHARS = 20_000;

/** Free-tier input cap: enough to verify quality, small enough to upsell. */
export const FREE_TIER_MAX_CHARS = 500;

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN =
  /(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?){1,2}\d{3}[-.\s]?\d{4}(?!\d)/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;
const PRIVATE_KEY_PATTERN =
  /\b(?:0x)?[0-9a-fA-F]{64}\b|\bsk-[a-zA-Z0-9]{8,}\b|\bAKIA[0-9A-Z]{16}\b/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[a-zA-Z0-9\-._~+/=]{8,}\b/gi;
const URL_TOKEN_PATTERN = /([?&])(token|key|secret|api_key|access_token)=[^&\s]+/gi;

/**
 * Sanitize dirty text: redact PII/secrets, normalise whitespace.
 *
 * @param {string} text - Raw input text
 * @returns {{ clean: string, redactions: Record<string, number>, inputChars: number, outputChars: number }} Result
 */
export function sanitizeText(text) {
  const redactions = { emails: 0, phones: 0, ssns: 0, cards: 0, secrets: 0, urlTokens: 0 };
  let clean = String(text ?? '');

  clean = clean.replace(EMAIL_PATTERN, () => {
    redactions.emails++;
    return '[redacted-email]';
  });
  clean = clean.replace(CREDIT_CARD_PATTERN, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match;
    redactions.cards++;
    return '[redacted-card]';
  });
  clean = clean.replace(PHONE_PATTERN, (match) => {
    // Avoid mangling years / plain digit runs that merely look phone-shaped.
    const digits = match.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return match;
    redactions.phones++;
    return '[redacted-phone]';
  });
  clean = clean.replace(SSN_PATTERN, () => {
    redactions.ssns++;
    return '[redacted-ssn]';
  });
  clean = clean.replace(PRIVATE_KEY_PATTERN, () => {
    redactions.secrets++;
    return '[redacted-secret]';
  });
  clean = clean.replace(BEARER_TOKEN_PATTERN, () => {
    redactions.secrets++;
    return 'Bearer [redacted-secret]';
  });
  clean = clean.replace(URL_TOKEN_PATTERN, (_match, prefix, name) => {
    redactions.urlTokens++;
    return `${prefix}${name}=[redacted]`;
  });

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
 * Luhn checksum for card-like digit runs (cuts false positives).
 *
 * @param {string} digits - Digits only
 * @returns {boolean} True when the checksum passes
 */
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Validate a sanitize request body.
 *
 * @param {unknown} body - Parsed JSON body
 * @returns {{ text?: string, error?: string }} Validated text or error
 */
export function validateSanitizeBody(body) {
  if (!body || typeof body !== 'object' || typeof body.text !== 'string') {
    return { error: 'Body must be JSON { \"text\": \"...\" }' };
  }
  if (body.text.length === 0) return { error: 'Field \"text\" must not be empty' };
  if (body.text.length > MAX_INPUT_CHARS) {
    return { error: `Field \"text\" exceeds ${MAX_INPUT_CHARS} chars (received ${body.text.length})` };
  }
  return { text: body.text };
}
