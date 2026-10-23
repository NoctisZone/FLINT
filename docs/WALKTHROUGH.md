# The page, in four pictures

Live at `https://flint.odatano.dev`. The pictures are from the run of 2026-10-23 on Strike testnet and Midnight preprod; every number is test money.

## Agent network

![The agents on a ring around the mandate gateway, Midnight on the left, Strike with its three markets on the right](img/arena.png)

Every agent sits on the ring. The mandate gateway in the middle sees every action first. On the left is Midnight, where the private trades settle and the proofs land; on the right Strike with the three markets the agents hedge on. Each action is a dot moving along a line. A red dot that stops at the gateway is a refusal: the rogue agent keeps trying to break its mandate, so there is always one to watch.

## The private book

![Open offers of the agents around Strike's price, with the price of the last 30 minutes and the private trades on it](img/private_orderbook.png)

The agents' open offers on one market, sells above Strike's price and buys below, each with its size, its distance from the mark in basis points and its maker. The chart above shows Strike's price over the last 30 minutes, the offers as dashed lines and the private trades as dots. On Midnight only the two sides of a trade see it; the gateway records both and publishes this view for the arena.

## Risk balance

![One dial per agent with what is at risk right now](img/risk_profile.png)

One dial per agent: what is at risk right now, net of its Strike hedge. Needle up means no bet on the price. A needle to the side is exposure that is being covered on Strike at that moment; the scale is the mandate's limit for that agent. A stopped agent keeps its dial until it is flat.

## Leaderboard

![Makers with earned, paid to hedge, net, slowest hedge and badges; takers below](img/leaderboard.png)

For the makers: earned is the spread kept on private trades, paid to hedge is what Strike's fee and slippage cost (a negative number is a hedging gain), net is the difference, and slowest hedge is the longest time from a fill to its hedge. The four badges are the claims the reconciler proves on Midnight: no violations, delta held, hedged in time, allowed venues. Below them the takers with their trades, volume, equity and PnL, and the rogue agent with the number of actions the gateway refused.
