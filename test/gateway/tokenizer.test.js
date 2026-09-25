// ============================================================================
// Gateway Tokenizer Tests: reversible tokenize/reinsert round-trips, and the
// shared-state behavior a multi-message chat request depends on.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, reinsert } from '../../gateway/tokenizer.js';

describe('gateway tokenizer', () => {
  test('tokenizes every PII class and reinsert restores the original exactly', () => {
    const original = 'Mail jane@example.com, ssn 123-45-6789, card 4242424242424242.';
    const { tokenized, mapping } = tokenize(original);

    assert.doesNotMatch(tokenized, /jane@example\.com/);
    assert.doesNotMatch(tokenized, /123-45-6789/);
    assert.doesNotMatch(tokenized, /4242424242424242/);
    assert.match(tokenized, /\{\{PII_EMAIL_1\}\}/);
    assert.match(tokenized, /\{\{PII_SSN_1\}\}/);
    assert.match(tokenized, /\{\{PII_CARD_1\}\}/);

    assert.equal(reinsert(tokenized, mapping), original);
  });

  test('leaves non-PII text untouched', () => {
    const { tokenized, mapping } = tokenize('order 12345 shipped in 2024');
    assert.equal(tokenized, 'order 12345 shipped in 2024');
    assert.deepEqual(mapping, {});
  });

  test('shared state keeps one token namespace across several texts', () => {
    let state = { mapping: {}, counts: {} };
    const first = tokenize('contact a@example.com', state);
    state = { mapping: first.mapping, counts: first.counts };
    const second = tokenize('also reach b@example.com', state);

    assert.match(first.tokenized, /\{\{PII_EMAIL_1\}\}/);
    assert.match(second.tokenized, /\{\{PII_EMAIL_2\}\}/);
    assert.equal(second.mapping['{{PII_EMAIL_1}}'], 'a@example.com');
    assert.equal(second.mapping['{{PII_EMAIL_2}}'], 'b@example.com');
  });

  test('reinsert degrades gracefully when a token never comes back', () => {
    const { mapping } = tokenize('mail x@example.com');
    // Simulates an LLM paraphrasing the placeholder away instead of echoing it.
    assert.equal(reinsert('I removed your email as requested.', mapping), 'I removed your email as requested.');
  });

  test('reinsert on empty/undefined mapping is a no-op', () => {
    assert.equal(reinsert('hello {{PII_EMAIL_1}}', undefined), 'hello {{PII_EMAIL_1}}');
    assert.equal(reinsert('hello', {}), 'hello');
  });
});
