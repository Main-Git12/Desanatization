# 💰 Payment Guide — how agents pay you

This server implements **x402 v2**. Buyers pay in **USDC**; payments are verified
and settled by a **facilitator**, so the server itself holds no keys and never
signs a transaction.

## The flow

```
┌──────────┐  1. GET /api/resource                 ┌─────────────────────┐
│  Agent   │ ────────────────────────────────────► │  Desanatization     │
│ (buyer)  │ ◄──────────────────────────────────── │  (this server)      │
└────┬─────┘  2. 402 + PAYMENT-REQUIRED header     └──────────┬──────────┘
     │                                                        │
     │ 3. Signs an EIP-3009 authorisation for USDC            │
     │                                                        │
     ├──── 4. GET + PAYMENT-SIGNATURE header ────────────────►│
     │                                      5. verify ────────┤
     │                                      6. settle ────────┤──► Facilitator
     │                                                        │    (on-chain)
     ◄──── 7. 200 + PAYMENT-RESPONSE receipt ─────────────────┘
                                          USDC → your wallet
```

## What the buyer sees in the 402

The authoritative copy is the base64 JSON in the `PAYMENT-REQUIRED` header; the
JSON body mirrors it for convenience.

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "1000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0xYourWallet…",
      "maxTimeoutSeconds": 300,
      "extra": { "name": "USDC", "version": "2" }
    }
  ]
}
```

- `amount` is in the token's smallest unit. USDC has 6 decimals, so `1000` is
  `$0.001` and `50000` is `$0.05`.
- `asset` is the USDC contract for the configured network.
- `payTo` is your wallet — this is why an incorrect `PAY_TO_ADDRESS` means you
  get nothing.

## Headers

| Direction | Header | Meaning |
| --- | --- | --- |
| Request | `PAYMENT-SIGNATURE` | The buyer's signed payment payload (v1 `X-PAYMENT` also accepted) |
| Response (402) | `PAYMENT-REQUIRED` | Payment requirements |
| Response (200) | `PAYMENT-RESPONSE` | Settlement receipt: transaction hash, payer, amount, network |

If your reverse proxy strips response headers, buyers keep paying but lose their
receipt — keep `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` intact.

## Networks

| Network | CAIP-2 | Real money? | Facilitator |
| --- | --- | --- | --- |
| Base Sepolia | `eip155:84532` | No (testnet) | `https://x402.org/facilitator` (no key) |
| Base | `eip155:8453` | **Yes** | A production facilitator (Coinbase CDP, PayAI, self-hosted…) |

The server refuses to pretend: if you pair a mainnet network with the public
testnet facilitator it warns loudly at boot, because that combination cannot
settle anything.

## Supported payment schemes

This server configures the `exact` scheme — a fixed price known before the
response is generated, which is what most paid API calls want. x402 also
supports `upto` (usage-based, authorise a maximum then charge actual usage) and
`batch-settlement` (micropayments with batched redemption); enabling those means
registering the matching scheme for the same network in `x402.js`.

## Confirming you actually got paid

Three independent checks:

1. **Server metrics** — `GET /api/metrics`:
   - `settledPayments` — number of successfully settled payments
   - `revenueAtomicByAsset` — settled amount per token contract (atomic units)
   - `failedPayments` / `paymentFailureReasons` — attempted-but-rejected payments
2. **Settlement receipt** — the `PAYMENT-RESPONSE` header on the buyer's `200`
   contains the on-chain transaction hash.
3. **The chain** — search that transaction hash on a Base block explorer and
   confirm the USDC transfer arrived at your address.

## Pricing advice

`PRICE` accepts a dollar string (`$0.001`) which resolves to the network's
default stablecoin, or an explicit token:

```bash
PRICE=$0.05
PRICE={"asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","amount":"50000"}
```

Remember that a facilitator and the network charge fees on settlement; a price
far below a cent can end up mostly fees. Start around `$0.01`–`$0.05` for real
traffic and tune from the `settledPayments` counter.
