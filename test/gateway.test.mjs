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
    // every order of the stub fills whole: the position Strike reports is their signed sum
    positions: async () => ({ positions: [{ symbol: "BTC-USD", size: orders.reduce((sum, o) => sum + (o.side === "buy" ? o.size : -o.size), 0).toFixed(5) }] }),
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
  // the quotes' coins count as the maker's: the ask's tBTC at the mark, the bid's tUSD at its price
  const reserved = agents[0].venue.openQuotes.reduce((sum, q) => sum + (q.side === "ask" ? q.sizeBtc * 80_000 : q.sizeBtc * q.price), 0);
  assert.ok(reserved > 0 && Math.abs(card0.midnight.reservedUsd - reserved) < 0.01, "reserved coins on the card");
  const equity0 = Math.round((800 + 0.01 * 80_000 + reserved + 386.05) * 100) / 100;
  assert.deepEqual([card0.wallets, card0.equityUsd, card0.equityStartUsd, card0.pnlPct, card0.day], [{ cardano: "addr_test1qmm", midnight: "hidden" }, equity0, equity0, 0, "2026-10-22"], "equity: Midnight holdings and reserved coins at the mark plus Strike margin");
  assert.equal(feed.get("quotes").quotes.length, 1, "the citizen took the ask in the same round, the bid stands");
  assert.deepEqual(feed.get("decisions").decisions.map((d) => d.action), ["midnight.take", "midnight.quote", "midnight.quote"]);
  assert.equal(feed.get("decisions").decisions[0].quoteId, "q1", "the take names its quote");
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
  assert.equal(h.state.strikePositionBtc, 0.00374, "Strike's own position after the resync: both hedges");
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


test("an agent added after two rounds quotes in the next one; its card appears, its stream opens, the same id twice is refused", async () => {
  const { venue } = world();
  const feed = feedState();
  const agents = [{ agentId: "citizen-a", mandate: P["citizen-a"], mind: "citizen", side: "buy", venue: venue("citizen-a", { btc: 0, usd: 500, spendable: { btc: 0, usd: 200 } }) }];
  let t = T0;
  const g = gateway({ agents, mark: async () => 80_000, feed, log: (e) => e, now: () => t, rnd: () => 1 });
  await g.round();
  t += 20_000;
  await g.round();
  assert.deepEqual(g.agentIds(), ["citizen-a"]);
  assert.equal(feed.get("quotes").quotes.length, 0, "nobody quotes yet");
  let streams = 0;
  const nova = { agentId: "nova-7", name: "NOVA-7", mandate: { ...P["mm-rule"], agentId: "nova-7" }, mind: "maker", venue: venue("nova-7", { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }), strike: { placeOrder: async () => ({ status: "pending" }) }, stream: () => { streams++; return { close() {} }; }, wallets: { cardano: "addr_test1qnova", midnight: "hidden" } };
  g.addAgent(nova);
  assert.deepEqual(g.agentIds(), ["citizen-a", "nova-7"]);
  assert.equal(streams, 1, "its Strike stream is open");
  const card0 = feed.get("agents").agents.find((a) => a.agentId === "nova-7");
  assert.deepEqual([card0.name, card0.type, card0.status, card0.wallets.cardano, card0.onboarding], ["NOVA-7", "mm", "starting", "addr_test1qnova", null]);
  assert.throws(() => g.addAgent(nova), /already in the loop/);
  t += 20_000;
  await g.round();
  assert.equal(feed.get("quotes").quotes.filter((q) => q.agentId === "nova-7").length, 2, "both sides quoted in the round after it joined");
  const card = feed.get("agents").agents.find((a) => a.agentId === "nova-7");
  assert.deepEqual([card.status, card.mandate.hash.length], ["quoting", 64]);
  assert.ok(g.portFor("nova-7"));
  await g.stop();
});

