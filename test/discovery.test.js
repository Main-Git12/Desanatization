// ============================================================================
// Machine Discovery Tests
//
// An x402 service that cannot describe itself to an automated crawler earns
// nothing: research over 1,400 indexed x402 services found that missing
// /.well-known discovery files was the single most common reason services were
// graded unusable by agents. These tests pin the discovery surface so a
// refactor can never quietly 404 it back into invisibility.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/boot.js';

/** Every discovery path an agent, MCP client or directory crawler may probe. */
const DISCOVERY_PATHS = [
  '/.well-known/x402',
  '/.well-known/x402.json',
  '/.well-known/x402-bazaar',
  '/.well-known/mcp.json',
  '/.well-known/agent.json',
];

describe('machine discovery', () => {
  test('every discovery path answers 200 with parseable JSON', async () => {
    const server = await startTestServer();
    try {
      for (const path of DISCOVERY_PATHS) {
        const response = await server.fetch(path);
        assert.equal(response.status, 200, `${path} must exist — agents probe it first`);
        assert.match(
          response.headers.get('content-type') ?? '',
          /application\/json/,
          `${path} must be JSON, not HTML`,
        );
        // Parseability is the whole point: malformed JSON is as bad as a 404.
        const body = await response.json();
        assert.equal(typeof body, 'object');
        assert.ok(body !== null, `${path} must not be a bare null`);
      }
    } finally {
      await server.close();
    }
  });

  test('the x402 discovery document carries the facts a buyer needs', async () => {
    const server = await startTestServer();
    try {
      const doc = await (await server.fetch('/.well-known/x402.json')).json();

      assert.equal(doc.name, 'Desanatization');
      assert.match(doc.serviceUrl, /^https?:\/\//);
      assert.ok(doc.description.length > 40, 'a real description, not a stub');

      // The wallet and network must match the live configuration, or an agent
      // would pay the wrong address on the wrong chain.
      assert.equal(doc.wallet, server.config.payToAddress);
      assert.equal(doc.pricing.standard.network, server.config.network);
      assert.equal(doc.pricing.standard.price, server.config.price);
      assert.equal(doc.paymentMethods[0].protocol, 'x402');
      assert.equal(doc.paymentMethods[0].version, 2);

      // The paid product must be listed and payable.
      const paid = doc.resources.find((r) => r.url.endsWith('/api/resource'));
      assert.ok(paid, 'the paid resource must be advertised');
      assert.equal(paid.accepts[0].payTo, server.config.payToAddress);
      assert.equal(paid.accepts[0].scheme, 'exact');
      assert.ok(Array.isArray(paid.tags) && paid.tags.includes('pii'), 'discovery tags help search');

      // The free trial must be advertised so an agent can evaluate us for free.
      assert.ok(
        doc.resources.some((r) => r.url.endsWith('/api/sanitize/trial')),
        'the free trial must be advertised — it is the top of the funnel',
      );
    } finally {
      await server.close();
    }
  });

  test('the MCP manifest exposes callable tools with payment terms', async () => {
    const server = await startTestServer();
    try {
      const manifest = await (await server.fetch('/.well-known/mcp.json')).json();

      assert.equal(manifest.mcpVersion, '1.0');
      assert.ok(Array.isArray(manifest.tools) && manifest.tools.length >= 1);

      const tool = manifest.tools.find((t) => t.name === 'text_sanitize');
      assert.ok(tool, 'the primary tool must be named for agents to call it');
      assert.equal(tool.inputSchema.required[0], 'text');
      assert.equal(tool.payment.protocol, 'x402');
      assert.equal(tool.payment.payTo, server.config.payToAddress);
      assert.equal(tool.payment.network, server.config.network);

      // A batch tool is the volume buyer's entry point — keep it discoverable.
      assert.ok(manifest.tools.some((t) => t.name === 'text_sanitize_batch'));

      // The advertised transport has to be one an MCP client can actually
      // speak. This previously claimed `{ type: 'http', url: <paid route> }`
      // — a plain JSON endpoint behind a paywall, so any client that took the
      // manifest at its word got a 402 instead of a handshake and gave up.
      assert.equal(manifest.transport.type, 'stdio');
      assert.equal(manifest.transport.command, 'npx');
      assert.ok(manifest.transport.args.includes('desanatization-mcp'));
      assert.notEqual(
        manifest.transport.url,
        `${server.config.resource.path}`,
        'the paid REST route is not an MCP transport',
      );

      // …and the REST route is still described, labelled for what it is.
      assert.match(manifest.restEndpoint.url, /\/api\/resource$/);
      assert.equal(manifest.restEndpoint.protocol, 'x402');
      assert.match(manifest.install.claudeCode, /^claude mcp add /);
    } finally {
      await server.close();
    }
  });

  test('the agent card declares capabilities and a paid endpoint', async () => {
    const server = await startTestServer();
    try {
      const card = await (await server.fetch('/.well-known/agent.json')).json();

      assert.equal(card.name, 'Desanatization');
      assert.match(card.url, /^https?:\/\//);
      assert.ok(Array.isArray(card.skills) && card.skills.length >= 1);
      assert.equal(card.payment.protocol, 'x402');
      assert.equal(card.payment.payTo, server.config.payToAddress);
      assert.match(card.payment.paidEndpoint, /\/api\/resource$/);
      // Cross-links let a crawler walk our whole discovery surface.
      assert.match(card.discovery.mcp, /\.well-known\/mcp\.json$/);
      assert.match(card.discovery.x402, /\.well-known\/x402\.json$/);
    } finally {
      await server.close();
    }
  });

  test('discovery files are cacheable so crawlers do not re-fetch constantly', async () => {
    const server = await startTestServer();
    try {
      const response = await server.fetch('/.well-known/x402.json');
      assert.match(response.headers.get('cache-control') ?? '', /public/);
      assert.match(response.headers.get('cache-control') ?? '', /max-age=\d+/);
    } finally {
      await server.close();
    }
  });
});
