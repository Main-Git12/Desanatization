# Go-Live Runbook — from testnet to real money

The server is identical on testnet and mainnet. Only **variables** change.
Never flip networks blind: run the preflight gate after every change.

```bash
# Gate any deployment (local, Railway, anywhere):
npm run preflight -- https://desanatization-production.up.railway.app
```

Exit 0 = safe to send buyers. Any FAIL = fix before promoting traffic.

## Stage 1 — Testnet (LIVE now, free to iterate)

Railway variables:

```
PAY_TO_ADDRESS=0x<your-wallet>
NETWORK=eip155:84532
PRICE=$0.001
FACILITATOR_URL=https://x402.org/facilitator
NODE_ENV=production
ALLOWED_ORIGINS=*
METRICS_TOKEN=<random-32-chars>
```

To generate demand signals: fund a throwaway wallet at
<https://faucets.circle.com> (Base Sepolia USDC) and settle one payment —
that seeds your Bazaar catalog entry:

```bash
EVM_PRIVATE_KEY=0x<throwaway-key> \
RESOURCE_URL=https://desanatization-production.up.railway.app/api/resource \
npm run client
```

## Stage 2 — Mainnet (real USDC, real revenue)

**You must own these two things — no automation can create them for you:**

1. **A Coinbase Developer Platform account** with x402 enabled
   (<https://portal.cdp.coinbase.com>) → create an API key (id + secret).
2. **Your own EVM wallet** whose address you control. Put that address in
   `PAY_TO_ADDRESS` — every settlement lands there.

Then set exactly these Railway variables:

```
PAY_TO_ADDRESS=0x<your-real-wallet>          # not the demo address
NETWORK=eip155:8453
PRICE=$0.01                                  # not $0.001 — see PRICING_INTEL.md:
                                              # that's exactly the CDP facilitator's own
                                              # per-settlement fee, a 100% facilitator take
BATCH_PRICE=$0.10                            # /api/sanitize/batch — priced separately, not
                                              # the same flat price as a single text
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
FACILITATOR_AUTH_HEADERS={"X-CDP-API-KEY-ID":"<id>","X-CDP-API-KEY-SECRET":"<secret>"}
NODE_ENV=production
STRICT_STARTUP=true
# Then gate the flip before opening traffic (the gate must authenticate to CDP too):
#   PREFLIGHT_FACILITATOR_AUTH_HEADERS='{"X-CDP-API-KEY-ID":"<id>","X-CDP-API-KEY-SECRET":"<secret>"}' npm run preflight -- https://<your-app>
```

Notes:

* `NETWORK=eip155:8453` + `FACILITATOR_URL=x402.org` is now **refused at boot**
  — that combination can never settle (the public facilitator is testnet-only).
* `STRICT_STARTUP=true` (production default) makes any unreachable facilitator
  crash the deploy loudly instead of serving 402s that can never be paid.
* Price resolves to native mainnet USDC automatically. For a custom token:
  `PRICE={"asset":"0x<token>","amount":"<atomic-units>"}`.
* Rollback = set `NETWORK=eip155:84532` + public facilitator back and redeploy.

## Stage 3 — Prove revenue

```bash
npm run preflight -- https://<your-app>        # all PASS
curl https://<your-app>/receipts               # count > 0 = money moved
curl -H "Authorization: Bearer $METRICS_TOKEN" https://<your-app>/api/insights
```

`/receipts` lists on-chain settlement facts (tx, payer, amount). `/api/insights`
shows the funnel (trial → paid → batch), conversion rate, referral leaderboard,
and payment failure reasons — steer price and trial caps from there.