test("a hedge the stream never reports is looked up over REST after ten seconds: the fill counts, the maker is not frozen", async () => {
  const { venue } = world();
  const orders = [];
  const lookups = [];
  const strike = {
    placeOrder: async (o) => { orders.push(o); return { status: "pending" }; },
    balances: async () => [{ marginBalance: "386.05" }],
    order: async ({ clientOrderId }) => { lookups.push(clientOrderId); return { ClientOrderID: clientOrderId, Status: "filled", Filled: "0.00187", Price: "80005", CloseReason: "" }; },
    positions: async () => ({ positions: [] }),
  };
  const agents = [
    { agentId: "mm-rule", mandate: P["mm-rule"], mind: "maker", venue: venue("mm-rule", { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }), strike, stream: () => ({ close() {} }) },
    { agentId: "citizen-a", mandate: P["citizen-a"], mind: "citizen", side: "buy", venue: venue("citizen-a", { btc: 0, usd: 500, spendable: { btc: 0, usd: 200 } }) },
  ];
  let t = T0;
  const log = [];
  const g = gateway({ agents, mark: async () => 80_000, feed: feedState({ runStart: "2026-10-22T12:00:00Z" }), log: (e) => { log.push(e); return e; }, now: () => t, rnd: () => 0, saveBooks: () => {} });
  await g.round();
  t = T0 + 20_000;
  await g.round();
  const h = g.hedgerOf("mm-rule");
  assert.equal(h.pending.length, 1, "the ask was taken and hedged");
  assert.deepEqual(lookups, [], "a fresh order is not asked after");
  t = T0 + 25_000;
  await g.round();
  assert.deepEqual([h.pending.length, lookups], [1, []], "five seconds: still the stream's turn");
  t = T0 + 31_000;
  await g.round();
  assert.deepEqual(lookups, [orders[0].clientOrderId], "eleven seconds of silence: asked over REST");
  assert.equal(h.pending.length, 0);
  assert.equal(h.state.frozen, false);
  assert.equal(h.hedges.length, 1);
  assert.ok(!log.some((e) => e.kind === "hedge.late"));
  await g.stop();
});

