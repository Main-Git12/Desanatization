// ============================================================================
// Shared PII/secret detector registry.
//
// One detection core, two products: Desanatization's destructive '[redacted-x]'
// sanitizer (sanitize.js) and the reversible tokenize/reinsert gateway
// (gateway/tokenizer.js) both drive off this same ordered list of detectors,
// so improving detection helps both instead of drifting apart.
//
// Order matters: cards must run before phones (a card-shaped run of digits
// would otherwise get chewed up by the looser phone pattern first), and this
// order matches Desanatization's original inline sequence exactly.
// ============================================================================

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;
// The leading (?<!\d) is load-bearing: without it the pattern happily matches a
// 13-digit slice *inside* a longer digit run, so a 16-digit parcel ID, case
// number or account number gets redacted as a phone number. Over-redaction is
// its own failure -- a public-records requester is entitled to everything that
// is not exempt, and silently blacking out a parcel ID is a defect, not caution.
const PHONE_PATTERN =
  /(?<!\d)(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?){1,2}\d{3}[-.\s]?\d{4}(?!\d)/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const PRIVATE_KEY_PATTERN =
  /\b(?:0x)?[0-9a-fA-F]{64}\b|\bsk-[a-zA-Z0-9]{8,}\b|\bAKIA[0-9A-Z]{16}\b/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[a-zA-Z0-9\-._~+/=]{8,}\b/gi;
const URL_TOKEN_PATTERN = /([?&])(token|key|secret|api_key|access_token)=[^&\s]+/gi;

/**
 * Luhn checksum for card-like digit runs (cuts false positives).
 *
 * @param {string} digits - Digits only
 * @returns {boolean} True when the checksum passes
 */
export function luhnValid(digits) {
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
 * @typedef {object} Detector
 * @property {string} key - Redaction-count bucket name (e.g. "emails")
 * @property {string} tokenLabel - Reversible-token placeholder name (e.g. "EMAIL")
 * @property {RegExp} pattern - Global regex; a fresh instance per call site
 *   (callers must not share/mutate a single compiled RegExp's lastIndex)
 * @property {(match: string) => boolean} [accept] - Extra validation beyond the
 *   pattern (e.g. Luhn for cards, digit-count bounds for phones). Returning
 *   false means "pattern matched but this isn't really one" — left untouched.
 * @property {(match: string) => string} [destructiveReplacement] - Replacement
 *   text for sanitize.js's destructive mode. Defaults to `[redacted-<key-singular>]`.
 *   Receives the raw match so a detector can preserve a prefix (see bearer tokens).
 */

/**
 * Build a fresh copy of every detector's regex (each with its own lastIndex/
 * exec state) — call once per sanitize/tokenize pass, never share instances
 * across concurrent requests.
 *
 * @returns {Detector[]} Ordered detector list
 */
export function createDetectors() {
  return [
    {
      key: 'emails',
      tokenLabel: 'EMAIL',
      pattern: new RegExp(EMAIL_PATTERN),
      destructiveReplacement: () => '[redacted-email]',
    },
    {
      key: 'cards',
      tokenLabel: 'CARD',
      pattern: new RegExp(CREDIT_CARD_PATTERN),
      accept: (match) => {
        const digits = match.replace(/\D/g, '');
        return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
      },
      destructiveReplacement: () => '[redacted-card]',
    },
    {
      key: 'phones',
      tokenLabel: 'PHONE',
      pattern: new RegExp(PHONE_PATTERN),
      accept: (match) => {
        const digits = match.replace(/\D/g, '');
        return digits.length >= 7 && digits.length <= 15;
      },
      destructiveReplacement: () => '[redacted-phone]',
    },
    {
      key: 'ssns',
      tokenLabel: 'SSN',
      pattern: new RegExp(SSN_PATTERN),
      destructiveReplacement: () => '[redacted-ssn]',
    },
    {
      key: 'secrets',
      tokenLabel: 'SECRET',
      pattern: new RegExp(PRIVATE_KEY_PATTERN),
      destructiveReplacement: () => '[redacted-secret]',
    },
    {
      key: 'secrets',
      tokenLabel: 'SECRET',
      pattern: new RegExp(BEARER_TOKEN_PATTERN),
      // Preserves the "Bearer " prefix — only the token itself is sensitive.
      destructiveReplacement: () => 'Bearer [redacted-secret]',
    },
    {
      key: 'urlTokens',
      tokenLabel: 'URLTOKEN',
      pattern: new RegExp(URL_TOKEN_PATTERN),
      destructiveReplacement: (_match, prefix, name) => `${prefix}${name}=[redacted]`,
    },
  ];
}

/** Every redaction-count bucket a fresh tally should start at zero for. */
export const REDACTION_KEYS = ['emails', 'phones', 'ssns', 'cards', 'secrets', 'urlTokens'];
