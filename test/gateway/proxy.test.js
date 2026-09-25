// ============================================================================
// Gateway Proxy Tests: auth, PII never reaching the upstream provider, and
// reinsertion restoring real values in the response the caller gets back.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGatewayApp } from '../../gateway/proxy.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Starts an Express app on an ephemeral loopback port and waits for it to actually be listening. */
function listenOn(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/** Starts a stub "upstream provider" that echoes back whatever content it received (tokens included). */
function startStubUpstream() {
  let lastRequestBody = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      lastRequestBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'stub-1',
          choices: lastRequestBody.messages.map((m) => ({
            message: { role: 'assistant', content: `Echo: ${m.content}` },
          })),
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, getLastRequestBody: () => lastRequestBody });
    });
  });
}

describe('gateway proxy', () => {
  test('rejects requests without a valid gateway API key', async () => {
    const upstream = await startStubUpstream();
    const app = createGatewayApp({
      gatewayApiKey: 'correct-key',
      upstreamBaseUrl: upstream.baseUrl,
      upstreamApiKey: 'upstream-secret',
      logger: silentLogger,
    });
    const { server, port } = await listenOn(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-key' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(res.status, 401);
    } finally {
      server.close();
      upstream.server.close();
    }
  });

  test('tokenizes PII before it ever reaches the upstream provider, then reinserts it in the response', async () => {
    const upstream = await startStubUpstream();
    const app = createGatewayApp({
      gatewayApiKey: 'correct-key',
      upstreamBaseUrl: upstream.baseUrl,
      upstreamApiKey: 'upstream-secret',
      logger: silentLogger,
    });
    const { server, port } = await listenOn(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer correct-key' },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [
            { role: 'user', content: 'My email is jane@example.com, please reply to it.' },
            { role: 'user', content: 'Also my ssn is 123-45-6789.' },
          ],
        }),
      });
      assert.equal(res.status, 200);

      // The upstream provider must never see the raw PII.
      const upstreamBody = upstream.getLastRequestBody();
      const upstreamRaw = JSON.stringify(upstreamBody);
      assert.doesNotMatch(upstreamRaw, /jane@example\.com/);
      assert.doesNotMatch(upstreamRaw, /123-45-6789/);
      assert.match(upstreamBody.messages[0].content, /\{\{PII_EMAIL_1\}\}/);
      assert.match(upstreamBody.messages[1].content, /\{\{PII_SSN_1\}\}/);

      // The caller's response gets the real values back.
      const body = await res.json();
      assert.match(body.choices[0].message.content, /jane@example\.com/);
      assert.match(body.choices[1].message.content, /123-45-6789/);
    } finally {
      server.close();
      upstream.server.close();
    }
  });

  test('rejects a body without a messages array', async () => {
    const upstream = await startStubUpstream();
    const app = createGatewayApp({
      gatewayApiKey: 'correct-key',
      upstreamBaseUrl: upstream.baseUrl,
      upstreamApiKey: 'upstream-secret',
      logger: silentLogger,
    });
    const { server, port } = await listenOn(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer correct-key' },
        body: JSON.stringify({ foo: 'bar' }),
      });
      assert.equal(res.status, 400);
    } finally {
      server.close();
      upstream.server.close();
    }
  });

  test('returns 502 when the upstream provider is unreachable', async () => {
    const app = createGatewayApp({
      gatewayApiKey: 'correct-key',
      upstreamBaseUrl: 'http://127.0.0.1:1', // nothing listens on port 1
      upstreamApiKey: 'upstream-secret',
      logger: silentLogger,
    });
    const { server, port } = await listenOn(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer correct-key' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(res.status, 502);
    } finally {
      server.close();
    }
  });

  test('throws at construction time when required config is missing', () => {
    assert.throws(() => createGatewayApp({ upstreamBaseUrl: 'https://x.test', upstreamApiKey: 'k', logger: silentLogger }));
    assert.throws(() => createGatewayApp({ gatewayApiKey: 'k', upstreamApiKey: 'k', logger: silentLogger }));
    assert.throws(() => createGatewayApp({ gatewayApiKey: 'k', upstreamBaseUrl: 'https://x.test', logger: silentLogger }));
  });
});
