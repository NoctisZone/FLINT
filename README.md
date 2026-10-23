# Flint

Private market makers on Midnight, hedged on Strike, inside a mandate their owner signed.

Autonomous agents, each with a Cardano and a Midnight wallet, quote tBTC/tUSD, tADA/tUSD or tSOL/tUSD on Midnight's offer board. Every fill is hedged on the matching Strike perpetual (BTC-USD, ADA-USD or SOL-USD) within seconds. A mandate gateway checks every action against the owner's limits before anything is built, logs every decision in a hash-linked log, and reconciles both venues. Outside agents reach the same tools over MCP and pay per call with x402 on Cardano.

- The feed and the owner API, route by route: `docs/API.md`

## Run

```bash
npm install
cp .env.example .env     # keys: NIGHTGATE, Strike, Anthropic, ODATANO; see the file
node --test "test/*.test.mjs"
npm run mock-feed        # the arena's feed with made-up numbers on :4481
npm run gateway -- --agents mm-rule:0,citizen-b:1,citizen-a:2,mm-claude:3,rogue:4 --rounds 20 --round-ms 30000 --port 4482 --tools-port 4483
npm run liquidity        # the stand-in market maker on Strike testnet, all three markets
```

The gateway needs Midnight preprod (an indexer, a node, a proof server on localhost) and a Strike testnet account; `.env.example` names every setting.

A quote is a proven swap half waiting for its taker. By default it waits on the offer board of the agent's NIGHTGATE server (`--board server`). With `--board gateway` it waits inside the gateway instead: the maker's half is handed to the taker by this process and the swap settles on chain exactly as from the board, one atomic transaction, sponsored. That mode runs on a network where the offer board is not live yet; the feed says which one is on in `meta.midnightBoard`.

## The arena page

`arena/flint.html` is the page over the feed, one file. The gateway and the mock feed serve it at `/`, so after `npm run mock-feed` it is at `http://localhost:4481/`, and a running gateway shows the live run the same way; opened as a file it simulates a run (`arena/README.md` has the switches).

Two views. The **Arena** is public: the agent network (the agents, the gateway, Midnight with its private trades and proofs, Strike with its three markets; every action a moving dot), the counters, one trade followed from offer to proof, the private book on Strike's price with a switch between BTC, ADA and SOL, the risk dials, what the agents say, what the rules caught, the proofs on Midnight, and a tour. **Your agents** works with a CIP-30 wallet on preprod (Lace, Eternl or Vespr; a picker when several are installed): the wallet whose address the mandates name as owner signs in over `/owner/` and sees its agents, each with a terminal (offers, trades, hedges, decisions, refusals, rules, money, keys) and the controls pause, stop, close position and unwind.

An owner orders a new agent there and pays for it from their wallet: name, style, mind (rules or Claude) and the markets it may trade (any of the three), one signature over its rules, one transaction that carries the set-up fee to the project and the deposit to the agent's own wallet, which puts it into its own Strike account (Strike accepts deposits only from the wallet it registered for the account). The gateway then gives the agent a Midnight wallet with test coins for each market, anchors its mandate and puts it in the loop with the others; the page follows the nine steps and the agent quotes within about eight minutes. Money comes back the same way: a payout takes it off Strike to the agent's wallet and on to the owner's, capped by Strike's limits; a deposit into a running agent is paid like an order. An agent's rules can be changed and signed again at any time; its markets cannot. Each agent can have a tools key, issued by its owner, which an outside mind sends as a bearer token to the agent's tools address; without one the address stays open. The owner can also rotate the agent's Strike API key. An agent that sets itself up over the API pays the set-up fee with x402 and the deposit money with its own key. Agents made this way are listed in `data/agents.json` and come back on every restart.

## Strike integration

Strike is where every agent hedges. What the gateway does with it:

- **One Strike account per agent**, made by builder connect: the agent's own Cardano wallet signs Strike's challenge, Strike opens the account and an API wallet, the builder fee is set on the account. Deposits go through Strike's quote, build-tx and confirm calls, signed by the agent's wallet, at set-up and later from the page; payouts through withdraw quote and confirm, signed the same way, and Strike pays to that wallet. The owner can rotate the agent's API wallet through builder connect again.
- **A hedge on every fill.** A Midnight fill is seen on the offer board; the hedger sends a market order on the agent's market within a second, inside the mandate's price band. A market order the thin book cannot fill rests as a limit at the edge of the band; a fill on the other side nets the oldest exposure instead of a new order; dust under 5 USD is carried. Sizes are multiples of Strike's step and never under its minimum notional, so every fill can be hedged as is.
- **The user stream plus REST.** Fills and order states come over Strike's user stream; a pending order the stream has said nothing about for ten seconds is looked up over REST, so a missed message is not a frozen agent. After a reconnect the position Strike reports wins over the books.
- **The watchdog.** A hedge later than the mandate's `hedgeWithinSec` freezes the agent: it may only quote the side that reduces its delta until nothing is left unhedged.
- **Leverage and the builder fee** come from the mandate: leverage is set on each of the agent's markets at start, every order carries `X-Builder-Fee-Bps`.
- **One hedger per market.** An agent on several markets keeps separate books, exposures and Strike orders for each; its limits hold on each market.
- **The reconciler** reads Strike's own fill history every five rounds and at shutdown and checks it against the decision log and the mandate: fills without a hedge, hedges late, venues outside the mandate, net delta over the limit. Its four claims are proven on Midnight as badges.
- **The capital trail** reads Strike's deposit record and the Cardano transactions behind it, so the money an agent hedges with can be followed on chain.

## Risks and honest limits

- tBTC, tADA, tSOL and tUSD are the project's own tokens on Midnight preprod; there is no bridge. An agent trades the markets chosen when it is ordered, one or all three, with a hedger per market and its limits holding on each; the citizens take on all three. The citizens that take quotes are the team's own counterparties.
- Strike runs on testnet. Its books have no market maker, so `npm run liquidity` quotes both sides of BTC-USD, ADA-USD and SOL-USD from a separate account of ours and the feed says so in `meta.strikeLiquidity`; on mainnet the real book takes that role. No real money moves anywhere.
- ADA-USD is closed for new agents while Strike's testnet engine carries a minimum limit price above ADA's mark, so nothing there can be hedged (`MARKETS_OFF`, shown in `meta.orders.marketsOff` and greyed out on the page); the stand-in skips such a market too. Agents already on it keep their mandate.
- Between a fill and its hedge there is leg risk. The watchdog bounds it to `hedgeWithinSec` and freezes the agent after that; it does not remove it.
- The proofs on Midnight cover what the gateway recorded. They hide the numbers, they do not make Strike's data trustless; the reconciler is what ties them to Strike's fill history.
- The gateway holds the agents' keys: the Strike API wallets, the Cardano wallets, the Midnight wallet state. An owner signs the rules and pays from their own wallet, but trusts the operator with the agent. The agent's Strike key can trade, not withdraw; a payout goes to the wallet Strike registered, the agent's own, and from there to the owner.
- Strike pays out at most a set amount of ADA per asset per hour and per day (100 and 500 on testnet). A larger payout is capped at what is left and the page says when the rest can follow.
- The slippage settings (2 % band, limits at the band's edge) suit an empty testnet book. On mainnet a 25 bps maker needs slippage under half its spread and maker orders first.
- A stopped agent that still holds inventory keeps its hedge: the rules refuse an order that would leave the inventory unhedged. Unwind sells the inventory down on Midnight, hedged fill by fill, closes the hedge and stops the agent; what the inventory becomes stays in its Midnight wallet, so "pay out everything" then takes the Strike balance.
- The Claude maker spends a capped budget of decisions a day and falls back to the rules when it is spent or the model is unreachable.
- Demo revenue is roughly zero: x402 calls, set-up fees and builder fees are test ADA.

## Roadmap

- Real assets on Midnight through a bridge, and Strike mainnet with its real book; slippage under half the spread, maker orders first.
- Outside market makers and takers with their own agents over the tools endpoint, paying per call.
- Custody: the owner holds the agent's keys, or a signer the owner and the operator share.
- NIGHT-USD hedging with real NIGHT on mainnet; sUSDrf as market-maker collateral with Borrow & Earn funding the perps margin.
- Agents in Midnight City trading through Strike with the same mandate gateway.

## Layout

```
arena/     the page over the feed, one file, with its design notes, logos and fonts
gateway/   mandate, checks, markets, hedge, midnight venue, the two boards a quote can wait on, strike client, stream and builder connect, cardano wallets and transfers, chain reads over ODATANO, onboarding, payouts, owner API, registry, tools keys, capital trail, x402, tools, feed, log, reconcile, attestations, liquidity plan, gateway loop
agents/    mandate profiles, rule maker and citizens, the Claude maker, rogue
cli/       gateway, owner (the owner's console headless), onboard (treasury, Strike accounts and deposits by hand), liquidity (the stand-in market maker), strike, live (Midnight by hand), rogue, pay-demo, mock-feed
market/    the Midnight side: token factory, offer board, a wallet over its NIGHTGATE MCP server
facilitator/  an x402 facilitator over the ODATANO API
test/      node --test, stand-ins for every venue; no chain
```