test("the owner unwinds a stopped maker: it asks exactly its inventory, the citizen takes it, the hedge buys the short back, then it is stopped again with an unwound entry; a stop halts an unwind", async () => {
  const { venue } = world();
  const feed = feedState({ runStart: "2026-10-22T12:00:00Z" });
  const orders = [];
  let streamOn = null;
  const strike = {
    placeOrder: async (o) => { orders.push(o); return { status: "pending" }; },
    balances: async () => [{ marginBalance: "120" }],
    positions: async () => ({ positions: [{ symbol: "BTC-USD", size: "-0.00147" }] }),
    order: async ({ clientOrderId }) => ({ ClientOrderID: clientOrderId, Status: "open", Filled: "0" }),
    openOrders: async () => ({ count: 0 }),
  };
  const agents = [
    { agentId: "mm-rule", mandate: P["mm-rule"], mind: "maker", venue: venue("mm-rule", { btc: 0.00147, usd: 800, spendable: { btc: 0.00147, usd: 320 } }), strike, stream: (onEvent) => { streamOn = onEvent; return { close() {} }; } },
    { agentId: "citizen-a", mandate: P["citizen-a"], mind: "citizen", side: "buy", venue: venue("citizen-a", { btc: 0, usd: 500, spendable: { btc: 0, usd: 200 } }) },
  ];
  let t = T0;
  const log = [];
  // carried from the last run: 0.00147 tBTC hedged by a 0.00147 short
  const books = { "mm-rule": { midnightInventoryBtc: 0.00147, strikePositionBtc: -0.00147, unhedgedBtc: 0, frozen: false, frozenReason: null } };
  const g = gateway({ agents, mark: async () => 80_000, feed, log: (e) => { log.push(e); return e; }, now: () => t, rnd: () => 0, books, saveBooks: () => {}, minHedgeUsd: 100 });
  await g.stop("mm-rule");
  await g.round();
  const card = () => feed.get("agents").agents.find((a) => a.agentId === "mm-rule");
  assert.deepEqual([card().status, feed.get("quotes").quotes.length], ["stopped", 0], "stopped: nothing quoted, the hedge stays");
  const r = await g.unwind("mm-rule");
  assert.deepEqual([r.inventoryBtc, r.strikePositionBtc, r.inventoryUsd, card().status], [0.00147, -0.00147, 117.6, "unwinding"]);
  t += 20_000;
  await g.round();
  const asks = feed.get("decisions").decisions.filter((d) => d.agentId === "mm-rule" && d.action === "midnight.quote");
  assert.deepEqual(asks.map((d) => [d.side, d.sizeBtc]), [["ask", 0.00147]], "one ask, the inventory, no bid");
  assert.match(asks[0].reason, /unwinding: only the ask that sells the inventory down/);
  assert.equal(feed.get("quotes").quotes.length, 0, "the citizen took it");
  t += 20_000;
  await g.round();
  assert.deepEqual([orders.length, orders[0].side, orders[0].size], [1, "buy", 0.00147], "the fill's hedge buys the short back");
  assert.equal(card().status, "unwinding", "a hedge pending: not over yet");
  streamOn({ kind: "fill", clientOrderId: orders[0].clientOrderId, side: "BUY", size: "0.00147", price: "80010", at: t + 500 });
  t += 20_000;
  await g.round();
  const h = g.hedgerOf("mm-rule").state;
  assert.deepEqual([h.midnightInventoryBtc, h.strikePositionBtc, h.frozen, h.manual, card().status], [0, 0, true, true, "stopped"], "flat, stopped by hand again");
  const done = log.find((e) => e.kind === "unwound");
  assert.deepEqual([done.agent, done.inventoryBtc, done.strikePositionBtc, done.closed], ["mm-rule", 0, 0, "nothing to close"]);
  t += 20_000;
  await g.round();
  assert.equal(feed.get("quotes").quotes.length, 0, "stopped: quotes nothing");
  // an unwind halted by a stop, and a maker without a hedger cannot unwind
  const a = agents[0];
  await g.unwind("mm-rule");
  assert.equal(a.unwinding, true);
  await g.stop("mm-rule");
  assert.deepEqual([a.unwinding, a.stopped, card().status], [false, true, "stopped"]);
  await assert.rejects(g.unwind("citizen-a"), /no hedger/);
  await g.stop();
});

test("fills, decisions and refusals carry their pair; a quote past its expiry leaves the feed; a stopped agent's tools are refused with rule stopped and only its tool orders are cancelled", async () => {
  const { venue } = world();
  const feed = feedState({ runStart: "2026-10-22T12:00:00Z" });
  const cancelled = [];
  const strike = {
    placeOrder: async () => ({ status: "pending" }), balances: async () => [{ marginBalance: "300" }], positions: async () => ({ positions: [] }),
    openOrders: async () => ({ count: 2, orders: [{ ClientOrderID: "mm-rule-tool-1" }, { ClientOrderID: "mm-rule-hedge-9-1" }] }), cancel: async (o) => { cancelled.push(o.clientOrderId); return {}; },
  };
  const agents = [
    { agentId: "mm-rule", mandate: P["mm-rule"], mind: "maker", venue: venue("mm-rule", { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }), strike, stream: () => ({ close() {} }) },
    { agentId: "citizen-a", mandate: P["citizen-a"], mind: "citizen", side: "buy", venue: venue("citizen-a", { btc: 0, usd: 500, spendable: { btc: 0, usd: 200 } }) },
  ];
  let t = T0;
  const log = [];
  const g = gateway({ agents, mark: async () => 80_000, feed, log: (e) => { log.push(e); return e; }, now: () => t, rnd: () => 0 });
  feed.quoteOpen({ quoteId: "stale", agentId: "mm-rule", pair: "tBTC/tUSD", side: "ask", sizeBtc: 0.001, price: 81_000, expiresAt: "2026-10-22T11:59:00Z" });
  await g.round();
  assert.ok(!feed.get("quotes").quotes.some((q) => q.quoteId === "stale"), "lapsed before the round: gone from the feed");
  assert.deepEqual(feed.get("decisions").decisions.map((d) => [d.action, d.pair, d.symbol]), [["midnight.take", "tBTC/tUSD", "BTC-USD"], ["midnight.quote", "tBTC/tUSD", "BTC-USD"], ["midnight.quote", "tBTC/tUSD", "BTC-USD"]]);
  t = T0 + 20_000;
  await g.round();
  assert.equal(feed.get("fills").fills[0].midnight.pair, "tBTC/tUSD");
  await g.stop("mm-rule");
  assert.deepEqual(cancelled, ["mm-rule-tool-1"], "the tool order pulled, the hedger's own order left to it");
  const r = await g.portFor("mm-rule").postQuote({ side: "ask", sizeBtc: 0.001, price: 80_200 }, "an outside mind");
  assert.equal(r.refused.rule, "stopped");
  const ref = feed.get("refusals").refusals[0];
  assert.deepEqual([ref.rule, ref.pair, ref.symbol, ref.agentId], ["stopped", "tBTC/tUSD", "BTC-USD", "mm-rule"]);
  assert.equal((await g.portFor("mm-rule").closePosition("closed by the owner")).closed, 0, "an owner's reduce-only close still passes");
  await g.stop();
});

