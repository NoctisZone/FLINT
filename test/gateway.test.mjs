/** The assembled gateway over stand-in venues and a stand-in Strike: two rounds of maker, citizen, fill and hedge. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateway } from "../gateway/gateway.mjs";
import { feedState } from "../gateway/feed.mjs";
import { profiles } from "../agents/profiles.mjs";

const P = profiles({ owner: "o", expiry: "2026-10-23T15:00:00Z" });
const T0 = Date.parse("2026-10-22T12:00:00Z");

/** A shared stand-in board: venues post to it, citizens read it, a take fills the row. */
function world() {
  const board = new Map();
  let n = 0;
  const venue = (agentId, holdings) => {
    const open = new Map();
    const fills = [];
    return {
      pair: "tBTC/tUSD",
      get openQuotes() { return [...open.values()]; },
      async quote(q) { const quoteId = `q${++n}`; const row = { quoteId, agentId, ...q, maker: agentId, expiresAt: new Date(T0 + q.ttlSec * 1000).toISOString(), status: "open" }; open.set(quoteId, row); board.set(quoteId, row); return { quoteId, side: q.side, sizeBtc: q.sizeBtc, price: q.price, expiresAt: row.expiresAt }; },
      async retire(id) { open.delete(id); board.delete(id); return true; },
      async retireAll() { open.clear(); },
      async take(q) { const row = board.get(q.quoteId); row.status = "filled"; row.txHash = "cd".repeat(32); board.delete(q.quoteId); return { status: "succeeded", txHash: row.txHash, landed: true }; },
      async pollFills() { const out = []; for (const [id, row] of open) if (row.status === "filled") { open.delete(id); out.push({ id, pair: "tBTC/tUSD", side: row.side === "ask" ? "sell" : "buy", sizeBtc: row.sizeBtc, price: row.price, txHash: row.txHash, at: T0 + 1000 }); } fills.push(...out); return out; },
      async board() { return [...board.values()].filter((r) => r.status === "open"); },
      async holdings() { return holdings; },
    };
  };
  return { board, venue };
}

test("round one quotes both sides; the citizen takes the ask; round two sees the fill and hedges it on Strike; the feed shows it all", async () => {
  const { venue } = world();
  const orders = [];
  const log = [];
  const feed = feedState({ runStart: "2026-10-22T12:00:00Z" });
  let streamOn = null;
  const agents = [
    { agentId: "mm-rule", mandate: P["mm-rule"], mind: "maker", venue: venue("mm-rule", { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }), strike: { placeOrder: async (o) => { orders.push(o); return { status: "pending" }; } }, stream: (onEvent) => { streamOn = onEvent; return { close() {} }; } },
    { agentId: "citizen-a", mandate: P["citizen-a"], mind: "citizen", side: "buy", venue: venue("citizen-a", { btc: 0, usd: 500, spendable: { btc: 0, usd: 200 } }) },
  ];
  let t = T0;
  const g = gateway({ agents, mark: async () => 80_000, feed, log: (e) => { log.push(e); return e; }, now: () => t, rnd: () => 0 });
  await g.round();
  assert.equal(feed.get("quotes").quotes.length, 1, "the citizen took the ask in the same round, the bid stands");
  assert.deepEqual(feed.get("decisions").decisions.map((d) => d.action), ["midnight.take", "midnight.quote", "midnight.quote"]);
  assert.equal(orders.length, 0, "no hedge before the fill is seen");

  t = T0 + 20_000;
  await g.round();
  assert.equal(orders.length, 1, "the fill was seen and hedged");
  assert.deepEqual([orders[0].side, orders[0].size, orders[0].type], ["buy", 0.00187, "market"]);
  const h = g.hedgerOf("mm-rule");
  assert.equal(h.pending.length, 1);
  assert.equal(feed.get("fills").fills.length, 1);
  assert.equal(feed.get("fills").fills[0].midnight.side, "sell");
  const card = feed.get("agents").agents.find((a) => a.agentId === "mm-rule");
  assert.equal(card.status, "hedging");
  assert.ok(card.mandate.hash.length === 64);
  assert.equal(feed.get("quotes").quotes.length, 1, "a second ask would double the unhedged exposure: the maker does not even try");
  assert.equal(feed.get("refusals").refusals.length, 0);

  streamOn({ kind: "fill", clientOrderId: orders[0].clientOrderId, side: "BUY", size: "0.00187", price: "80005", at: T0 + 7_000 });
  assert.equal(h.pending.length, 0);
  assert.equal(h.hedges[0].latencyMs, 6_000);
  assert.equal(h.state.frozen, false);
  t = T0 + 40_000;
  await g.round();
  const card2 = feed.get("agents").agents.find((a) => a.agentId === "mm-rule");
  assert.deepEqual([card2.status, card2.hedges, card2.netDeltaUsd], ["quoting", 1, 0]);
  assert.equal(feed.get("decisions").decisions.filter((d) => d.action === "midnight.take").length, 2, "hedged: the ask is requoted and the citizen takes it again");
  assert.equal(feed.get("quotes").quotes.length, 1);
  assert.ok(log.some((e) => e.kind === "hedge.filled"));
  await g.stop();
});

