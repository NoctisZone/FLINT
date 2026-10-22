# Flint: status for the arena work

*As of 2026-10-22, 21:40 UTC. The gateway runs on the preprod box; the operator restarts it when the code changes.*

Flint is a mandate gateway: agents quote tBTC/tUSD on Midnight's offer board (preprod), every fill is hedged on Strike BTC-USD (testnet), and nothing reaches a venue without passing the owner's mandate. The arena page reads one JSON feed. Everything below is built and has run live.

## How to work on the arena

Make a branch for the UI work (for example `arena`) and build against the mock feed; nothing is public yet, we deploy together tomorrow.

```bash
npm install
npm run mock-feed        # http://localhost:4481/feed/<route>
```

The mock has made-up numbers and goes through the same feed state as the gateway, so every route has the live shape: a new quote every 5 s, a fill and its hedge every 10 s, a refusal every 20 s, a paid call every 50 s. The live gateway serves the same routes on its own port when it runs; the page should handle a failed poll quietly, since the gateway restarts when the code changes. Both are public over https on the demo host: the mock under `/flint/`, the running gateway under `/flint-live/` (full URLs in `local_docs/`).

Routes: `meta`, `agents`, `quotes`, `fills`, `decisions`, `refusals`, `proofs`, `capital`, `revenue`. Poll every 5 s. `fills`, `decisions`, `refusals` take `?since=<ISO timestamp>` and come newest first. CORS is open.

## What works, seen live today

- **Quotes on Midnight**: a maker posts a bid and an ask around Strike's mark (each 25 bps off it, size 120 USD), as proven swap halves on the board; a half proves in about 5 s. Quotes expire after 5 minutes or are pulled when the mark moves. Spreads are per side everywhere: the mandate's band, the checks, the makers' decisions.
- **Fills**: a citizen takes a quote, the sponsor pays, the swap lands in 25 to 55 s. The gateway sees the fill on the board row (with the Midnight txHash).
- **Hedge on fill**: the maker's Strike order follows within a second of the fill being seen. The testnet book is thin, so a market hedge often cancels and rests as a limit; a fill of the other side nets it instead ("netted"). Everything is in the decision log.
- **Mandate checks and refusals**: nine checks, first failure wins, with rule, limit and attempted value. The rogue agent is refused on 12 attempts for 12 distinct rules (`npm run rogue`).
- **Freeze and resume**: a hedge not filled in time freezes the maker; frozen, it may only quote the side that reduces its delta; the freeze lifts when nothing is left unhedged.
- **Claude as a maker**: Haiku picks spread and size with one sentence; it paused itself when net delta neared the limit. Decisions in `decisions` with the sentence as `reason`.
- **Capital trail**: Strike's deposit record plus the three Cardano transactions behind it (owner → intake, intake → vault, settlement), read from the chain.
- **Agents onboard themselves to Strike**: own Cardano wallet, builder connect by signature, own Strike account and API key, ADA deposit through Strike's API (Strike's testnet listener had a known issue tonight; they are fixing it).
- **x402 pay-per-call**: an outside agent paid 1 tADA on preprod for a `post_quote` through the tools endpoint; the payment settled on chain and the quote went through the checks. Shown on `revenue`.
- **Reconciler**: every five rounds, this run's Midnight fills against Strike's own fill history and the mandate; the four badge claims on `proofs`.

## The page

`arena/flint.html` is served by the feed server at `/`: `https://agentic.demo.odatano.dev/flint/` over the mock, `https://agentic.demo.odatano.dev/flint-live/` over the running gateway (trailing slash: the page loads `feed/…` and `logos/…` relative to itself). It polls every five seconds and maps the routes below into its own state. Opened from a file it simulates. One owner view holds the agents (trades, rules, money with payouts, keys), a new agent (ordered and paid from the wallet) and connecting an outside agent, all live over the owner API; a further deposit into a running agent is still to come.

## The owner API