test("stop means flat: a resting hedge becomes a market order; when Strike cancels it a limit rests again and the card counts it; the stop and the hand freeze outlive a restart; a mandate signed anew reaches the hedger", async () => {
  const { venue } = world();
  const feed = feedState({ runStart: "2026-10-22T12:00:00Z" });
  const orders = [];
  let streamOn = null;
  const strike = { placeOrder: async (o) => { orders.push(o); return { status: "pending" }; }, balances: async () => [{ marginBalance: "300" }], positions: async () => ({ positions: [] }), order: async ({ clientOrderId }) => ({ ClientOrderID: clientOrderId, Status: "open", Filled: "0" }), openOrders: async () => ({ count: 0 }), cancel: async () => ({}) };
  const agents = [
    { agentId: "mm-rule", mandate: P["mm-rule"], mind: "maker", venue: venue("mm-rule", { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }), strike, stream: (onEvent) => { streamOn = onEvent; return { close() {} }; } },
    { agentId: "citizen-a", mandate: P["citizen-a"], mind: "citizen", side: "buy", venue: venue("citizen-a", { btc: 0, usd: 500, spendable: { btc: 0, usd: 200 } }) },
  ];
  let t = T0;
  const saved = {};
  const g = gateway({ agents, mark: async () => 80_000, feed, log: (e) => e, now: () => t, rnd: () => 0, saveBooks: (id, snap) => { saved[id] = snap; } });
  await g.round();
  t = T0 + 20_000;
  await g.round();
  const h = g.hedgerOf("mm-rule");
  assert.equal(orders.length, 1, "the fill's market hedge");
  await streamOn({ kind: "order", symbol: "BTC-USD", clientOrderId: orders[0].clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: t });
  assert.deepEqual([orders.length, orders[1].type, h.pending[0].resting], [2, "limit", true], "a thin book: the hedge rests as a limit");
  const r = await g.stop("mm-rule");
  assert.deepEqual([orders.length, orders[2].type, orders[2].side, orders[2].size, r.hedges["BTC-USD"].startsWith("market order")], [3, "market", "buy", 0.00187, true], "stop: the limit pulled, the remainder sent at once");
  await streamOn({ kind: "order", symbol: "BTC-USD", clientOrderId: orders[2].clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: t + 100 });
  t = T0 + 40_000;
  await g.round();
  const card = feed.get("agents").agents.find((a) => a.agentId === "mm-rule");
  assert.deepEqual([card.status, card.resting, card.pending, card.legs["BTC-USD"].resting, card.unhedgedUsd], ["stopped", 1, 1, 1, -149.6], "a limit rests again, the agent stays stopped");
  assert.deepEqual([saved["mm-rule"].stopped, saved["mm-rule"].frozen, saved["mm-rule"].manual], [true, true, true], "the books carry the stop and the hand freeze");
  // the same books in a new gateway: still stopped, still frozen by hand, the carried exposure hedged again without lifting the freeze
  const later = [];
  const a2 = { agentId: "mm-rule", mandate: P["mm-rule"], mind: "maker", venue: venue("mm-rule", { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }), strike: { ...strike, placeOrder: async (o) => { later.push(o); return { status: "pending" }; } }, stream: () => ({ close() {} }) };
  const g2 = gateway({ agents: [a2], mark: async () => 80_000, feed: feedState(), log: (e) => e, now: () => t, books: { "mm-rule": saved["mm-rule"] } });
  await g2.rehedge();
  const h2 = g2.hedgerOf("mm-rule");
  assert.deepEqual([a2.stopped, h2.state.frozen, h2.state.manual, later.length, later[0]?.type], [true, true, true, 1, "market"]);
  await g2.round();
  assert.equal(feed.get("quotes").quotes.filter((q) => q.agentId === "mm-rule").length, 0, "stopped: nothing quoted");
  // a mandate signed anew: the hedger's deadline and band follow it, the stop ends
  g2.setMandate("mm-rule", { ...P["mm-rule"], risk: { ...P["mm-rule"].risk, hedgeWithinSec: 7 } });
  assert.deepEqual([a2.stopped, h2.state.frozen, h2.state.mandate.risk.hedgeWithinSec], [false, false, 7]);
  // a payout moves the day's baseline down, a deposit up
  const b0 = feed.get("agents").agents[0] ? null : null;
  await g2.round();
  const start = feed.get("agents").agents.find((a) => a.agentId === "mm-rule").equityStartUsd;
  assert.equal(g2.adjustEquityStart("mm-rule", -20, "payout"), Math.round((start - 20) * 100) / 100);
  assert.equal(g2.adjustEquityStart("mm-rule", 50, "deposit"), Math.round((start + 30) * 100) / 100);
  assert.equal(g2.adjustEquityStart("ghost", 5, "x"), null);
  void b0;
  await g.stop();
  await g2.stop();
});