test("a frozen maker pulls its quotes and a refused action lands in the refusal feed", async () => {
  const { venue } = world();
  const feed = feedState();
  const log = [];
  const a = { agentId: "mm-rule", mandate: P["mm-rule"], mind: "maker", venue: venue("mm-rule", { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }), strike: { placeOrder: async () => ({}) } };
  const g = gateway({ agents: [a], mark: async () => 80_000, feed, log: (e) => { log.push(e); return e; }, now: () => T0 });
  await g.round();
  assert.equal(feed.get("quotes").quotes.length, 2);
  g.freeze("mm-rule", "test");
  await g.round();
  assert.equal(feed.get("quotes").quotes.length, 0);
  assert.equal(feed.get("agents").agents[0].status, "frozen");
  g.resume("mm-rule");
  a.mandate = { ...a.mandate, midnight: { ...a.mandate.midnight, maxOpenQuotes: 0 } };
  await g.round();
  assert.equal(feed.get("refusals").refusals[0].rule, "midnight.maxOpenQuotes");
  assert.equal(feed.get("quotes").quotes.length, 0);
});

test("an agent's port: mandate room, preview, a refused and an accepted quote, a take by the citizen's port, cancel all", async () => {
  const { venue } = world();
  const feed = feedState();
  const log = [];
  const agents = [
    { agentId: "mm-rule", mandate: P["mm-rule"], mind: "maker", venue: venue("mm-rule", { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }), strike: { placeOrder: async () => ({ status: "pending" }), openOrders: async () => ({ count: 0 }), cancelAll: async () => ({}) } },
    { agentId: "citizen-a", mandate: P["citizen-a"], mind: "citizen", side: "buy", venue: venue("citizen-a", { btc: 0, usd: 500, spendable: { btc: 0, usd: 200 } }) },
  ];
  const g = gateway({ agents, mark: async () => ({ mark: 80_000, funding: 0.00001 }), feed, log: (e) => { log.push(e); return e; }, now: () => T0, rnd: () => 1 });
  await g.round();
  const mm = g.portFor("mm-rule");
  const m = await mm.mandate();
  assert.equal(m.hash.length, 64);
  assert.deepEqual(m.room, { netDeltaUsd: 150, positionUsd: 300, openQuotes: 2, actionsThisMinute: 10 });
  assert.equal((await mm.market()).mark, 80_000);
  assert.deepEqual(await mm.preview({ venue: "midnight", kind: "quote", side: "ask", sizeBtc: 0.01, price: 80_200 }), { ok: false, refused: { rule: "midnight.maxQuoteUsd", limit: 150, attempted: 800, message: "quote larger than the mandate allows" } });
  assert.equal((await mm.postQuote({ side: "ask", sizeBtc: 0.001, price: 90_000 }, "greedy")).refused.rule, "midnight.maxSpreadBps");
  assert.equal(feed.get("refusals").refusals[0].rule, "midnight.maxSpreadBps");
  const q = await mm.postQuote({ side: "ask", sizeBtc: 0.0005, price: 80_200 }, "a small ask");
  assert.ok(q.quoteId);
  assert.equal(feed.get("quotes").quotes.length, 3);
  const cz = g.portFor("citizen-a");
  assert.equal((await cz.takeQuote("nope", "x")).error, "no open quote nope");
  const t = await cz.takeQuote(q.quoteId, "cheap enough");
  assert.equal(t.landed, true);
  assert.equal(feed.get("quotes").quotes.length, 2);
  // the taken quote is still on the maker's books until the next fill poll, so three are retired here
  assert.deepEqual(await mm.cancelAll(), { quotes: 3, strike: 0 });
  assert.equal((await mm.account()).openQuotes.length, 0);
  assert.throws(() => g.portFor("ghost"), /no agent ghost/);
});
