# ⚡ Quick Start — live on Railway in ~5 minutes

## 1. Get a wallet address to be paid at

Any EVM wallet (MetaMask, Coinbase Wallet, Rabby…). Copy its public address —
that is your `PAY_TO_ADDRESS`. Never put a private key in the server environment.

## 2. Deploy

### Option A — Railway dashboard

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**.
2. Select `pealar12/Desanatization`. Nixpacks builds it automatically.
3. Railway runs `npm start` and probes `/health`.

### Option B — Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## 3. Set environment variables

In the Railway dashboard → your service → **Variables**:

| Key | Value |
| --- | --- |
| `PAY_TO_ADDRESS` | **your** wallet address |
| `NETWORK` | `eip155:84532` for a testnet, `eip155:8453` for real USDC |
| `PRICE` | `$0.001` |
| `FACILITATOR_URL` | `https://x402.org/facilitator` (testnet) — see the README for mainnet |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |
| `ALLOWED_ORIGINS` | `*`, or your site's origin |

Do **not** set `PORT` — Railway provides it.

## 4. Verify

Railway gives you a URL such as
`https://desanatization-production.up.railway.app`.

```bash
# Liveness — must be 200
curl https://YOUR-APP.up.railway.app/health

# Readiness — 200 means the facilitator handshake succeeded and you can be paid
curl https://YOUR-APP.up.railway.app/ready

# Discovery — shows price, network and your pay-to address
curl https://YOUR-APP.up.railway.app/

# The paid endpoint — 402 with a payment challenge and no payment
curl -i https://YOUR-APP.up.railway.app/api/resource
```

If `/ready` is not 200, the response body tells you exactly which facilitator
call failed. That is the fastest way to find a bad `FACILITATOR_URL`, `NETWORK`
or missing provider API key.

## 5. Watch the money

```bash
curl https://YOUR-APP.up.railway.app/api/metrics
```

Look for `settledPayments` and `revenueAtomicByAsset` (atomic USDC units: `1000`
= `0.001` USDC). Set `METRICS_TOKEN` to require
`Authorization: Bearer <token>` on this endpoint.

## 6. Tell buyers how to pay

Send them the working client:

```bash
EVM_PRIVATE_KEY=0x<their-wallet-key> \
RESOURCE_URL=https://YOUR-APP.up.railway.app/api/resource \
node clients/fetch-client.mjs
```

Or give them the protocol essentials:

- Ask for the resource; read the `PAYMENT-REQUIRED` header from the `402`.
- Sign an `exact` payment for the requested network, amount and `payTo`.
- Retry with the signed payload in the `PAYMENT-SIGNATURE` header.
- Read the settlement receipt from the `PAYMENT-RESPONSE` header.

Their agent's own x402 client library handles all of this automatically.

## Going live for real money

The defaults are deliberately on a **testnet** — nothing of value moves. When
you are ready to earn real USDC, follow
[Going live for real money](README.md#going-live-for-real-money-base-mainnet):
switch `NETWORK` to `eip155:8453`, move to a production facilitator, and confirm
`PAY_TO_ADDRESS` is your own wallet.
