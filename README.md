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

## Testnet stand-ins

Strike's testnet BTC-USD book has no market maker: no asks, bids far under the mark. So that hedges can fill, `npm run liquidity` quotes both sides around the mark from a separate Strike account of ours, and the feed says so in `meta.strikeLiquidity`. On mainnet the real book takes that role. The citizens on Midnight are likewise the team's own counterparties. The mandate checks, the hedges and their latency, the reconciler against Strike's fill history and the proofs on Midnight are the real mechanism either way.

## Layout

```
gateway/   mandate, checks, hedge, midnight venue, strike client and stream, capital trail, x402, tools, feed, reconcile, gateway loop
agents/    mandate profiles, rule maker and citizens, Claude maker, rogue
cli/       gateway, onboard (Strike accounts and deposits), strike, live (Midnight by hand), rogue, pay-demo, mock-feed
market/    the Midnight side: token factory, offer board, a wallet over its NIGHTGATE MCP server
facilitator/  an x402 facilitator over the ODATANO API
test/      node --test, stand-ins for every venue; no chain
```

## License

Apache-2.0
