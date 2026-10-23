/** A maker on two markets: a hedger per market, quotes on both pairs, a fill hedged on its own market; the coins an order mints per market. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateway } from "../gateway/gateway.mjs";
import { feedState } from "../gateway/feed.mjs";
import { onboardSteps } from "../gateway/onboard.mjs";
import { MARKETS } from "../gateway/markets.mjs";
import { profiles } from "../agents/profiles.mjs";

const T0 = Date.parse("2026-10-22T12:00:00Z");
const P = profiles({ owner: "o", expiry: "2026-10-23T15:00:00Z" });
const two = { ...P["mm-rule"], agentId: "duo", strike: { ...P["mm-rule"].strike, markets: ["BTC-USD", "ADA-USD"] }, midnight: { ...P["mm-rule"].midnight, pairs: ["tBTC/tUSD", "tADA/tUSD"] } };

/** A stand-in venue over two pairs: quotes remember their pair, a fill is reported with it. */
function venue(agentId, holdings) {
  const open = new Map();
  let n = 0;
  const v = {
    pair: "tBTC/tUSD", pairs: ["tBTC/tUSD", "tADA/tUSD"],
    get openQuotes() { return [...open.values()]; },
    async quote(q) { const quoteId = `q${++n}`; const row = { quoteId, agentId, side: q.side, sizeBtc: q.sizeBtc, price: q.price, pair: q.pair ?? "tBTC/tUSD", expiresAt: new Date(T0 + q.ttlSec * 1000).toISOString(), status: "open" }; open.set(quoteId, row); return { quoteId, pair: row.pair, side: q.side, sizeBtc: q.sizeBtc, price: q.price, expiresAt: row.expiresAt }; },
    async retire(id) { open.delete(id); return true; },
    async retireAll() { open.clear(); },
    fill(quoteId) { open.get(quoteId).status = "filled"; },
    async pollFills() { const out = []; for (const [id, row] of open) if (row.status === "filled") { open.delete(id); out.push({ id, pair: row.pair, side: row.side === "ask" ? "sell" : "buy", sizeBtc: row.sizeBtc, price: row.price, txHash: "cd".repeat(32), at: T0 }); } return out; },
    async board() { return []; },
    async holdings(pair = "tBTC/tUSD") { const h = holdings[pair]; return { ...h, bases: Object.fromEntries(Object.entries(holdings).map(([p, x]) => [p, { btc: x.btc, coins: 4, spendable: x.spendable.btc }])) }; },
  };
  return v;
}

