// ============================================================================
// Discovery Sources Tests
//
// Verifies that the expanded discovery sources (GitHub, Google Cloud Agent
// Gallery, Salesforce AgentExchange) correctly extract and collapse URLs,
// handle failures gracefully, and feed the growth engine's target pool.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseToOrigins,
  extractUrls,
  discoverFromGitHub,
  discoverFromGoogleCloudAgentGallery,
  discoverFromSalesforceAgentExchange,
  discoverAll,
} from '../discoveries.js';

describe('discovery sources', () => {
  test('collapseToOrigins deduplicates and normalizes to https://host', () => {
    const origins = collapseToOrigins([
      'https://api.example.com/foo',
      'https://api.example.com/bar?x=1',
      'http://example.com/page',
      'not-a-url',
      '',
      null,
      undefined,
      'https://api.example.com/',
    ]);
    assert.deepEqual(origins.sort(), [
      'http://example.com',
      'https://api.example.com',
    ]);
  });

  test('collapseToOrigins ignores non-http schemes', () => {
    const origins = collapseToOrigins([
      'ftp://files.example.com/data',
      'mailto:admin@example.com',
      'https://api.example.com/resource',
    ]);
    assert.deepEqual(origins, ['https://api.example.com']);
  });

  test('extractUrls finds all http(s) URLs in text', () => {
    const text = `
      Check out https://api.example.com for docs.
      Also visit http://docs.example.org/v1 and https://api.example.com again.
      Email us at admin@example.com or FTP to ftp://files.example.net.
    `;
    const urls = extractUrls(text);
    assert.ok(urls.includes('https://api.example.com'));
    assert.ok(urls.includes('http://docs.example.org/v1'));
    assert.ok(!urls.includes('ftp://files.example.net'));
    // Deduplicated
    assert.equal(urls.filter((u) => u === 'https://api.example.com').length, 1);
  });

  test('extractUrls handles empty or non-string input', () => {
    assert.deepEqual(extractUrls(''), []);
    assert.deepEqual(extractUrls(null), []);
    assert.deepEqual(extractUrls(123), []);
  });

  test('extractUrls strips trailing punctuation from URLs', () => {
    const urls = extractUrls('See https://example.com/page. And https://other.com/path)');
    assert.equal(urls[0], 'https://example.com/page');
    assert.equal(urls[1], 'https://other.com/path');
  });
});

describe('github discovery', () => {
  test('discoverFromGitHub returns an array (best-effort, no network in test)', async () => {
    // Without a token, GitHub may rate-limit us; the function must never throw.
    const results = await discoverFromGitHub({ query: 'x402', perPage: 1 });
    assert.ok(Array.isArray(results));
  });

  test('discoverFromGitHub degrades gracefully on failure', async () => {
    // Force a failure by using an unresolvable URL via a bad query.
    const results = await discoverFromGitHub({ query: '', perPage: 0 });
    assert.ok(Array.isArray(results));
  });
});

describe('google cloud agent gallery discovery', () => {
  test('discoverFromGoogleCloudAgentGallery returns an array (best-effort)', async () => {
    const results = await discoverFromGoogleCloudAgentGallery();
    assert.ok(Array.isArray(results));
  });
});

describe('salesforce agent exchange discovery', () => {
  test('discoverFromSalesforceAgentExchange returns an array (best-effort)', async () => {
    const results = await discoverFromSalesforceAgentExchange();
    assert.ok(Array.isArray(results));
  });
});

describe('composite discovery', () => {
  test('discoverAll runs all sources and merges results without throwing', async () => {
    const log = [];
    const results = await discoverAll({ log: (msg) => log.push(msg) });
    assert.ok(Array.isArray(results));
    // All results should be valid https origins
    for (const origin of results) {
      assert.match(origin, /^https?:\/\//);
    }
  });

  test('discoverAll skips disabled sources', async () => {
    const results = await discoverAll({
      github: false,
      googleCloud: false,
      salesforce: false,
      bazaar: false,
      x402docs: false,
      agentDirs: false,
    });
    assert.deepEqual(results, []);
  });
});
