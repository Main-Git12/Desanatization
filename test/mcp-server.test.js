// ============================================================================
// MCP Server Tests
//
// The MCP server is a distribution channel: if the handshake is wrong, every
// host silently drops the connection and the tool never appears, with no
// error anyone would see. These drive the real handler over real JSON-RPC
// messages so a protocol regression fails the build.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMcpServer } from '../mcp/server.mjs';

const BASE = 'https://service.example';

/**
 * Build a fetch stub that records calls and replays canned responses.
 *
 * @param {Record<string, {status?: number, body: object}>} routes - Path -> response
 * @returns {Function & {calls: object[]}} Stub fetch
 */
function stubFetch(routes) {
  /**
   * @param {string} url - Requested URL
   * @param {object} [init] - Request init
   * @returns {Promise<Response>} Canned response
   */
  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    impl.calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[path];
    if (!route) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  impl.calls = [];
  return impl;
}

/**
 * Send one request to a server and return the JSON-RPC result.
 *
 * @param {object} server - Server from createMcpServer
 * @param {string} method - JSON-RPC method
 * @param {object} [params] - Params
 * @returns {Promise<any>} The `result` field
 */
async function call(server, method, params) {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method, params });
  return response?.result;
}

describe('MCP server', () => {
  test('initialize completes the handshake with tool capability', async () => {
    const server = createMcpServer({ baseUrl: BASE, fetchImpl: stubFetch({}) });
    const result = await call(server, 'initialize', { protocolVersion: '2025-06-18' });

    assert.equal(result.protocolVersion, '2025-06-18');
    assert.ok(result.capabilities.tools, 'must advertise tools or no tool is ever listed');
    assert.equal(result.serverInfo.name, 'desanatization');
    assert.match(result.instructions, /sanitize/i);
  });

  test('initialize falls back to a supported version when the client asks for an unknown one', async () => {
    const server = createMcpServer({ baseUrl: BASE, fetchImpl: stubFetch({}) });
    const result = await call(server, 'initialize', { protocolVersion: '1999-01-01' });
    assert.equal(result.protocolVersion, '2025-06-18');
  });

  test('notifications get no reply, because replying to one desynchronises the stream', async () => {
    const server = createMcpServer({ baseUrl: BASE, fetchImpl: stubFetch({}) });
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  });

  test('an unknown method returns method-not-found rather than hanging', async () => {
    const server = createMcpServer({ baseUrl: BASE, fetchImpl: stubFetch({}) });
    const response = await server.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
    assert.equal(response.error.code, -32601);
    assert.equal(response.id, 7);
  });

  test('tools/list advertises all three tools and names the trial limit when unpaid', async () => {
    const server = createMcpServer({ baseUrl: BASE, fetchImpl: stubFetch({}) });
    const { tools } = await call(server, 'tools/list');

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['sanitize_batch', 'sanitize_status', 'sanitize_text'],
    );
    const sanitizeText = tools.find((tool) => tool.name === 'sanitize_text');
    assert.match(sanitizeText.description, /first 500 characters/);
    assert.equal(sanitizeText.inputSchema.required[0], 'text');
  });

  test('tools/list stops advertising the trial limit once payment is configured', async () => {
    const server = createMcpServer({
      baseUrl: BASE,
      fetchImpl: stubFetch({}),
      paidFetch: { fetch: stubFetch({}), kind: 'local-key' },
    });
    const { tools } = await call(server, 'tools/list');
    const sanitizeText = tools.find((tool) => tool.name === 'sanitize_text');
    assert.match(sanitizeText.description, /full paid job/);
    assert.doesNotMatch(sanitizeText.description, /only the first/);
  });

  test('sanitize_text uses the free trial when no payment is configured', async () => {
    const fetchImpl = stubFetch({
      '/api/sanitize/trial': {
        body: {
          clean: 'Contact [redacted-email]',
          redactions: { emails: 1 },
          trial: true,
          trialChars: 24,
          truncated: false,
        },
      },
    });
    const server = createMcpServer({ baseUrl: BASE, fetchImpl });
    const result = await call(server, 'tools/call', {
      name: 'sanitize_text',
      arguments: { text: 'Contact jane@example.com' },
    });

    assert.equal(fetchImpl.calls[0].path, '/api/sanitize/trial');
    assert.equal(result.structuredContent.clean, 'Contact [redacted-email]');
    assert.equal(result.structuredContent.mode, 'free-trial');
    assert.equal(result.structuredContent.truncated, false);
    assert.ok(!result.isError);
  });

  test('a truncated trial says so loudly, because a silent half-check is worse than a failure', async () => {
    const fetchImpl = stubFetch({
      '/api/sanitize/trial': {
        body: { clean: 'x', redactions: {}, trial: true, trialChars: 500, truncated: true },
      },
    });
    const server = createMcpServer({ baseUrl: BASE, fetchImpl });
    const result = await call(server, 'tools/call', {
      name: 'sanitize_text',
      arguments: { text: 'y'.repeat(900) },
    });

    assert.equal(result.structuredContent.truncated, true);
    assert.match(result.structuredContent.warning, /NOT checked for PII/);
  });

  test('sanitize_text pays for the full job once payment is configured', async () => {
    const paying = stubFetch({
      '/api/resource': { body: { clean: 'clean text', redactions: { emails: 2 }, inputChars: 900 } },
    });
    const server = createMcpServer({
      baseUrl: BASE,
      fetchImpl: stubFetch({}),
      paidFetch: { fetch: paying, kind: 'cdp-server-wallet' },
    });
    const result = await call(server, 'tools/call', {
      name: 'sanitize_text',
      arguments: { text: 'z'.repeat(900) },
    });

    assert.equal(paying.calls[0].path, '/api/resource');
    assert.equal(result.structuredContent.mode, 'paid');
    assert.equal(result.structuredContent.charsProcessed, 900);
    assert.equal(result.structuredContent.truncated, false);
  });

  test('a rejected paid call reports the status instead of pretending it succeeded', async () => {
    const paying = stubFetch({ '/api/resource': { status: 402, body: { error: 'Payment required' } } });
    const server = createMcpServer({
      baseUrl: BASE,
      fetchImpl: stubFetch({}),
      paidFetch: { fetch: paying, kind: 'local-key' },
    });
    const result = await call(server, 'tools/call', {
      name: 'sanitize_text',
      arguments: { text: 'hello' },
    });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 402);
  });

  test('sanitize_text rejects a missing argument without calling the service', async () => {
    const fetchImpl = stubFetch({});
    const server = createMcpServer({ baseUrl: BASE, fetchImpl });
    const result = await call(server, 'tools/call', { name: 'sanitize_text', arguments: {} });

    assert.equal(result.isError, true);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('sanitize_batch without payment explains exactly how to enable it', async () => {
    const server = createMcpServer({ baseUrl: BASE, fetchImpl: stubFetch({}) });
    const result = await call(server, 'tools/call', {
      name: 'sanitize_batch',
      arguments: { items: ['a', 'b'] },
    });

    assert.equal(result.isError, true);
    assert.match(result.structuredContent.remedy, /CDP_WALLET_SECRET/);
    assert.match(result.structuredContent.remedy, /sanitize_text/);
  });

  test('sanitize_batch refuses more items than the service accepts', async () => {
    const paying = stubFetch({});
    const server = createMcpServer({
      baseUrl: BASE,
      fetchImpl: stubFetch({}),
      paidFetch: { fetch: paying, kind: 'local-key' },
    });
    const result = await call(server, 'tools/call', {
      name: 'sanitize_batch',
      arguments: { items: Array.from({ length: 11 }, (_, index) => String(index)) },
    });

    assert.equal(result.isError, true);
    assert.equal(paying.calls.length, 0, 'an over-long batch must not be paid for');
  });

  test('sanitize_batch settles one paid call for many texts', async () => {
    const paying = stubFetch({
      '/api/sanitize/batch': { body: { results: [{ clean: 'a' }, { clean: 'b' }] } },
    });
    const server = createMcpServer({
      baseUrl: BASE,
      fetchImpl: stubFetch({}),
      paidFetch: { fetch: paying, kind: 'local-key' },
    });
    const result = await call(server, 'tools/call', {
      name: 'sanitize_batch',
      arguments: { items: ['a', 'b'] },
    });

    assert.equal(paying.calls.length, 1, 'a batch must settle once, not once per item');
    assert.equal(paying.calls[0].path, '/api/sanitize/batch');
    assert.equal(result.structuredContent.results.length, 2);
  });

  test('sanitize_status reports live terms read from the 402, not a compiled-in price', async () => {
    const fetchImpl = stubFetch({
      '/api/resource': {
        status: 402,
        body: {
          accepts: [
            {
              price: '$0.01',
              amount: '10000',
              network: 'eip155:8453',
              payTo: '0x79e6cdb37c20bec46156c81d0c274827eb2754e4',
              asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            },
          ],
        },
      },
    });
    const server = createMcpServer({ baseUrl: BASE, fetchImpl });
    const result = await call(server, 'tools/call', { name: 'sanitize_status', arguments: {} });

    assert.equal(result.structuredContent.mode, 'free-trial');
    assert.equal(result.structuredContent.paymentMethod, 'none');
    assert.equal(result.structuredContent.liveTerms.price, '$0.01');
    assert.equal(result.structuredContent.liveTerms.amount, '10000');
    assert.match(result.structuredContent.upgrade, /DESANATIZATION_EVM_PRIVATE_KEY/);
  });

  test('sanitize_status surfaces an unreachable service instead of reporting healthy', async () => {
    /**
     * @returns {Promise<never>} Always rejects
     */
    const offline = async () => {
      throw new Error('ECONNREFUSED');
    };
    const server = createMcpServer({ baseUrl: BASE, fetchImpl: offline });
    const result = await call(server, 'tools/call', { name: 'sanitize_status', arguments: {} });

    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /ECONNREFUSED/);
  });

  test('the registry descriptor and the npm package agree on identity and version', () => {
    // The MCP registry proves ownership by reading `mcpName` out of the
    // published npm package and matching it against server.json's `name`.
    // A drift between the two is not a warning — the publish is rejected,
    // and the only symptom is a failed release nobody sees until they try.
    const pkg = JSON.parse(readFileSync(new URL('../mcp/package.json', import.meta.url), 'utf8'));
    const server = JSON.parse(readFileSync(new URL('../mcp/server.json', import.meta.url), 'utf8'));

    assert.equal(server.name, pkg.mcpName, 'server.json name must equal package.json mcpName');
    assert.match(pkg.mcpName, /^io\.github\.[a-z0-9-]+\/[a-z0-9-]+$/);
    assert.equal(server.version, pkg.version, 'both files must be bumped together');

    const [npmPackage] = server.packages;
    assert.equal(npmPackage.identifier, pkg.name, 'the descriptor must point at this npm package');
    assert.equal(npmPackage.version, pkg.version);
    assert.equal(npmPackage.registryType, 'npm');
    assert.equal(npmPackage.transport.type, 'stdio');
  });

  test('an unknown tool name is a tool error, not a dropped connection', async () => {
    const server = createMcpServer({ baseUrl: BASE, fetchImpl: stubFetch({}) });
    const result = await call(server, 'tools/call', { name: 'delete_everything', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /Unknown tool/);
  });
});
