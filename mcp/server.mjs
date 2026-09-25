#!/usr/bin/env node
// Desanatization MCP server — puts PII sanitization inside any MCP-speaking
// agent (Claude Code, Claude Desktop, Cursor, Windsurf, …) as a native tool.
//
// WHY THIS EXISTS
//
// The Bazaar and the .well-known documents make this service *discoverable*
// by an agent that already knows to go looking for x402 resources. That is a
// small population. The large population is agents whose operator installs
// tools by pasting a few lines into a config file. MCP is how that happens,
// and a manifest at /.well-known/mcp.json is not something any host can
// install — it describes a server, it isn't one. This is the server.
//
// TWO MODES, AND THE FREE ONE NEEDS NOTHING
//
//   Trial mode (default): no wallet, no keys, no dependencies beyond Node.
//   Calls POST /api/sanitize/trial, which sanitizes the first 500 characters
//   for free. An operator can install this and get a working tool in under a
//   minute, which is the only way a paid API ever gets evaluated.
//
//   Paid mode: set either DESANATIZATION_EVM_PRIVATE_KEY or the CDP Server
//   Wallet trio, and the same tools transparently pay $0.01 per full job over
//   x402. The payment libraries are imported lazily, only when credentials
//   are actually present, so trial mode stays dependency-free.
//
// The upgrade path is the product pitch: the tool an operator already uses
// starts truncating at 500 characters, and the fix is one environment
// variable. Nobody has to be sold on the concept first.
//
// Usage:
//   node mcp/server.mjs                 # stdio MCP server, trial mode
//   DESANATIZATION_BASE_URL=… node mcp/server.mjs

const DEFAULT_BASE_URL = 'https://desanatization-production.up.railway.app';

/** MCP revisions this server implements. Newest first. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** Trial cap enforced server-side; mirrored here only to describe the tools. */
const TRIAL_CHAR_LIMIT = 500;

/** Matches the service's own batch ceiling. */
const BATCH_MAX_ITEMS = 10;

/**
 * Build the tool list. Descriptions are written for a model deciding whether
 * to call them, not for a human reading docs — they state the cost and the
 * limit up front, because a tool that surprises an agent with a truncated
 * result or a charge gets abandoned.
 *
 * @param {boolean} paidReady - Whether payment credentials are configured
 * @returns {object[]} MCP tool descriptors
 */
