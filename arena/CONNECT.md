# FLINT: connecting the page to the gateway

The page keeps its state in the same shape as the feed. Connecting it means replacing the simulator with a poller that fills that state from `/feed/<route>`. The render code stays as it is. The Arena and Terminal only read. The Console's owner actions need a small owner API, which the feed deliberately doesn't have.

Names in `code` are functions and variables in `flint.html`; search for them. Routes and fields are from `gateway/feed.mjs`, `gateway/gateway.mjs` and `cli/gateway.mjs` as of commit `5af16ca`.

## 1. Where the simulation lives

| What | In `flint.html` | Live replacement |
|---|---|---|
| State | `AG` (agents), `S` (`mark`, `hist`, `quotes`, `trades`, `decisions`, `refusals`, `proofs`, `revenue`, `nextProof`) | filled by the poller |
| Start-up data | `seedHist()`, `seed()` | remove; the first poll fills everything |
| Price ticks | `moveMark()`, called from the 500 ms `setInterval` near the end | `meta.strikeMark` on each poll |
| Makers quoting | `postQuotes()` | `quotes` |
| Takes, fills, hedges | `takerAct()`, `land()`, `hedge()` | `decisions` (`midnight.take`), `fills` |
| Rogue | `rogueAct()`, `TRICKS` | `refusals` |
| Paid calls | `paidCall()`, `paidFrom()` | `revenue` |
| Proofs | `proveWindow()`, `setInterval(proveWindow, 45000)` | `proofs` |
| Deposit path | the `HOPS` constant | `capital.deposits[0].hops` |
| Loops to delete | the last lines: `loop(takerAct…)`, `loop(rogueAct…)`, `loop(paidCall…)`, `setInterval(proveWindow…)`, and the `moveMark` part of the 500 ms interval | — |

Keep `renderAll()`, the `frame()` loop and everything named `render*`, `draw*` and `mesh*`. The network animates from changes to `S` on its own: new decisions send cyan dots, new hedges orange, refusals flash red at the gateway, a higher proof count sends green, and paid calls send pink.

## 2. Route by route

Poll every 5 s, as STATUS.md says. Pass `?since=` on `fills`, `decisions` and `refusals`, using the newest `ts` you hold. When a poll fails (the gateway restarts on code changes), keep what you have and try again quietly.

| Route | Into | Notes |
|---|---|---|
| `meta` | `S.mark`, `S.markAt`, push `{t, p}` onto `S.hist` | `S.hist` keeps the last two minutes for the price chart. `sponsorReady` and `networks` can go in the strip. |
| `agents` | `AG[agentId]`: `name`, `type`, `rt.status`, mandate fields, and the numbers below | `status` is `starting`, `quoting`, `hedging`, `watching` or `frozen`, the same values the page uses. |
| `quotes` | `S.quotes` (a `Map` by `quoteId`) | Set `exp = Date.parse(expiresAt)`. Set `posted` when you first see the quote. Set `ttl` from the mandate's `quoteTtlSec`. Compute `bps` from the mark. A quote whose `agentId` isn't one of ours shows as "Hidden maker". |
| `fills` | `S.trades` | Two kinds of record; see section 3. |
| `decisions` | `S.decisions`: `{id, at: Date.parse(ts), agentId, action, side, sizeBtc, price, reason}` | `action` is `midnight.quote`, `midnight.take` or `strike.order`, as the page expects. The mock writes `post_quote` instead, so map that to `midnight.quote`. The Claude maker's `reason` is its sentence. |
| `refusals` | `S.refusals`: `{id, at, agentId, venue, rule, limit, attempted, action}` plus `simple` | Pro shows the rule as it comes. For Simple, make `simple` a sentence per rule; `TRICKS` has one for each of the twelve rules the rogue tries. |
| `proofs` | `S.proofs[agentId]`: `{mandate: {at, verified, txHash}, windows, last: {at, from, payloadHash, txHash, verified, decisions, fills}}` | `mandate` comes from the anchor; `last` from `lastAttestation` (`from` is `window.from`). Count `windows` as attestations seen. `S.nextProof = last.at + ATTEST_EVERY_ROUNDS × round-ms` (defaults 10 × 20 s). The badges are `claims`. |
| `capital` | `HOPS` and the trail text | Each hop has `label`, `txHash` and `time`. `balanceUsd`, `depositedUsd`, `feesUsd` and `fundingUsd` fill the Pro line. |
| `revenue` | `S.revenue`: `{calls, lovelace: Number(lovelace), last}` | The feed holds only the latest call. To show a list, add each new `last.txHash` to a list in the page. Show `last.payer` (shortened) and `last.tool`. |

## 3. Trades: Midnight fill, hedge, proof

"Follow a trade", the trade dots on the charts and the Terminal's Trades and Hedges tabs all use one trade object:

```
{ id, maker, taker, makerSide, sizeBtc, price, spreadBps, quoteId,
  quotedAt, takenAt, landedAt, txHash,
  hedge: { how: 'market' | 'netted', at, latencySec, clientOrderIds, price, side } | null,
  provedAt }
```