test("a maker on BTC-USD and ADA-USD quotes both pairs at their own marks and hedges an ADA fill on ADA-USD", async () => {
  const orders = [];
  const strike = {
    placeOrder: async (o) => { orders.push(o); return { status: "pending" }; },
    balances: async () => [{ marginBalance: "300" }],
    positions: async () => ({ positions: [] }),
    openOrders: async () => ({ count: 0 }),
    cancelAll: async () => ({}),
  };
  const holdings = {
    "tBTC/tUSD": { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } },
    "tADA/tUSD": { btc: 2000, usd: 800, spendable: { btc: 900, usd: 320 } },
  };
  const v = venue("duo", holdings);
  const a = { agentId: "duo", mandate: two, mind: "maker", venue: v, strike, rules: { "BTC-USD": { step: 0.00001, tick: 0.1, minNotionalUsd: 100 }, "ADA-USD": { step: 1, tick: 0.0001, minNotionalUsd: 5 } }, stream: () => ({ close() {} }) };
  const feed = feedState({ runStart: "2026-10-22T12:00:00Z" });
  const log = [];
  const g = gateway({ agents: [a], mark: async () => ({ markets: { "BTC-USD": { mark: 80_000, funding: 0 }, "ADA-USD": { mark: 0.4, funding: 0 } } }), feed, log: (e) => { log.push(e); return e; }, now: () => T0, rnd: () => 0 });
  await g.round();
  const quotes = v.openQuotes;
  assert.deepEqual(quotes.map((q) => [q.pair, q.side]).sort(), [["tADA/tUSD", "ask"], ["tADA/tUSD", "bid"], ["tBTC/tUSD", "ask"], ["tBTC/tUSD", "bid"]]);
  const ada = quotes.filter((q) => q.pair === "tADA/tUSD");
  assert.ok(ada.every((q) => Number.isInteger(q.sizeBtc) && q.price > 0.39 && q.price < 0.41), `ADA quotes on a step of one around 0.40: ${JSON.stringify(ada)}`);
  assert.ok(quotes.filter((q) => q.pair === "tBTC/tUSD").every((q) => q.price > 79_000 && q.price < 81_000));
  assert.ok(g.hedgerOf("duo", "ADA-USD") && g.hedgerOf("duo", "BTC-USD") && g.hedgerOf("duo", "ADA-USD") !== g.hedgerOf("duo", "BTC-USD"), "one hedger per market");
  // the ADA ask fills: the hedge buys ADA on ADA-USD, its id names the market, the BTC books stay flat
  const ask = ada.find((q) => q.side === "ask");
  v.fill(ask.quoteId);
  await g.round();
  assert.equal(orders.length, 1);
  assert.deepEqual([orders[0].symbol, orders[0].side, orders[0].size], ["ADA-USD", "buy", ask.sizeBtc]);
  assert.match(orders[0].clientOrderId, /^duo-ada-hedge-/);
  assert.equal(g.hedgerOf("duo", "BTC-USD").state.midnightInventoryBtc, 0);
  assert.equal(g.hedgerOf("duo", "ADA-USD").state.midnightInventoryBtc, -ask.sizeBtc);
  const card = feed.get("agents").agents.find((x) => x.agentId === "duo");
  assert.deepEqual(Object.keys(card.legs), ["BTC-USD", "ADA-USD"]);
  assert.equal(card.legs["ADA-USD"].inventoryBtc, -ask.sizeBtc);
  assert.equal(card.status, "hedging");
  // the port: a quote on a named pair, an order on a named market, the room over both
  const port = g.portFor("duo");
  assert.deepEqual((await port.mandate()).markets, ["BTC-USD", "ADA-USD"]);
  const posted = await port.postQuote({ side: "bid", sizeBtc: 200, price: 0.3988, pair: "tADA/tUSD" }, "test");
  assert.equal(posted.refused, undefined, JSON.stringify(posted));
  assert.equal(posted.pair, "tADA/tUSD");
  assert.equal((await port.market({ symbol: "ADA-USD" })).mark, 0.4);
  await g.stop();
});

test("a market without a mark this round leaves the agent's equity and the loss stop's baseline as they were", async () => {
  const strike = { placeOrder: async () => ({ status: "pending" }), balances: async () => [{ marginBalance: "300" }], positions: async () => ({ positions: [] }) };
  const holdings = { "tBTC/tUSD": { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }, "tADA/tUSD": { btc: 2000, usd: 800, spendable: { btc: 900, usd: 320 } } };
  const a = { agentId: "duo", mandate: two, mind: "maker", venue: venue("duo", holdings), strike, rules: { "BTC-USD": { step: 0.00001, tick: 0.1, minNotionalUsd: 100 }, "ADA-USD": { step: 1, tick: 0.0001, minNotionalUsd: 5 } }, stream: () => ({ close() {} }) };
  const feed = feedState({ runStart: "2026-10-22T12:00:00Z" });
  let marks = { "BTC-USD": { mark: 80_000, funding: 0 }, "ADA-USD": { mark: 0.4, funding: 0 } };
  const log = [];
  const g = gateway({ agents: [a], mark: async () => ({ markets: marks }), feed, log: (e) => { log.push(e); return e; }, now: () => T0, rnd: () => 0 });
  await g.round();
  const card = () => feed.get("agents").agents.find((x) => x.agentId === "duo");
  const first = card().equityUsd;
  assert.ok(first > 0);
  marks = { "BTC-USD": { mark: 80_000, funding: 0 } };
  await g.round();
  assert.deepEqual([card().equityUsd, card().equityStartUsd], [first, first], "ADA without a mark: no reading, not one at BTC's mark");
  assert.ok(log.some((e) => e.kind === "no.mark" && e.symbol === "ADA-USD"));
  await g.stop();
});