function buildTools(paidReady) {
  const paidNote = paidReady
    ? 'Payment is configured, so this runs the full paid job ($0.01 in USDC on Base).'
    : `No payment is configured, so this runs the free trial and only the first ${TRIAL_CHAR_LIMIT} characters are sanitized. ` +
      'Set DESANATIZATION_EVM_PRIVATE_KEY or the CDP_* Server Wallet variables to process full-length text.';

  return [
    {
      name: 'sanitize_text',
      description:
        'Redact personally identifiable information from text: email addresses, phone numbers, ' +
        'US SSNs, credit-card numbers, private keys, Bearer tokens and secrets in URL query ' +
        'strings. Deterministic — the same input always produces the same output, and nothing is ' +
        'sent to a language model. Returns the cleaned text plus a count of what was removed per ' +
        `class. ${paidNote}`,
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            maxLength: 20000,
            description: 'The text to redact.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'sanitize_batch',
      description:
        `Redact PII from up to ${BATCH_MAX_ITEMS} texts in a single call, settling one payment ` +
        'instead of one per text. Cheaper per text than calling sanitize_text repeatedly. ' +
        'Requires payment credentials — there is no free trial for the batch route.',
      inputSchema: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: BATCH_MAX_ITEMS,
            description: 'The texts to redact.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'sanitize_status',
      description:
        'Report which mode this tool is in (free trial or paid), the live per-call price, and the ' +
        'payment terms the service currently advertises. Costs nothing and moves no money. Call ' +
        'this when a sanitize call was truncated, or before a batch, to see what is configured.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
}

/**
 * Resolve a payment-capable fetch, or null when no credentials are present.
 *
 * Both branches keep the signing key out of this process where possible: the
 * CDP branch never holds a key at all (Coinbase signs), and the raw-key branch
 * exists only because some operators have no CDP project. The import is lazy
 * so that trial mode never needs these packages installed.
 *
 * @param {object} env - Environment to read credentials from
 * @returns {Promise<{fetch: Function, kind: string}|null>} Paying fetch
 */
async function loadPaidFetch(env) {
  const maxPerPayment = env.DESANATIZATION_MAX_PER_PAYMENT || '$0.25';

  if (env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET && env.CDP_WALLET_SECRET) {
    const { CdpX402Client } = await import('@coinbase/cdp-sdk/x402');
    const { wrapFetchWithPayment } = await import('@x402/fetch');
    const client = new CdpX402Client({});
    client.setSpendControls?.({ maxAmountPerPayment: maxPerPayment });
    return { fetch: wrapFetchWithPayment(fetch, client), kind: 'cdp-server-wallet' };
  }

  const key = env.DESANATIZATION_EVM_PRIVATE_KEY;
  if (key) {
    const { privateKeyToAccount } = await import('viem/accounts');
    const { x402Client, wrapFetchWithPayment } = await import('@x402/fetch');
    const { ExactEvmScheme } = await import('@x402/evm/exact/client');
    const network = env.DESANATIZATION_NETWORK || 'eip155:8453';
    const client = new x402Client();
    client.setSpendControls({ maxAmountPerPayment: maxPerPayment });
    client.register(network, new ExactEvmScheme(privateKeyToAccount(key)));
    return { fetch: wrapFetchWithPayment(fetch, client), kind: 'local-key' };
  }

  return null;
}

/**
 * Create the MCP server's message handler.
 *
 * Kept separate from the stdio plumbing so the protocol can be exercised
 * directly in tests without spawning a process or faking a pipe.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] - Service base URL
 * @param {Function} [options.fetchImpl] - fetch used for unpaid calls
 * @param {object|null} [options.paidFetch] - Result of loadPaidFetch()
 * @returns {{handle: (message: object) => Promise<object|null>}} Handler
 */
export function createMcpServer({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  paidFetch = null,
} = {}) {
  const root = baseUrl.replace(/\/+$/, '');
  const paidReady = Boolean(paidFetch);
  const pay = paidFetch?.fetch ?? fetchImpl;

  /**
   * POST JSON and return the parsed body plus status.
   *
   * @param {Function} doFetch - fetch implementation to use
   * @param {string} path - Path under the service root
   * @param {object} body - JSON body
   * @returns {Promise<{status: number, body: any}>} Response
   */
  async function postJson(doFetch, path, body) {
    const response = await doFetch(`${root}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
  }

  /**
   * Render a tool result. MCP hosts show `content`; `structuredContent` is
   * what a model reads programmatically, so both carry the same facts.
   *
   * @param {object} payload - Structured result
   * @param {boolean} [isError] - Whether this is a tool-level failure
   * @returns {object} MCP tool result
   */
  function toolResult(payload, isError = false) {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      ...(isError ? { isError: true } : {}),
    };
  }

  /**
   * Run one tool.
   *
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   * @returns {Promise<object>} MCP tool result
   */
  async function callTool(name, args) {
    if (name === 'sanitize_text') {
      const text = args?.text;
      if (typeof text !== 'string' || text.length === 0) {
        return toolResult({ error: 'The `text` argument is required and must be a non-empty string.' }, true);
      }

      if (!paidReady) {
        const { status, body } = await postJson(fetchImpl, '/api/sanitize/trial', { text });
        if (status !== 200) {
          return toolResult({ error: 'The free trial endpoint rejected the request.', status, body }, true);
        }
        return toolResult({
          clean: body.clean,
          redactions: body.redactions,
          mode: 'free-trial',
          // Surfaced explicitly: a silently truncated result is the single
          // most damaging thing a sanitizer can return, because the caller
          // believes the tail was checked and it was not.
          truncated: Boolean(body.truncated),
          charsProcessed: body.trialChars,
          ...(body.truncated
            ? {
                warning:
                  `Only the first ${TRIAL_CHAR_LIMIT} characters were sanitized. The rest of the ` +
                  'text was NOT checked for PII. Configure payment to process it in full.',
              }
            : {}),
        });
      }

      const { status, body } = await postJson(pay, '/api/resource', { text });
      if (status !== 200) {
        return toolResult({ error: 'The paid request did not complete.', status, body }, true);
      }
      return toolResult({
        clean: body.clean,
        redactions: body.redactions,
        mode: 'paid',
        truncated: false,
        charsProcessed: body.inputChars,
      });
    }

    if (name === 'sanitize_batch') {
      const items = args?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return toolResult({ error: 'The `items` argument is required and must be a non-empty array of strings.' }, true);
      }
      if (items.length > BATCH_MAX_ITEMS) {
        return toolResult(
          { error: `The batch route accepts at most ${BATCH_MAX_ITEMS} items; got ${items.length}.` },
          true,
        );
      }
      if (!paidReady) {
        return toolResult(
          {
            error: 'The batch route has no free trial and no payment credentials are configured.',
            remedy:
              'Set DESANATIZATION_EVM_PRIVATE_KEY, or CDP_API_KEY_ID + CDP_API_KEY_SECRET + ' +
              'CDP_WALLET_SECRET, then restart this MCP server. Or call sanitize_text once per ' +
              'item to use the free trial.',
          },
          true,
        );
      }
      const { status, body } = await postJson(pay, '/api/sanitize/batch', { items });
      if (status !== 200) {
        return toolResult({ error: 'The paid batch request did not complete.', status, body }, true);
      }
      return toolResult({ results: body.results ?? body, mode: 'paid' });
    }

    if (name === 'sanitize_status') {
      // Read the live 402 rather than reciting a price compiled in here: the
      // terms are whatever the server says today, and a stale hardcoded price
      // is exactly the failure mode that stalls x402 sales.
      let terms = null;
      let reachable = false;
      try {
        const response = await fetchImpl(`${root}/api/resource`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'status probe' }),
        });
        reachable = true;
        if (response.status === 402) {
          const body = await response.json();
          terms = body?.accepts?.[0] ?? null;
        }
      } catch (error) {
        return toolResult(
          { error: `Could not reach ${root}: ${error?.message ?? error}`, mode: paidReady ? 'paid' : 'free-trial' },
          true,
        );
      }

      return toolResult({
        mode: paidReady ? 'paid' : 'free-trial',
        paymentMethod: paidFetch?.kind ?? 'none',
        serviceReachable: reachable,
        trialCharLimit: TRIAL_CHAR_LIMIT,
        batchMaxItems: BATCH_MAX_ITEMS,
        liveTerms: terms
          ? {
              price: terms.price,
              amount: terms.amount,
              network: terms.network,
              payTo: terms.payTo,
              asset: terms.asset,
            }
          : null,
        ...(paidReady
          ? {}
          : {
              upgrade:
                'Free trial covers the first 500 characters per call. To process full-length ' +
                'text and use sanitize_batch, set DESANATIZATION_EVM_PRIVATE_KEY (a funded Base ' +
                'wallet) or the CDP_* Server Wallet variables, then restart this server.',
            }),
      });
    }

    return toolResult({ error: `Unknown tool: ${name}` }, true);
  }

  /**
   * Handle one JSON-RPC message.
   *
   * @param {object} message - Decoded JSON-RPC request or notification
   * @returns {Promise<object|null>} Response, or null for notifications
   */
  async function handle(message) {
    const { id, method, params } = message ?? {};
    const isNotification = id === undefined || id === null;

    /**
     * @param {object} result - JSON-RPC result payload
     * @returns {object|null} Response envelope
     */
    const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
    /**
     * @param {number} code - JSON-RPC error code
     * @param {string} msg - Error message
     * @returns {object|null} Error envelope
     */
    const fail = (code, msg) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: msg } });

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        return ok({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'desanatization', version: '1.0.0' },
          instructions:
            'Sanitize text containing PII before logging it, storing it, or sending it to another ' +
            'model or third-party API. Call sanitize_status first if you need to know whether ' +
            'this server is in free-trial or paid mode.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: buildTools(paidReady) });
      case 'tools/call': {
        const name = params?.name;
        if (typeof name !== 'string') return fail(-32602, 'params.name is required');
        try {
          return ok(await callTool(name, params?.arguments ?? {}));
        } catch (error) {
          // A thrown error becomes a tool-level failure, not a protocol
          // error: the host should show the model what went wrong so it can
          // adapt, rather than tearing down the session.
          return ok(toolResult({ error: error?.message ?? String(error) }, true));
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  return { handle };
}

/**
 * Wire the handler to stdio using newline-delimited JSON-RPC, the MCP stdio
 * transport. Diagnostics go to stderr — anything on stdout that is not a
 * JSON-RPC message corrupts the stream and the host drops the connection.
 *
 * @returns {Promise<void>} Resolves when stdin closes
 */
export async function main() {
  const baseUrl = process.env.DESANATIZATION_BASE_URL || DEFAULT_BASE_URL;

  let paidFetch = null;
  try {
    paidFetch = await loadPaidFetch(process.env);
  } catch (error) {
    process.stderr.write(
      `desanatization-mcp: payment credentials are set but the payment libraries failed to load ` +
        `(${error?.message ?? error}). Continuing in free-trial mode.\n`,
    );
  }

  const server = createMcpServer({ baseUrl, paidFetch });
  process.stderr.write(
    `desanatization-mcp: ${paidFetch ? `paid mode (${paidFetch.kind})` : 'free-trial mode'} against ${baseUrl}\n`,
  );

  let buffer = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
        );
        continue;
      }

      const response = await server.handle(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

// Only run when executed directly, so importing this module in a test does
// not seize stdin.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`desanatization-mcp: fatal ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
