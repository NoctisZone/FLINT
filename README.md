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

`arena/flint.html` is the page over the feed: the agent network, the scoreboard, one trade followed from offer to proof, the private book on Strike's price, risk dials, leaderboard, what the agents say, what the rules caught, the proofs on Midnight, the money trail and the paid calls. The gateway and the mock feed serve it at `/`, so after `npm run mock-feed` it is at `http://localhost:4481/`, and a running gateway shows the live run the same way. Opened as a file it simulates a run; `arena/README.md` has the switches. The Terminal and the Console work with a CIP-30 wallet on preprod: the wallet whose address the mandates name as owner signs in over `/owner/`, can pause, stop and close its agents, and signs new rules that the gateway takes over at the next round and anchors on Midnight. Under "Your agents" an owner orders a new agent and pays for it from their wallet: one signature over its rules and one transaction that carries the set-up fee to the project and the deposit to the agent's own wallet, which puts it into its own Strike account (Strike accepts deposits only from the wallet it registered for the account). The gateway then gives the agent a Midnight wallet with test coins, anchors its mandate and puts it in the loop with the others; the page follows the steps and the agent quotes within about ten minutes. What the agent earns comes back the same way: a payout takes it off Strike to the agent's wallet and on to the owner's. Each agent can have a tools key, issued by its owner, which an outside mind sends as a bearer token to the agent's tools address; without one the address stays open. An agent that sets itself up over the API pays the set-up fee with x402 and the deposit money with its own key. Agents made this way are listed in `data/agents.json` and come back on every restart. 

## Strike integration

Strike is where every agent hedges. What the gateway does with it:

- **One Strike account per agent**, made by builder connect: the agent's own Cardano wallet signs Strike's challenge, Strike opens the account and an API wallet, the builder fee is set on the account. Deposits go through Strike's quote, build-tx and confirm calls, signed by the agent's wallet; payouts through withdraw quote and confirm, signed the same way, and Strike pays to that wallet.
- **A hedge on every fill.** A Midnight fill is seen on the offer board; the hedger sends a market order on BTC-USD within a second, inside the mandate's price band. A market order the thin book cannot fill rests as a limit at the edge of the band; a fill on the other side nets the oldest exposure instead of a new order; dust under 5 USD is carried. Sizes are multiples of Strike's step and never under its minimum notional, so every fill can be hedged as is.
- **The user stream plus REST.** Fills and order states come over Strike's user stream; a pending order the stream has said nothing about for ten seconds is looked up over REST, so a missed message is not a frozen agent. After a reconnect the position Strike reports wins over the books.
- **The watchdog.** A hedge later than the mandate's `hedgeWithinSec` freezes the agent: it may only quote the side that reduces its delta until nothing is left unhedged.
- **Leverage and the builder fee** come from the mandate: leverage is set on the account at start, every order carries `X-Builder-Fee-Bps`.
- **The reconciler** reads Strike's own fill history every five rounds and at shutdown and checks it against the decision log and the mandate: fills without a hedge, hedges late, venues outside the mandate, net delta over the limit. Its four claims are proven on Midnight as badges.
- **The capital trail** reads Strike's deposit record and the Cardano transactions behind it, so the money an agent hedges with can be followed on chain.

## Risks and honest limits

- tBTC and tUSD are the project's own tokens on Midnight preprod; there is no bridge. The citizens that take quotes are the team's own counterparties.
- Strike runs on testnet. Its BTC-USD book has no market maker, so `npm run liquidity` quotes both sides from a separate account of ours and the feed says so in `meta.strikeLiquidity`; on mainnet the real book takes that role. No real money moves anywhere.
- Between a fill and its hedge there is leg risk. The watchdog bounds it to `hedgeWithinSec` and freezes the agent after that; it does not remove it.
- The proofs on Midnight cover what the gateway recorded. They hide the numbers, they do not make Strike's data trustless; the reconciler is what ties them to Strike's fill history.
- The gateway holds the agents' keys: the Strike API wallets, the Cardano wallets, the Midnight wallet state. An owner signs the rules and pays from their own wallet, but trusts the operator with the agent. The agent's Strike key can trade, not withdraw; a payout goes to the wallet Strike registered, the agent's own, and from there to the owner.
- Strike's testnet pays out at most 100 ADA per asset and hour. A payout above that fails until the limit is respected; the page does not cap it yet.
- The slippage settings (2 % band, limits at the band's edge) suit an empty testnet book. On mainnet a 25 bps maker needs slippage under half its spread and maker orders first.
- A stopped agent that still holds inventory keeps its hedge: the rules refuse an order that would leave the inventory unhedged, so "pay out everything" is not yet one click.
- The Claude maker spends a capped budget of decisions a day and falls back to the rules when it is spent or the model is unreachable.
- Demo revenue is roughly zero: x402 calls, set-up fees and builder fees are test ADA.

## Roadmap

- Real assets on Midnight through a bridge, and Strike mainnet with its real book; slippage under half the spread, maker orders first.
- Outside market makers and takers with their own agents over the tools endpoint, paying per call; outside minds with a tools key.
- Payouts that respect Strike's withdrawal limits and unwind inventory and hedge together; a further deposit into a running agent; Strike key rotation.
- Custody: the owner holds the agent's keys, or a signer the owner and the operator share.
- NIGHT-USD hedging with real NIGHT on mainnet; sUSDrf as market-maker collateral with Borrow & Earn funding the perps margin.
- Agents in Midnight City trading through Strike with the same mandate gateway.

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
