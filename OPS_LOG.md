# Operations Log

Running log from the daily automated health check (Railway + GitHub) for the
Desanatization production service. Owner-requested standing job: "constantly
monitor and interpret the details, data and logs on railway as well as github
to adjust, fix and learn/grow." Entries are appended oldest-to-newest by the
scheduled check-in; see `PRICING_INTEL.md` for the separate weekly
pricing/market-intel job.

---

## 2026-09-19

**Railway** — two live "Desanatization" projects still exist and the owner
hasn't confirmed which is canonical:

- `596c7495-1cca-4154-abfe-ea1babad0061` (deployed 2026-09-17) — 1 service,
  online, 1/1 replicas running, 0 warnings/criticals, 0 recent failures.
- `3b425e33-ece8-4266-9cf4-bfaf67eb586c` (deployed 2026-09-19) — 1 service,
  online, 1/1 replicas running, 0 warnings/criticals, 0 recent failures.

Both are healthy and currently serving the same deployed commit. Flagging the
duplicate again per standing instruction — not decommissioning either without
the owner's say-so. This is a cost/confusion concern, not a health one today.

**GitHub** — no new issues, no new PRs beyond the three already tracked via
this session's PR-activity subscriptions (#1 SSRF/rate-limit fixes, #2 pricing
intel, #3 security cleanup). Nothing outside those subscriptions to report.

**Bugs found:** none. Nothing needed fixing today.

---

## 2026-09-20

**Railway** — the duplicate-project concern from 2026-09-19 has effectively
resolved itself:

- `596c7495-1cca-4154-abfe-ea1babad0061` — **0 services**. The service was
  removed; only an empty project shell remains. Costs nothing and serves
  nothing. Deleting the empty project is the owner's call, not this job's.
- `3b425e33-ece8-4266-9cf4-bfaf67eb586c` — canonical. 1 service, 0 services
  with issues, 0 failures. `/health` 200, `paywallReady: true`, facilitator
  authenticated against CDP on `eip155:8453`, `price $0.01`, `payTo
  0x79e6cdb3…`. Last deploy succeeded (the PR #9 `BATCH_PRICE` fail-safe).

No sign of unauthorized access: no unexpected deploys, no variable changes
beyond those this session made deliberately.

**Bug found — the outbound growth engine pitches nothing, by construction.**
Nine consecutive cycles in the deployment log, identical:

```
Growth cycle 1: probed 2, pitched 0, pool 100 (top: https://chat.gedx402.com)
…
Growth cycle 9: probed 2, pitched 0, pool 100 (top: https://chat.gedx402.com)
```

Discovery works fine — 42 targets from expanded sources plus 22 from the
Bazaar every cycle, pool saturated at 100. The failure is at the last step.
`growth.js` will only deliver a pitch to `/api/outreach`, `/api/pitch`,
`/api/agents`, or an A2A endpoint advertised in a peer's
`/.well-known/agent.json`. The first three are conventions this repo invented;
essentially no real x402 service implements them. So every cycle POSTs into
404s and records zero.

Two secondary observations from the same logs:

- Only 2 of the 100 pooled targets are probed per cycle. `effectiveMax` is
  `round(maxPerCycle × (0.4 + 0.4 × heat))`, and with `heat` at 0 that pins a
  `GROWTH_MAX_PER_CYCLE` of 5 down to 2.
- Cycles are firing roughly every 2 minutes (04:32, 04:34, 04:36 …), not on
  the 6-hour default, so `GROWTH_INTERVAL_MS` is set well below it in
  production. ~720 cycles/day, zero pitches.

**Not fixed here, deliberately.** This job's standing instructions exclude
outreach/growth-engine pitch logic. Logged and raised with the owner in
session instead. The honest strategic read also belongs with the owner rather
than in a patch: other x402 *sellers* are peers, not buyers, so repairing the
delivery mechanism would mostly buy better-delivered pitches to the wrong
audience.

**GitHub** — no new issues and no PRs opened by anyone else. Open PRs (#2, #4,
#7, #10, #11, #12, #13) are all this session's or a sibling session's and are
covered by PR-activity subscriptions.

**Revenue** — `/receipts` still `count: 0`. Unchanged.
