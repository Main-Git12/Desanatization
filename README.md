# Desanatization — x402 Payment-Gated API

An Express server that sells access to an endpoint for **USDC on Base**, using the
[x402 protocol v2](https://docs.x402.org) — the HTTP-native payment standard built
for AI agents and machine-to-machine commerce.

A client with no payment receives `402 Payment Required` plus machine-readable
requirements. A client that signs a payment receives the resource, and the money
lands in your wallet.

Verified path: `402 challenge → signed EIP-3009 payment → facilitator verify →
on-chain settle → 200 + settlement receipt`.

## Requirements

- Node.js **>= 20.12**
- An EVM wallet address to receive USDC
- A facilitator URL (the public testnet one needs no setup)

## Quick start

```bash
npm install
cp .env.example .env      # then set PAY_TO_ADDRESS to YOUR wallet
npm run dev
```

```bash
curl -i http://localhost:3000/health
curl -i http://localhost:3000/api/resource   # -> 402 with a payment challenge
```

## Endpoints

| Method & path | Paid | Purpose |
| --- | --- | --- |
| `GET /` | no | Service discovery: network, price, pay-to, endpoints |
| `GET /health` | no | Liveness for orchestrators; never fails on a downstream outage |
| `GET /ready` | no | Readiness: `200` only once the facilitator preflight succeeds |
| `GET /api/metrics` | no | Counters, latency percentiles, settled revenue (optionally token-protected) |
| `GET /api/resource` | **yes** | The paid resource (path configurable via `RESOURCE_PATH`) |

Unpaid requests to the paid endpoint return `402` with the requirements in the
`PAYMENT-REQUIRED` response header, mirrored in the JSON body so that clients
which are not yet x402-aware still get actionable instructions.

## How the payment flow works

```
client ──GET /api/resource─────────────────────────► server
client ─402 + PAYMENT-REQUIRED (scheme, network,──────┘
           amount, asset, payTo, maxTimeoutSeconds)

client signs an EIP-3009 authorisation for USDC

client ──GET /api/resource + PAYMENT-SIGNATURE─────► server
                                                      │ verify + settle
                                                      │ via facilitator
                                                      ▼
client ◄─200 + PAYMENT-RESPONSE (settlement receipt)──┘
```

- **Request header:** `PAYMENT-SIGNATURE` (legacy v1 `X-PAYMENT` also accepted)
- **402 challenge header:** `PAYMENT-REQUIRED` (base64 JSON)
- **Receipt header:** `PAYMENT-RESPONSE` (transaction, payer, amount)

The server holds no key and never touches the chain directly: a facilitator
verifies the signed authorisation and submits settlement, so there is no gas
management to do here.

## Buying from this API

```bash
EVM_PRIVATE_KEY=0x<your-wallet-key> \
RESOURCE_URL=https://your-app.up.railway.app/api/resource \
node clients/fetch-client.mjs
```

`clients/fetch-client.mjs` is a complete, dependency-light buyer using the
official `@x402/fetch` wrapper, including a per-payment spend cap. It reads the
key from the environment and never hardcodes it.

## Running the tests

```bash
npm test
```

The suite drives the **real** x402 middleware against a stub facilitator, so it
covers the 402 challenge contents, a full signed payment through verify and
settle, rejected payments, rate limiting, CORS, security headers and config
validation — all offline, with no network access and no USDC spent.
## Configuration

Every variable is validated at boot; all problems are reported at once, and the
process exits rather than serving traffic that can never be paid.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PAY_TO_ADDRESS` | **yes** | – | Your EVM wallet address (42 chars, `0x…`). USDC settles here |
| `NETWORK` | no | `eip155:84532` | CAIP-2: `eip155:8453` (Base), `eip155:84532` (Base Sepolia) |
| `PRICE` | no | `$0.001` | Dollar string resolved to the network's USDC, or JSON `{"asset":"0x…","amount":"1000"}` |
| `FACILITATOR_URL` | no | `https://x402.org/facilitator` | Verifies and settles payments (testnet only by default) |
| `FACILITATOR_AUTH_HEADER` | no | – | `Authorization` value for facilitators that require a key |
| `FACILITATOR_TIMEOUT_MS` | no | `20000` | Per-request facilitator timeout |
| `PAYMENT_TIMEOUT_SECONDS` | no | `300` | Validity window for a signed authorisation |
| `RESOURCE_PATH` | no | `/api/resource` | The protected route |
| `RESOURCE_DESCRIPTION` | no | `Protected API Resource` | Shown in the challenge |
| `SERVICE_NAME` | no | `Desanatization` | Shown in discovery and challenges |
| `PORT` / `HOST` | no | `3000` / `0.0.0.0` | Listen address |
| `NODE_ENV` | no | `development` | `production` enables strict-startup defaults |
| `LOG_LEVEL` | no | `info` | `error`, `warn`, `info`, `debug` |
| `TRUST_PROXY` | no | `true` | Honour `X-Forwarded-*` (needed behind Railway) |
| `ALLOWED_ORIGINS` | no | *(none)* | Comma-separated browser origins, or `*` |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | Rate limit window |
| `RATE_LIMIT_MAX_REQUESTS` | no | `60` | Requests per window, per IP |
| `SYNC_FACILITATOR_ON_START` | no | `true` | Fetch supported kinds at boot |
| `STRICT_STARTUP` | no | `true` in production | Exit at boot if the facilitator preflight fails |
| `METRICS_TOKEN` | no | – | Bearer token required by `GET /api/metrics` |

Legacy x402 v1 network names (`base`, `base-sepolia`, …) are accepted and
translated to CAIP-2 with a warning.

## Going live for real money (Base mainnet)

Base Sepolia is a testnet: payments there move no value. To earn real USDC:

1. **Point the server at Base mainnet**

   ```bash
   NETWORK=eip155:8453
   PRICE=$0.05
   ```

2. **Switch to a production facilitator.** The public `https://x402.org`
   facilitator only supports testnets; it cannot settle mainnet payments. Choose
   a production facilitator — for example
   [Coinbase CDP](https://docs.cdp.coinbase.com/x402/docs/quickstart-sellers) or
   [PayAI](https://facilitator.payai.network) — then set:

   ```bash
   FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
   FACILITATOR_AUTH_HEADER=Bearer <your-api-key>   # only if the provider needs one
   ```

3. **Set `PAY_TO_ADDRESS` to your own wallet.** If it is still the default the
   server logs a loud warning at boot: that is the x402 documentation demo
   address, and payments sent there are lost to you.

4. **Enable strict startup** so a broken facilitator configuration fails the
   deployment instead of silently earning nothing:

   ```bash
   NODE_ENV=production     # STRICT_STARTUP then defaults to true
   ```

5. **Verify, then watch revenue:**

   ```bash
   curl https://your-app.up.railway.app/ready     # 200 = able to take money
   curl -H "Authorization: Bearer $METRICS_TOKEN" \
        https://your-app.up.railway.app/api/metrics
   ```

Configuration mistakes that would stop you earning are caught at boot, and
`/ready` reports the facilitator handshake result in plain language.

## Deployment

### Railway

`railway.json` is included. The build uses Nixpacks and the healthcheck targets
`/health` (liveness only), so a facilitator outage can never trigger a deploy or
restart loop.

1. Create a project from this repository.
2. Add the environment variables from `.env.example` in the Railway dashboard —
   at minimum `PAY_TO_ADDRESS`.
3. Railway injects `PORT`; do not set it manually.
4. Model the app as an HTTP service with a public domain, and make sure Railway's
   target port matches the port the app logs at boot. A "no domain"/502 loop is
   almost always a port mismatch.

### Docker

```bash
docker build -t desanatization .
docker run -p 3000:3000 --env-file .env desanatization
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Paid endpoint returns `503` | The facilitator preflight has never succeeded. `GET /ready` shows the reason. Check `FACILITATOR_URL` and `NETWORK` |
| `502` from the facilitator | Reachable but rejected the call — usually a wrong or missing `FACILITATOR_AUTH_HEADER` for that provider |
| Always `402` even though the client pays | The client signs for a network the server does not price in. Compare the challenge `network` with the client's registered scheme |
| Payments not arriving | Confirm `PAY_TO_ADDRESS` is your wallet, that the facilitator settles on the same `NETWORK`, and check `/api/metrics` → `settledPayments` |
| Boot exits with `Invalid configuration` | Every problem is listed with the exact variable name |
| Payment succeeds but no receipt | A proxy is stripping the `PAYMENT-RESPONSE` header |

## Security notes

- No private keys server-side; the server never signs anything.
- `PAY_TO_ADDRESS` is validated as an EVM address at boot.
- Security headers (CSP, `nosniff`, frame denial, HSTS behind TLS) are applied.
- CORS is denied by default and, when configured, explicitly exposes the
  `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE` headers so browser clients can work.
- Rate limiting is global (health checks exempt) and counts unpaid 402 traffic,
  so scraping for free is not unlimited.
- Request bodies are capped at 64 KB and malformed JSON is rejected with 400.
- Secrets (`FACILITATOR_AUTH_HEADER`, `METRICS_TOKEN`) are never logged or
  returned by any endpoint.

## License

MIT