test("a rotated Strike key: the hedger's orders go through the new client, the old stream is closed and a new one opened, the position resynced", async () => {
  const { venue } = world();
  const feed = feedState();
  const placed = { old: 0, fresh: 0 };
  const closed = [];
  const mk = (name, size) => ({ placeOrder: async () => { placed[name]++; return { status: "pending" }; }, balances: async () => [{ marginBalance: "100" }], positions: async () => ({ positions: [{ symbol: "BTC-USD", size }] }), order: async () => ({ Status: "open", Filled: "0" }) });
  const a = { agentId: "mm-rule", mandate: P["mm-rule"], mind: "maker", venue: venue("mm-rule", { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }), strike: mk("old", "0"), stream: () => ({ close() { closed.push("old"); } }) };
  const log = [];
  const g = gateway({ agents: [a, { agentId: "citizen-a", mandate: P["citizen-a"], mind: "citizen", side: "buy", venue: venue("citizen-a", { btc: 0, usd: 500, spendable: { btc: 0, usd: 200 } }) }], mark: async () => 80_000, feed, log: (e) => { log.push(e); return e; }, now: () => T0, rnd: () => 0 });
  let opened = 0;
  await g.setStrike("mm-rule", { strike: mk("fresh", "-0.0005"), stream: () => { opened++; return { close() { closed.push("fresh"); } }; } });
  assert.deepEqual([closed, opened, g.hedgerOf("mm-rule").state.strikePositionBtc], [["old"], 1, -0.0005], "old stream closed, new one open, Strike's position taken over");
  assert.equal(log.at(-1).kind, "strike.rotated");
  await g.round();
  await g.round();
  assert.deepEqual([placed.old, placed.fresh > 0], [0, true], "the hedge after the citizen's take went through the new client");
  await assert.rejects(g.setStrike("citizen-a", {}), /no hedging agent/);
  await g.stop();
  assert.deepEqual(closed, ["old", "fresh"]);
});
