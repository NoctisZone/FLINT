# Flint

Private market makers on Midnight, hedged on Strike, inside a mandate their owner signed.

Autonomous agents, each with a Cardano and a Midnight wallet, quote tBTC/tUSD on Midnight's offer board. Every fill is hedged on Strike BTC-USD within seconds. A mandate gateway checks every action against the owner's limits before anything is built, logs every decision in a hash-linked log, and reconciles both venues. Outside agents reach the same tools over MCP and pay per call with x402 on Cardano.

- Concept: `STRIKE_HACK.MD`
- Status and feed contract: `STATUS.md`
- Working notes for the code: `CLAUDE.md`

## Run

```bash
npm install
cp .env.example .env     # keys: NIGHTGATE, Strike, Anthropic, ODATANO; see the file
node --test "test/*.test.mjs"
npm run mock-feed        # the arena's feed with made-up numbers on :4481
npm run gateway -- --agents mm-rule:0,citizen-b:1,citizen-a:2 --rounds 20 --tools-port 4483
```

The gateway needs Midnight preprod (an indexer, a node, a proof server on localhost) and a Strike testnet account; `CLAUDE.md` has the details.

A quote is a proven swap half waiting for its taker. By default it waits on the offer board of the agent's NIGHTGATE server (`--board server`). With `--board gateway` it waits inside the gateway instead: the maker's half is handed to the taker by this process and the swap settles on chain exactly as from the board, one atomic transaction, sponsored. That mode runs on a network where the offer board is not live yet; the feed says which one is on in `meta.midnightBoard`.

## The arena page

`arena/flint.html` is the page over the feed: the agent network, the scoreboard, one trade followed from offer to proof, the private book on Strike's price, risk dials, leaderboard, what the agents say, what the rules caught, the proofs on Midnight, the money trail and the paid calls. The gateway and the mock feed serve it at `/`, so after `npm run mock-feed` it is at `http://localhost:4481/`, and a running gateway shows the live run the same way. Opened as a file it simulates a run; `arena/README.md` has the switches. The Terminal and the Console work with a CIP-30 wallet on preprod: the wallet whose address the mandates name as owner signs in over `/owner/`, can pause, stop and close its agents, and signs new rules that the gateway takes over at the next round and anchors on Midnight. Deposits, withdrawals and key rotation from the page are still demo actions.

## Testnet stand-ins

Strike's testnet BTC-USD book has no market maker: no asks, bids far under the mark. So that hedges can fill, `npm run liquidity` quotes both sides around the mark from a separate Strike account of ours, and the feed says so in `meta.strikeLiquidity`. On mainnet the real book takes that role. The citizens on Midnight are likewise the team's own counterparties. The mandate checks, the hedges and their latency, the reconciler against Strike's fill history and the proofs on Midnight are the real mechanism either way.

## Layout

```
arena/     the page over the feed, one file, with its design and connection notes
gateway/   mandate, checks, hedge, midnight venue, strike client and stream, capital trail, x402, tools, feed, reconcile, gateway loop
agents/    mandate profiles, rule maker and citizens, Claude maker, rogue
cli/       gateway, onboard (Strike accounts and deposits), strike, live (Midnight by hand), rogue, pay-demo, mock-feed
market/    the Midnight side: token factory, offer board, a wallet over its NIGHTGATE MCP server
facilitator/  an x402 facilitator over the ODATANO API
test/      node --test, stand-ins for every venue; no chain
```

## License

Apache-2.0