Build it from what the feed has today:

| Field | Source |
|---|---|
| `quoteId`, `maker`, `sizeBtc`, `price`, `landedAt`, `txHash` | Midnight fill: `{ts, agentId, quoteId, txHash, midnight: {side, sizeBtc, price}}` |
| `makerSide` | `midnight.side`. The gateway passes the quote's side (`ask` means the maker sold); the mock writes `sell` or `buy`. Accept both. |
| `quotedAt`, `spreadBps` | the quote, when you saw it on `quotes` |
| `taker`, `takenAt` | the `midnight.take` decision with the same price and size just before the fill (it has no `quoteId` yet) |
| `hedge` | the first Strike fill `{ts, agentId, strikeFill: {side, size, price, clientOrderId}}` for that maker, on the opposite side, after `landedAt` |
| `provedAt` | the first `lastAttestation` whose `window` covers `landedAt` |

Two small changes in the gateway would replace that guessing with facts:

1. **Put the hedger's pairing in the feed.** `hedge.mjs` already records `{fill, hedge: {how, clientOrderId, price, sizeBtc, at}, latencyMs}` for every fill in `done`, netted ones included, but it only goes to the decision log. A `feed.fill({ts, agentId, quoteId, hedge, latencySec})` there gives the page every hedge and every netting, matched to its fill.
2. **Put the `quoteId` on take decisions.** In `citizenRound`, `q.quoteId` is in hand when it calls `act(...)`. With it, the page knows the taker for certain.

## 4. Panel by panel

| Panel | Reads |
|---|---|
| Scoreboard | private trades = Midnight fills; hedged = trades with a hedge; rule breaks = `refusals`; proofs = mandate anchors plus attestations |
| Agent network | `S` changes (above). Bitcoin shows `meta.strikeMark`; Cardano shows `revenue.calls`. |
| Follow a trade | the trade object (section 3); the limit line is the maker's `mandate.hedgeWithinSec` |
| The private book and chart | `quotes`, `meta.strikeMark` history, fills as dots |
| Risk balance | `agents[].netDeltaUsd` against `mandate.maxNetDeltaUsd`. Today the page computes delta from its own trades; use the card's number instead. |
| Leaderboard | `agents[]`. The real card has `status`, `netDeltaUsd`, `unhedgedUsd`, `hedges` and `maxHedgeLatencySec`. Equity, PnL, spread captured, hedge cost, Strike volume and builder fees are on your "Open for tomorrow" list; the mock already sends them as `equityUsd`, `pnlPct`, `spreadCapturedUsd`, `hedgeCostUsd`, `strikeVolumeUsd` and `builderFeesUsd`. |
| What the agents say | `decisions` |
| Caught by the rules | `refusals` |
| Proofs on Midnight | `proofs`. The page's badge ids are `no-violations`, `delta-held`, `hedged-in-time` and `allowed-venues`, as in the mock; check that `reconcile`'s `claims` use the same keys. |
| Where the money comes from | `capital` |
| Paid calls | `revenue` |

## 5. The Terminal (read side)

The Terminal shows one owned agent through the same state, filtered by `agentId`:

- **Agent bar:**
  - equity from the card (once it's there);
  - "kept this run" = spread captured − hedge cost;
  - at risk = `netDeltaUsd`;
  - checked and refused = that agent's decisions and refusals;
  - rules expire in = the mandate's `expiry`.
- **Position tab:** `strikePositionBtc` for Strike; `midnight.btc` and `midnight.usd` for Midnight. Today the page sums its own trades in `bookSync()`; drop that once the card is read.
- **Its rules:** needs the whole mandate. The card's `mandate` has only `hash`, `maxNetDeltaUsd`, `hedgeWithinSec`, `maxQuoteUsd` and `maxPositionUsd`. Either send the full mandate on the card or add a `mandates` route. It's public information: the hash is anchored on Midnight anyway.
- **Which agents are "yours":** `OWN` is fixed to `mm-rule` and `mm-claude`. Live, it's the agents whose `mandate.owner` is the connected wallet.

## 6. The Console (write side): an owner API

What exists now, under `/owner/` next to the feed (`STATUS.md` has the routes): the wallet session over a challenge, pause, resume, stop, close, and `PUT agents/:id/mandate` with the wallet's `signData` over the mandate hash. The page uses it when it runs live: `LV.connect`, `LV.pause`, `LV.stop`, `LV.close`, `LV.sign` in the live block. Setting up a new agent is live too: step 4 signs the mandate the set-up flow builds and posts it (`LV.create`, `POST /owner/agents`), step 5 shows the gateway's onboarding job (`LV.job` polls `GET /owner/agents/:id/onboarding`, `LV.retry` after a failure), step 6 refreshes the session so the new agent is yours in the Terminal (`LV.goLive`). Deposit, withdraw and key rotation are still demo actions. The table below is the original suggestion.

The feed is read-only on purpose. Owner actions need a few authenticated endpoints next to it. A suggestion that fits the code you have:

| Console action | Endpoint | Gateway side |
|---|---|---|
| Connect wallet | `POST /owner/challenge` → nonce; `POST /owner/session` with a CIP-30 `signData` over the nonce | Check the COSE signature against the address. `verifyOwnerSignature()` covers headless Ed25519 keys; its comment already says CIP-30 needs its own verify. |
| Pause / Resume | `POST /owner/agents/:id/freeze`, `/resume` | `gateway.freeze(agentId, reason)` and `gateway.resume(agentId)` already exist. |
| Stop agent | `POST /owner/agents/:id/kill` | Freeze, then `cancel_all`, and refuse new quotes until a new mandate is signed. This is new: a `stopped` flag next to `frozen`. |
| Sign rules (Terminal, and set-up step 4) | `PUT /owner/agents/:id/mandate` with `{mandate, signature}` | `assertMandate()`, check the signature is over `mandateHash(mandate)` by `mandate.owner`, swap the mandate in, anchor it as `anchorMandates()` does, and update `proofs[agentId].mandate`. |
| Set up an agent | the same, plus creating the agent | `onboard connect` / `fund` / `deposit`, with the owner's wallet signing instead of the treasury |
| Deposit | build the transaction server-side, sign it in the owner's wallet (CIP-30 `signTx`), then submit | `depositAda()` in `strike-connect.mjs` does the quote and the build today |
| Withdraw | Strike's withdrawal, signed by the owner's wallet | new |
| Rotate a Strike key | new | the keys in `data/strike-accounts.json` never leave the server; the page shows only a fingerprint |

What the page sends today:
- **Set-up:** `mandateObj()` in the set-up flow builds exactly the shape `mandate.mjs` checks (`owner`, `agentId`, `strike.*`, `midnight.*`, `risk.*`, `expiry`, `onBreach`). `canonical()` in the page is the same function as in `mandate.mjs`, so its fingerprint equals `mandateHash()`.
- **Terminal:** its `signRules()` hashes a flat demo object. Switch it to the nested mandate before going live.

What not to do:
- No key, seed or API secret goes to the page. That includes `STRIKE_KEY`, `ANTHROPIC_API_KEY` and `X402_FACILITATOR_KEY`.
- The Arena never asks for a wallet. Only the Console does.
- Owner endpoints check the owner's signature on every change, not just at sign-in.

## 7. Connect an agent: the tools endpoint

The Console's "Connect an agent" section already lists your real tools and prices from `gateway/tools.mjs` and `cli/gateway.mjs`. To make it live:

- Replace `GATE` (`https://flint-gateway.example/mcp/`) with `PUBLIC_TOOLS_URL + '/mcp/'`.
- Read the prices from the server instead of the `TOOLS` constant. They're `X402_PRICE_*`, defaulting to `post_quote`, `take_quote` and `place_order` at 1 tADA and `hedge` at 2 tADA.
- "Test the connection" can watch `decisions` for the first action by that agent after the button is pressed.
- The paid test call shows on `revenue` by itself.

## 8. A poller to start from

A sketch, not tested against the live gateway:

```js
const FEED = 'http://localhost:4481/feed/';           // the mock's port; the gateway's is whatever you start it with
const LISTS = ['fills', 'decisions', 'refusals'];
const since = {};
const get = (r) => fetch(FEED + r + (LISTS.includes(r) && since[r] ? '?since=' + encodeURIComponent(since[r]) : ''),
  { cache: 'no-store', signal: AbortSignal.timeout(4000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);

async function poll() {
  const routes = ['meta', 'agents', 'quotes', 'fills', 'decisions', 'refusals', 'proofs', 'capital', 'revenue'];
  const [meta, agents, quotes, fills, decisions, refusals, proofs, capital, revenue] = await Promise.all(routes.map(get));
  if (!meta) return;                                  // the gateway is restarting: keep what we have
  for (const [r, body] of [['fills', fills], ['decisions', decisions], ['refusals', refusals]])
    if (body?.[r]?.length) since[r] = body[r][0].ts;  // lists come newest first
  // map each route into AG and S as in sections 2 and 3, then:
  renderAll();
}
poll(); setInterval(poll, 5000);
```

## 9. Order of work

1. **Arena on the mock feed:** remove the simulator, add the poller, and map `meta`, `quotes`, `decisions`, `refusals`, `revenue`, `capital` and `proofs`.
2. **Trades:** build the trade object from `fills`. Add the two gateway changes in section 3 when you can.
3. **Leaderboard numbers,** once the agent card carries them.
4. **Terminal:** read the card and the full mandate; set `OWN` from the session.
5. **Owner API and Console actions,** in this order: wallet session, pause and resume, sign rules, stop, deposit, withdraw.
6. **Swap the demo values:** `W` (the demo wallet), `GATE`, `TOOLS` prices, and the strip text, which says the numbers are made up.
