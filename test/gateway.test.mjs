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
  let streamOn = null, streamStatus = null;
  const lookups = [];
  const strike = {
    placeOrder: async (o) => { orders.push(o); return { status: "pending" }; },
    balances: async () => [{ asset: "USDT", walletBalance: "386.05", marginBalance: "386.05" }],
    order: async ({ clientOrderId }) => { lookups.push(clientOrderId); return { ClientOrderID: clientOrderId, Status: "filled", Filled: "0.00187", Price: "80005", CloseReason: "" }; },
    positions: async () => ({ positions: [{ symbol: "BTC-USD", size: "0.00187" }] }),
  };
  const agents = [
    { agentId: "mm-rule", mandate: P["mm-rule"], mind: "maker", venue: venue("mm-rule", { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }), strike, stream: (onEvent, onStatus) => { streamOn = onEvent; streamStatus = onStatus; return { close() {} }; }, wallets: { cardano: "addr_test1qmm", midnight: "hidden" } },
    { agentId: "citizen-a", mandate: P["citizen-a"], mind: "citizen", side: "buy", venue: venue("citizen-a", { btc: 0, usd: 500, spendable: { btc: 0, usd: 200 } }) },
  ];
  let t = T0;
  const saved = {};
  const g = gateway({ agents, mark: async () => 80_000, feed, log: (e) => { log.push(e); return e; }, now: () => t, rnd: () => 0, saveBooks: (id, snap) => { saved[id] = snap; } });
  await g.round();
  const card0 = feed.get("agents").agents.find((a) => a.agentId === "mm-rule");
  assert.deepEqual([card0.wallets, card0.equityUsd, card0.equityStartUsd, card0.pnlPct, card0.day], [{ cardano: "addr_test1qmm", midnight: "hidden" }, 800 + 0.01 * 80_000 + 386.05, 800 + 0.01 * 80_000 + 386.05, 0, "2026-10-22"], "equity: Midnight holdings at the mark plus Strike margin");
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

  streamOn({ kind: "fill", clientOrderId: "mm-claude-hedge-1-1", side: "SELL", size: "0.5", price: "80005", at: T0 + 6_900 });
  assert.equal(feed.get("fills").fills.length, 1, "another agent's Strike fill is not on this agent's feed");
  streamOn({ kind: "fill", clientOrderId: orders[0].clientOrderId, side: "BUY", size: "0.00187", price: "80005", fee: "0.07", builderFee: "0.15", at: T0 + 7_000 });
  assert.equal(h.pending.length, 0);
  assert.equal(h.hedges[0].latencyMs, 6_000);
  assert.equal(h.state.frozen, false);
  const fills = feed.get("fills").fills;
  assert.equal(fills.length, 2);
  assert.deepEqual(fills[1].hedge, { how: "market", clientOrderIds: [orders[0].clientOrderId], price: 80_005, latencySec: 6, at: "2026-10-22T12:00:07.000Z" }, "the Midnight fill carries the hedge that closed it");
  assert.equal(fills[0].strikeFill.clientOrderId, orders[0].clientOrderId);
  t = T0 + 40_000;
  await g.round();
  const card2 = feed.get("agents").agents.find((a) => a.agentId === "mm-rule");
  assert.deepEqual([card2.status, card2.hedges, card2.netDeltaUsd], ["quoting", 1, 0]);
  // the ask filled 25 bps over the mark: 0.00187 * 200 = 0.374 captured; the hedge bought 5 USD over the mark plus 0.22 of fees
  assert.deepEqual([card2.spreadCapturedUsd, card2.hedgeCostUsd, card2.strikeVolumeUsd, card2.builderFeesUsd], [0.37, 0.23, 149.61, 0.15]);
  assert.deepEqual([saved["mm-rule"].day.spreadCapturedUsd, saved["mm-rule"].day.date, saved["mm-rule"].midnightInventoryBtc], [0.37, "2026-10-22", -0.00187], "the day's figures live in the books next to the hedger's");
  assert.equal(feed.get("decisions").decisions.filter((d) => d.action === "midnight.take").length, 2, "hedged: the ask is requoted and the citizen takes it again");
  assert.equal(feed.get("quotes").quotes.length, 1);
  assert.ok(log.some((e) => e.kind === "hedge.filled"));

  // the stream drops and comes back while a hedge is pending: the order is looked up, its fill applied
  t = T0 + 60_000;
  await g.round();
  assert.equal(h.pending.length, 1, "the requoted ask was taken and hedged again");
  streamStatus({ state: "open" });
  assert.deepEqual(lookups, [], "the first open is the connect, nothing to reload");
  streamStatus({ state: "closed" });
  streamStatus({ state: "open" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lookups, [orders[1].clientOrderId]);
  assert.equal(h.pending.length, 0);
  assert.equal(h.state.strikePositionBtc, 0.00187, "Strike's own position after the resync");
  assert.ok(log.some((e) => e.kind === "stream.resynced"));
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

test("the rogue in the loop: one attempt a round, each refused with its rule on the feed, nothing ever built; the card says probing", async () => {
  const { venue } = world();
  const feed = feedState();
  const log = [];
  const built = [];
  const v = venue("rogue", { btc: 0, usd: 0, spendable: { btc: 0, usd: 0 } });
  v.quote = async (q) => { built.push(q); return { quoteId: "never" }; };
  const agents = [{ agentId: "rogue", mandate: P.rogue, mind: "rogue", venue: v, strike: { placeOrder: async (o) => { built.push(o); return {}; } } }];
  const g = gateway({ agents, mark: async () => 80_000, feed, log: (e) => { log.push(e); return e; }, now: () => T0 });
  for (let i = 0; i < 8; i++) await g.round();
  const refusals = feed.get("refusals").refusals;
  assert.equal(refusals.length, 8);
  assert.ok(new Set(refusals.map((r) => r.rule)).size >= 5, refusals.map((r) => r.rule).join(","));
  assert.ok(refusals.some((r) => r.venue === "strike") && refusals.some((r) => r.venue === "midnight"));
  assert.deepEqual(built, []);
  assert.equal(feed.get("decisions").decisions.length, 0);
  assert.equal(feed.get("agents").agents[0].status, "probing");
  assert.ok(log.every((e) => e.kind !== "rogue.passed"));
  await g.stop();
});

test("Claude's size under Strike's smallest hedge is lifted to that floor, and Claude is told the floor", async () => {
  const { venue } = world();
  const feed = feedState();
  const seen = [];
  const brain = { decide: async (v) => { seen.push(v); return { pause: false, spreadBps: 40, sizeUsd: 60, reason: "small and wide" }; } };
  const agents = [{ agentId: "mm-claude", mandate: P["mm-claude"], mind: "maker", brain, venue: venue("mm-claude", { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }), strike: { placeOrder: async () => ({}) } }];
  const g = gateway({ agents, mark: async () => 80_000, feed, log: (e) => e, now: () => T0, minHedgeUsd: 100 });
  await g.round();
  assert.equal(seen[0].mandate.minQuoteUsd, 100);
  const quotes = feed.get("quotes").quotes;
  assert.equal(quotes.length, 2);
  assert.ok(quotes.every((q) => q.sizeBtc * 80_000 >= 100 - 1e-6), "quotes at least the hedge minimum");
  assert.match(feed.get("decisions").decisions[0].reason, /small and wide/);
  await g.stop();
});

