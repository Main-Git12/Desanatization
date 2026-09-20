# Desanatization MCP server

Redact PII — emails, phone numbers, SSNs, credit-card numbers, private keys,
Bearer tokens, secrets in URL query strings — from any text your agent is about
to log, store, or hand to another model.

Deterministic: same input, same output, no language model involved, nothing
retained.

**The free trial needs no wallet, no keys, and no dependencies.** Install it and
it works.

## Install

### Claude Code

```bash
claude mcp add desanatization -- npx -y desanatization-mcp
```

### Claude Desktop / Cursor / Windsurf

Add to your MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "desanatization": {
      "command": "npx",
      "args": ["-y", "desanatization-mcp"]
    }
  }
}
```

### From a clone

```bash
git clone https://github.com/Main-Git12/Desanatization.git
```

```json
{
  "mcpServers": {
    "desanatization": {
      "command": "node",
      "args": ["/absolute/path/to/Desanatization/mcp/server.mjs"]
    }
  }
}
```

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `sanitize_text` | Redact PII from one string | Free for the first 500 characters; `$0.01` for the full job once payment is configured |
| `sanitize_batch` | Redact up to 10 strings in **one** settlement | `$0.08` — needs payment configured |
| `sanitize_status` | Report trial-vs-paid mode and read the live price off the service | Free |

`sanitize_text` never silently half-checks text. If the trial truncated the
input, the result says so explicitly and warns that the remainder was **not**
scanned.

## Paying for full-length text

Free trial covers the first 500 characters per call. To process longer text and
to use `sanitize_batch`, give the server a way to pay `$0.01` per call in USDC
on Base.

Install the payment libraries once (they are optional peer dependencies, so
they are not pulled in for trial-only use):

```bash
npm install @x402/fetch @x402/evm viem
```

Then pick **one** of the two credential styles.

### Coinbase CDP Server Wallet (recommended)

The signing key is created and held on Coinbase's infrastructure. Nothing that
can move money is ever stored on your machine or printed to your terminal.

```json
{
  "mcpServers": {
    "desanatization": {
      "command": "npx",
      "args": ["-y", "desanatization-mcp"],
      "env": {
        "CDP_API_KEY_ID": "…",
        "CDP_API_KEY_SECRET": "…",
        "CDP_WALLET_SECRET": "…"
      }
    }
  }
}
```

Generate all three in the [CDP portal](https://portal.cdp.coinbase.com)
(API Keys, then Server Wallets for the wallet secret).

### A local key

Only if you have no CDP project. Use a **dedicated** wallet funded with a few
dollars of USDC — never a wallet holding anything you would mind losing, and
never a seed phrase.

```json
"env": { "DESANATIZATION_EVM_PRIVATE_KEY": "0x…" }
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DESANATIZATION_BASE_URL` | the hosted service | Point at your own deployment |
| `DESANATIZATION_MAX_PER_PAYMENT` | `$0.25` | Hard ceiling on any single payment, enforced client-side regardless of what the server asks for |
| `DESANATIZATION_NETWORK` | `eip155:8453` (Base) | Network for the local-key mode |

The spend ceiling is applied independently of the payment challenge, so a
misbehaving or spoofed endpoint cannot talk this client into a large payment.

## How the payment works

[x402](https://x402.org) is an open payment protocol over plain HTTP. The
service answers an unpaid request with `402 Payment Required` and machine-
readable terms; the client signs an EIP-3009 authorization for exactly that
amount and retries. No account, no API key, no subscription, no invoice — the
first call from a funded wallet succeeds.

## Releasing (maintainers)

Two steps, in order. The npm package must exist first, because the registry
verifies ownership by reading `mcpName` out of the published package.

```bash
cd mcp
npm publish                 # publishes `desanatization-mcp`
mcp-publisher login github  # authenticate as the io.github.main-git12 namespace
mcp-publisher publish       # submits server.json to the official MCP registry
```

`server.json`'s `name` and `package.json`'s `mcpName` must stay identical —
that pairing is the ownership proof, and a mismatch fails validation.

Both are currently `io.github.main-git12/desanatization`, matching the
repository owner. If you authenticate as a personal account rather than the
organization, the namespace has to change to `io.github.<your-username>/…` in
**both** files or the publish is rejected.

Bump `version` in `package.json` and `server.json` together on every release.

## License

MIT