Next to the feed, under `/owner/` (so `https://agentic.demo.odatano.dev/flint-live/owner/…`), for the page's Terminal and Console. A session comes from a CIP-30 wallet: `POST challenge {address | addressHex}` answers `{nonce, message}`, the wallet signs the message with `signData`, `POST session {nonce, signature: {signature, key}}` answers `{token, address, agents}`; `agents` are the ones whose mandate names that address as `owner`. With `Authorization: Bearer <token>`: `GET session`, `DELETE session`, `GET agents` (full mandates and state), `POST agents/:id/pause`, `/resume`, `/stop` (freeze by hand, offers and Strike orders pulled, nothing new until a mandate is signed), `/close` (reduce-only market order), and `PUT agents/:id/mandate {mandate, signature}` where the signature is `signData` over the mandate's hash (`canonical` JSON, SHA-256, as the page computes it). A signed mandate is in force from the next round, saved under `data/mandates/`, loaded on the next start, and anchored on the vault again. Sessions last 12 hours and survive a gateway restart. Errors come as `{error}` with 400, 401, 404 or 409. `meta.owner` says the API is on; `meta.tools` carries the public tools address and the x402 prices. `npm run owner -- …` does the same from a shell with a headless owner key.

A new agent is an order the owner pays from their wallet. `GET prices` (no session) says what it costs: `{feeAda, feeClaudeAda, keyAda, minDepositAda, payTo, x402}`; the same sits on `meta.orders`. `POST agents {name, mind, mandate, signature, depositAda, toolsKey, pay}`: `name` is `^[a-z0-9-]{3,14}$` and not taken, `mind` is `rules` or `claude`, `mandate.agentId` is the name, `mandate.owner` the session's address, the signature is `signData` over the mandate hash as for `PUT mandate`, `depositAda` at least `minDepositAda`, `toolsKey` true by default, `pay` is `wallet` (default) or `x402` (the set-up fee charged on this call, 402 first as at the tools endpoint). It answers 201 `{agentId, index, hash, job}` and the job starts. Then the owner's one payment, built by the gateway and signed by the owner's wallet: `POST agents/:id/pay/build {utxos?}` answers `{unsignedTxCbor, outputs, total}`, a transfer with the set-up fee to `payTo` (left out when x402 paid it) and the deposit plus 5 tADA to the agent's own Cardano wallet (`utxos` are the wallet's CIP-30 hex UTxOs, the page sends `api.getUtxos()`; without them the gateway reads the chain); `POST agents/:id/pay {unsignedTxCbor, witnessSetHex}` (or `{signedTxCbor}`) submits it. The agent's wallet then deposits at Strike itself: Strike builds deposits only for the wallet it registered at builder connect. `GET agents/:id/onboarding` reads the job, `POST agents/:id/onboarding/retry` runs it again from the step that failed. The job:
```json
{ "kind": "onboard", "agentId": "nova-7", "index": 5, "owner": "addr_test1q…", "mind": "rules", "spec": { "pay": "wallet", "depositLovelace": "500000000", "feeLovelace": "20000000", "toolsKey": true },
  "status": "running", "current": "pay", "waitingFor": ["pay"], "error": null, "startedAt": "…", "updatedAt": "…",
  "feeLovelace": "20000000", "feeTo": "addr_test1v…", "depositLovelace": "500000000", "toAgentLovelace": "505000000", "cardano": "addr_test1q…", "paidByX402": false, "toolsKey": null,
  "steps": [ { "step": "wallet", "status": "done", "detail": "Cardano wallet addr_test1q…, Midnight wallet 5", "at": "…" },
             { "step": "pay", "status": "running", "detail": "waiting for your payment of 525 tADA, signed in your wallet", "at": "…" },
             { "step": "account", "status": "pending", "detail": null, "at": null }, { "step": "deposit", "status": "pending", "detail": null, "at": null },
             { "step": "mint", "status": "pending", "detail": null, "at": null }, { "step": "credit", "status": "pending", "detail": null, "at": null },
             { "step": "open", "status": "pending", "detail": null, "at": null }, { "step": "register", "status": "pending", "detail": null, "at": null }, { "step": "quote", "status": "pending", "detail": null, "at": null } ] }
```
`status` is `pending`, `running`, `failed` or `done`; a step's `status` the same. The steps: `wallet` (its Cardano and Midnight wallets), `pay` (the owner's transaction, waited for up to 45 minutes, then seen on chain), `account` (builder connect), `deposit` (the agent's wallet deposits at Strike: quote, build-tx, its signature, submit, confirm), `mint` (quote-sized tBTC and tUSD coins to its closed wallet), `credit` (Strike credits the deposit), `open` (its NIGHTGATE server, wallet synced), `register` (into the loop and `data/agents.json`, mandate anchored, its tools key issued when ordered: `toolsKey` on the view, for the owner to read once), `quote` (its first offer). From the first step on the agent has a card on `agents` with `status: "starting"` and `onboarding: { status, step, stepStatus, detail, error }`; once the job is done `onboarding` is null and the card is the loop's. About ten minutes from the payment on. `npm run owner -- create <name> [rules|claude] [x402] [deposit=850]` then `npm run owner -- pay <name>` does it headless from the owner key's own tADA.

Payouts: `POST agents/:id/withdraw {usd | "all"}` takes that much off the agent's Strike balance and brings it to the owner's wallet: Strike pays to the wallet it registered at builder connect (the agent's own), the gateway forwards it, minus 2 tADA the agent keeps for fees. It answers 201 `{job}` with the steps `quote`, `sign`, `confirm`, `settle` (Strike's validators, up to two hours), `forward`; the view carries `usd`, `feeUsd`, `requestId`, `strikeStatus`, and at the end `paidOut` (lovelace) and `txHash`. `GET agents/:id/withdrawals` lists them, newest first. Open positions keep margin in use: stop the agent first for everything. `npm run owner -- withdraw <name> <usd|all>`.

For the page's "Connect an agent" section: a tools address may now need a key. The owner issues one under Keys (or orders the agent with one); from then on the agent's `/mcp/<agentId>` answers only with `Authorization: Bearer <key>` and 401 otherwise. Without a key the address stays open as before, so the connect flow as it stands keeps working; it should show the owner's key state (`GET agents` → `toolsKey`) and tell the outside mind to send the key. Tools keys: `POST agents/:id/key` issues a key for one of the session's agents (in the loop or still being set up), shown once as `{agentId, key, prefix, issuedAt}`; the key before it stops working. With `X402_PRICE_KEY` above 0 the call is paid by x402 (402 first). `DELETE agents/:id/key` revokes it. An agent with a key answers at `/mcp/<agentId>` only with `Authorization: Bearer <key>` (401 otherwise); without one its endpoint stays open as today. `GET agents` shows `toolsKey: {prefix, issuedAt} | null` per agent. `npm run owner -- key <name>` and `revoke-key <name>`; `npm run pay-demo` sends `AGENT_KEY` when set.

## The feed, with real samples

`meta` — `marks` is the last two hours of Strike marks (`[{t, p}]`, one per round), so a chart is full on the first poll. `strikeLiquidity` names who stands on the other side of the hedges when the venue has no market maker (our own testnet liquidity account), null when it is the real book. `midnightBoard` is where quotes wait for their taker: `server` (the offer board) or `gateway` (this process hands the halves over; for a network without the board). `attestEveryMs` is how often a window attestation is made, for the page's countdown.
```json
{ "runStart": "2026-10-21T19:49:35.478Z", "networks": { "midnight": "preprod", "strike": "testnet" }, "strikeMark": 84466.93, "sponsorReady": null, "strikeLiquidity": "flint testnet liquidity account: stands in for the empty testnet book", "midnightBoard": "server", "attestEveryMs": 300000, "tools": { "url": "https://…/flint-tools/mcp/", "prices": { "post_quote": "1000000", "take_quote": "1000000", "place_order": "1000000", "hedge": "2000000" }, "paid": true }, "owner": true, "serverTime": "2026-10-21T19:51:04.095Z" }
```

`agents` — one card per agent. `type` is `mm`, `citizen` or `rogue`; `mind` is `rules` or `claude`; `status` is `quoting`, `hedging` (a hedge is pending), `watching` (citizen), `probing` (the rogue, one refused attempt a round), `frozen` (a late hedge), `paused` (by its owner), `stopped` (by its owner, until a new mandate is signed), `starting` (not in the loop yet; an agent being set up from the page also carries `onboarding`, see the owner API). `mandate.full` is the whole mandate. The day's figures (`day` is the UTC date): `equityUsd` (Midnight holdings at the mark, plus `midnight.reservedUsd`, the coins locked in open quotes, plus Strike margin balance), `equityStartUsd` and `pnlPct` since the day's first round, `spreadCapturedUsd` (what fills earned against the mark), `hedgeCostUsd` (Strike fees, builder fees and slippage against the mark), `strikeVolumeUsd`, `builderFeesUsd`; `wallets` (Cardano address, Midnight "hidden").
```json
{ "agents": [ {
  "agentId": "mm-rule", "name": "mm-rule", "type": "mm", "status": "hedging",
  "mandate": { "hash": "27b5b1c5…", "maxNetDeltaUsd": 150, "hedgeWithinSec": 120, "maxQuoteUsd": 150, "maxPositionUsd": 500 },
  "midnight": { "btc": 0.00350749, "usd": 390.45, "reservedUsd": 236.9, "openQuotes": 2 },
  "strikePositionBtc": -0.00319, "netDeltaUsd": -120.16, "unhedgedUsd": -119.94,
  "hedges": 0, "maxHedgeLatencySec": 0, "pending": 1,
  "equityUsd": 1016.84, "equityStartUsd": 1016.84, "pnlPct": 0, "spreadCapturedUsd": 0.37, "hedgeCostUsd": 0.23, "strikeVolumeUsd": 149.61, "builderFeesUsd": 0.15, "day": "2026-10-22",
  "wallets": { "cardano": "addr_test1qprc…v55", "midnight": "hidden" }
} ] }
```
Attestations and badge claims are on `proofs`, in the mock as live.

`quotes` — open quotes on the board, the maker hidden on chain but named here because they are ours.
```json
{ "quotes": [ { "quoteId": "be6e9236-…", "side": "ask", "sizeBtc": 0.0012, "price": 84725.7, "expiresAt": "2026-10-21T19:53:36.633Z", "agentId": "mm-rule", "pair": "tBTC/tUSD" } ] }
```

`fills` — a Midnight fill (with the swap's txHash) and, as separate entries, the Strike fills of hedges. Once the hedger has closed a Midnight fill, the fill's entry carries `hedge`: `how` is `market` (a Strike market order), `limit` (a resting limit that filled), `netted` (a fill of the other side closed it, no Strike order) or `dust` (a few dollars left, not worth an order); `clientOrderIds` are the Strike orders involved (several when one order covered part and another the rest), `price` their size-weighted fill price, `latencySec` fill to hedge. Until then the entry has no `hedge`. The `strikeFill` entries are the raw Strike side; match them to a fill by `clientOrderIds`.
```json
{ "fills": [
  { "ts": "2026-10-21T19:50:55.456Z", "agentId": "mm-rule", "quoteId": "46b48280-…", "txHash": "00c34943…", "midnight": { "side": "sell", "sizeBtc": 0.00142, "price": 84683.5 },
    "hedge": { "how": "market", "clientOrderIds": ["mm-rule-hedge-1-…"], "price": 84564.9, "latencySec": 6.2, "at": "2026-10-21T19:51:01.656Z" } },
  { "ts": "2026-10-21T19:51:01.656Z", "agentId": "mm-rule", "strikeFill": { "side": "BUY", "size": "0.00142", "price": "84564.9", "clientOrderId": "mm-rule-hedge-1-…" } }
] }
```

`decisions` — one line per action that passed the checks; `reason` is the agent's sentence (Claude's own words for the Claude maker).
```json
{ "decisions": [ { "ts": "2026-10-21T19:50:31.934Z", "agentId": "mm-rule", "action": "midnight.quote", "side": "ask", "sizeBtc": 0.0012, "price": 84725.7, "reason": "paid demo quote from an outside agent" } ] }
```
Actions: `midnight.quote`, `midnight.take`, `strike.order`.

`refusals` — what the checks refused, with the rule broken.
```json
{ "refusals": [ { "ts": "…", "agentId": "rogue", "venue": "midnight", "rule": "midnight.maxSpreadBps", "limit": 100, "attempted": 450, "action": "quote" } ] }
```
Rules you will see: `strike.maxPositionUsd`, `strike.priceBandPct`, `strike.markets`, `strike.maxLeverage`, `midnight.maxQuoteUsd`, `midnight.minSpreadBps`, `midnight.maxSpreadBps`, `midnight.maxOpenQuotes`, `midnight.quoteTtlSec`, `midnight.pairs`, `risk.maxNetDeltaUsd`, `risk.dailyLossStopPct`, `risk.maxActionsPerMin`, `frozen`, `signature`, `expiry`.

`proofs` — per maker, from the reconciler: the four badge claims as numbers, violations, counts, and whether the decision log's hash chain is intact.
```json
{ "proofs": [ { "agentId": "mm-rule", "reconciled": "2026-10-21T19:22:57.969Z",
  "claims": { "violations": 0, "maxNetDeltaUsd": 0, "maxFillToHedgeSec": 0, "venuesOutsideMandate": 0 },
  "violations": 0, "counts": { "midnightFills": 0, "hedgesPlaced": 0, "hedgesFilled": 0, "strikeFills": 0, "refusals": 0 }, "logChain": "934 entries, chain intact" } ] }
```
Badges: `no-violations` (violations = 0), `delta-held` (maxNetDeltaUsd ≤ mandate), `hedged-in-time` (maxFillToHedgeSec ≤ hedgeWithinSec), `allowed-venues` (venuesOutsideMandate = 0).

The same card carries the on-chain attestations (live since tonight): the agent's attester id, the vault, the mandate anchor and the last window.
```json
{ "agentId": "mm-rule", "attesterId": "46ef2032…", "vault": "e7ffe63b…",
  "mandate": { "payloadHash": "8b0f8ce6…", "txHash": "009e42cc…", "status": "succeeded", "verified": true, "at": "2026-10-21T19:58:53.657Z" },
  "lastAttestation": { "at": "…", "window": { "from": "…", "to": "…" }, "payloadHash": "…", "txHash": "…", "status": "succeeded", "verified": true, "decisions": 12, "fills": 2 } }
```
`verified` is the answer of a live check against the contract; anyone with a NIGHTGATE MCP server can repeat it with the attester id and payload hash.

The badges on chain, under `badges` on the same card: the reconciler's four claims go into one document (its hash attested, its Merkle root anchored), and each badge is a zero-knowledge proof that one field is at most the mandate's limit. A false claim earns nothing and costs no transaction (`status: "false"`); the others are proven and verified against live state. Verifiers need the attester id, the payload hash, the field key and the threshold, nothing else; the numbers stay hidden. Written every 30 rounds and at shutdown.
```json
{ "badges": { "at": "…", "payloadHash": "…", "contentRoot": "…", "anchor": { "txHash": "…", "status": "succeeded" }, "root": { "txHash": "…", "status": "succeeded" },
  "earned": ["delta-held", "hedged-in-time", "allowed-venues"],
  "claims": [ { "badge": "no-violations", "field": "claims.violations", "predicate": "lessOrEqual", "threshold": 0, "value": 1, "status": "false", "txHash": null, "verified": false, "earned": false },
              { "badge": "delta-held", "field": "claims.maxNetDeltaUsd", "predicate": "lessOrEqual", "threshold": 150, "value": 118.25, "fieldKey": "…", "status": "succeeded", "txHash": "…", "verified": true, "earned": true } ] } }
```

`capital` — where the hedging money comes from, traceable on Cardano preprod.
```json
{ "balanceUsd": 2272.93, "depositedUsd": 2273.06, "feesUsd": -0.134881, "fundingUsd": 0.00861, "trailHash": "10d72f0e…",
  "deposits": [ { "requestId": "9c4d5f0b-…", "status": "settled", "chain": "cardano", "asset": "ADA", "lovelace": 10000000000, "usd": 2273.06, "usdPerAda": 0.227306, "settledAt": "2026-10-21T14:58:06.768Z",
    "hops": [
      { "label": "owner → Strike intake", "txHash": "2a4b2776…", "block": 5318563, "time": "2026-10-21T14:57:09.000Z", "inputs": [ { "address": "addr_test1qrge…qljhzv", "lovelace": 10000000000, "from": "21e4c187#0" } ], "outputs": [ { "address": "addr_test1qzs2…p8axzg", "lovelace": 10002000000, "datum": true } ], "memo": null },
      { "label": "Strike intake → vault", "txHash": "f0e6f413…", "block": 5318564, "time": "2026-10-21T14:58:06.000Z", "inputs": [], "outputs": [], "memo": "Strike V2 Deposit Refund | Request ID: 9c4d… | Asset: ADA" },
      { "label": "vault settlement", "txHash": "3d5aa67b…", "block": 5318573, "time": "2026-10-21T15:00:28.000Z", "inputs": [], "outputs": [], "memo": null }
    ] } ] }
```
A tx hash links to `https://preprod.cexplorer.io/tx/<txHash>`.

`revenue` — paid calls from outside agents.
```json
{ "calls": 1, "lovelace": "1000000", "payTo": "addr_test1vqcz…ug5m", "last": { "ts": "2026-10-21T19:50:31.767Z", "tool": "post_quote", "agent": "mm-rule", "txHash": "698d603e…", "payer": "addr_test1qrcr…q55a" } }
```

## Views the page needs

1. **Leaderboard** from `agents`: equity, PnL, spread captured, hedge cost, net delta, Strike volume, builder fees, status.
2. **Midnight book** from `quotes`: price, size, expiry countdown, side, maker (ours by name, outside ones as "hidden").
3. **Fill-to-hedge timeline** from `fills`: each Midnight fill with its `hedge` (how, Strike orders, price, seconds between); a fill without `hedge` yet is pending.
4. **Decision feed and refusal feed** from `decisions` and `refusals`: the sentence, the rule.
5. **Agent cards**: Cardano address, Midnight "hidden", mandate hash, the four badges (`proofs[].badges.earned`), attestation link.
6. **Capital** from `capital`: the deposit and its three hops, balance, fees, funding.
7. **Revenue** from `revenue`: paid calls, the last payer, the pay-to address.

## Open for tomorrow (gateway side)

- A long unattended run with the three agents, the Claude maker and the rogue, reconciler at 0 violations.
- Discord: testnet BTC-USD liquidity from Strike; until then our own liquidity account (`npm run liquidity`) stands in, named on `meta.strikeLiquidity`.

## Names

Project and repo: **Flint**. Agents: `mm-rule`, `mm-claude`, `citizen-a`, `citizen-b`, `rogue`. Venues: Midnight preprod (offer board), Strike testnet (BTC-USD perpetual). Tokens on Midnight: tBTC (satoshi units), tUSD (cents); the feed speaks BTC and USD.