test("a citizen taking an ADA quote is checked at ADA's mark, not BTC's", async () => {
  const taken = [];
  const ada = { quoteId: "o-ada", pair: "tADA/tUSD", side: "ask", sizeBtc: 564, price: 0.2132, maker: "t-ada1", expiresAt: new Date(T0 + 200_000).toISOString(), offer: "x" };
  const v = {
    pair: "tBTC/tUSD", pairs: ["tBTC/tUSD", "tADA/tUSD", "tSOL/tUSD"], openQuotes: [],
    async board() { return [ada]; }, async pollFills() { return []; }, async retireAll() {},
    async holdings() { return { btc: 0, usd: 500, coins: { tBTC: 0, tUSD: 4 }, spendable: { btc: 0, usd: 200 }, bases: {} }; },
    async take(q) { taken.push(q); return { status: "succeeded", txHash: "cd".repeat(32), landed: true }; },
  };
  const a = { agentId: "citizen-a", mandate: P["citizen-a"], mind: "citizen", side: "buy", venue: v };
  const feed = feedState({ runStart: "2026-10-22T12:00:00Z" });
  const log = [];
  const g = gateway({ agents: [a], mark: async () => ({ markets: { "BTC-USD": { mark: 80_000 }, "ADA-USD": { mark: 0.2127 } } }), feed, log: (e) => { log.push(e); return e; }, now: () => T0, rnd: () => 0.1 });
  await g.round();
  assert.deepEqual(log.filter((e) => e.kind === "refusal"), [], "no refusal: 564 ADA at 0.2132 is 120 USD, inside the 150 USD limit");
  assert.equal(taken.length, 1);
  assert.equal(log.find((e) => e.kind === "decision")?.mark, 0.2127);
});

test("an order on two markets mints coins of both base tokens and tUSD for each, sized at each market's mark", async () => {
  const mints = [];
  const mandate = { ...two, midnight: { ...two.midnight, maxQuoteUsd: 150 } };
  const steps = onboardSteps({
    agentId: "duo", index: 9, mandate, wallet: { address: "addr_test1x" }, owner: "o", fee: { lovelace: 0n, to: "addr_test1y" }, depositLovelace: 0n,
    mint: async (spec, amount, index) => { mints.push([spec, Number(amount), index]); return { status: "succeeded", txHash: "00" }; },
    markets: [{ ...MARKETS["BTC-USD"], minNotionalUsd: 100 }, { ...MARKETS["ADA-USD"], minNotionalUsd: 5 }],
    marks: async () => ({ "BTC-USD": { mark: 80_000 }, "ADA-USD": { mark: 0.4 } }),
    coins: 2, strike: {}, open: async () => ({}), register: async () => {}, quoted: () => true, sleep: async () => {}, now: () => T0, log: () => {},
  });
  const ctx = { data: {}, note() {}, set(k, v) { this.data[k] = v; } };
  const said = await steps.mint(ctx);
  assert.deepEqual(mints.map((m) => m[0]), ["market:tBTC", "market:tBTC", "market:tUSD", "market:tUSD", "market:tADA", "market:tADA", "market:tUSD", "market:tUSD"]);
  assert.deepEqual([mints[0][1], mints[2][1], mints[4][1], mints[6][1]], [196875, 15750, 393_750_000, 15750], "satoshi at 80000, cents, lovelace at 0.40, cents");
  assert.match(said, /2 coins of 0.00197 tBTC and 2 of 157.5 tUSD; 2 coins of 393.75 tADA and 2 of 157.5 tUSD/);
});
