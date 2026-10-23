/** Hedge on fill against a stand-in Strike: the order, the match, netting, the books, resting limits, the watchdog. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hedger } from "../gateway/hedge.mjs";
import { check } from "../gateway/checks.mjs";
import { profiles } from "../agents/profiles.mjs";

const MARK = 80_000;
const M = profiles({ owner: "o", expiry: "2026-10-23T15:00:00Z" })["mm-rule"];
const T0 = Date.parse("2026-10-22T12:00:00Z");

function setup({ placeOrder, state, minNotionalUsd = 0 } = {}) {
  const orders = [];
  const cancels = [];
  const log = [];
  let t = T0;
  const h = hedger({
    mandate: M, symbol: "BTC-USD", minNotionalUsd,
    strike: { mark: () => MARK, placeOrder: placeOrder ?? (async (o) => { orders.push(o); return { status: "pending" }; }), cancel: async (o) => { cancels.push(o); return {}; } },
    log: (e) => log.push(e), now: () => t,
    state: { equityStartUsd: 1000, equityNowUsd: 1000, ...state },
  });
  return { h, orders, cancels, log, clock: (ms) => { t = ms; } };
}
const fill = (o = {}) => ({ id: "q-1", pair: "tBTC/tUSD", side: "sell", sizeBtc: 0.001, price: 80_400, txHash: "ab".repeat(32), at: T0, ...o });
const kinds = (log) => log.map((e) => e.kind);

test("a Midnight sell fill places a Strike market buy of the same size; the Strike fill closes the loop with its latency", async () => {
  const { h, orders, log, clock } = setup();
  const r = await h.onFill(fill());
  assert.ok(r.placed);
  assert.deepEqual([orders[0].symbol, orders[0].side, orders[0].type, orders[0].size, orders[0].clientOrderId], ["BTC-USD", "buy", "market", 0.001, r.clientOrderId]);
  assert.equal(h.state.midnightInventoryBtc, -0.001);
  assert.equal(h.state.unhedgedBtc, -0.001);
  assert.equal(h.pending.length, 1);
  clock(T0 + 6_200);
  await h.onStrikeEvent({ kind: "fill", symbol: "BTC-USD", clientOrderId: r.clientOrderId, side: "BUY", size: "0.001", price: "80010", at: T0 + 6_200 });
  assert.equal(h.pending.length, 0);
  assert.equal(h.hedges.length, 1);
  assert.equal(h.hedges[0].latencyMs, 6_200);
  assert.equal(h.maxLatencyMs, 6_200);
  assert.equal(h.state.unhedgedBtc, 0);
  assert.equal(h.state.strikePositionBtc, 0.001);
  assert.equal(h.state.midnightInventoryBtc + h.state.strikePositionBtc, 0, "net delta flat");
  assert.deepEqual(kinds(log), ["fill", "hedge.placed", "hedge.filled"]);
  assert.equal(h.state.frozen, false);
});

test("a buy fill hedges with a sell; two partial Strike fills complete one hedge", async () => {
  const { h, orders } = setup();
  const r = await h.onFill(fill({ id: "q-2", side: "buy", sizeBtc: 0.002 }));
  assert.equal(orders[0].side, "sell");
  await h.onStrikeEvent({ kind: "fill", clientOrderId: r.clientOrderId, side: "SELL", size: "0.0012", price: "80000", at: T0 + 1000 });
  assert.equal(h.pending.length, 1);
  assert.equal(h.state.unhedgedBtc, 0.0008);
  await h.onStrikeEvent({ kind: "fill", clientOrderId: r.clientOrderId, side: "SELL", size: "0.0008", price: "80000", at: T0 + 1500 });
  assert.equal(h.pending.length, 0);
  assert.equal(h.state.unhedgedBtc, 0);
  assert.equal(h.hedges[0].latencyMs, 1500);
});

test("a fill on the other side nets the older exposure first; the resting limit is pulled and only the remainder goes to Strike", async () => {
  const { h, orders, cancels, log, clock } = setup();
  await h.onFill(fill({ id: "a", side: "buy", sizeBtc: 0.002, at: T0 }));
  await h.onStrikeEvent({ kind: "order", clientOrderId: orders[0].clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 100 });
  assert.equal(h.pending[0].resting, true);
  clock(T0 + 4_000);
  await h.onFill(fill({ id: "b", side: "sell", sizeBtc: 0.0015, at: T0 + 4_000 }));
  assert.deepEqual(h.hedges.map((x) => [x.fill.id, x.hedge.how, x.latencyMs]), [["b", "netted", 0]], "b is hedged on arrival; a is only partly netted");
  assert.equal(h.state.unhedgedBtc, 0.0005);
  assert.deepEqual(h.exposures.map((e) => [e.fillId, e.remaining]), [["a", 0.0005]]);
  assert.equal(cancels.length, 1, "the resting limit was pulled");
  assert.ok(kinds(log).includes("hedge.pulled"));
  const placed = log.filter((e) => e.kind === "hedge.placed");
  assert.equal(placed.at(-1).sizeBtc, 0.0005, "the net 0.0005 is hedged");
  await h.onStrikeEvent({ kind: "fill", clientOrderId: placed.at(-1).clientOrderId, side: "SELL", size: "0.0005", price: "80000", at: T0 + 5_000 });
  assert.equal(h.hedges.length, 2);
  const a = h.hedges.find((x) => x.fill.id === "a");
  assert.equal(a.latencyMs, 5_000);
  assert.deepEqual([a.hedge.how, a.hedge.clientOrderIds, a.hedge.price], ["netted", [placed.at(-1).clientOrderId], 80_000], "mostly netted, the rest by one Strike fill");
  assert.deepEqual(a.hedge.parts.map((x) => [x.how, x.sizeBtc]), [["netted", 0.0015], ["market", 0.0005]]);
  assert.equal(h.state.unhedgedBtc, 0);
});

test("a fill that fully nets an older one is a hedge by netting, with the netting fill's time as latency", async () => {
  const { h, orders, log } = setup();
  await h.onFill(fill({ id: "a", side: "buy", sizeBtc: 0.001, at: T0 }));
  await h.onStrikeEvent({ kind: "order", clientOrderId: orders[0].clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 100 });
  await h.onFill(fill({ id: "b", side: "sell", sizeBtc: 0.001, at: T0 + 3_000 }));
  assert.deepEqual(h.hedges.map((x) => [x.fill.id, x.hedge.how, x.latencyMs]), [["a", "netted", 3_000], ["b", "netted", 0]], "both fills are hedged, neither by Strike");
  assert.equal(h.state.unhedgedBtc, 0);
  assert.equal(h.pending.length, 0);
  assert.equal(orders.length, 2, "no third order: nothing left to hedge");
  assert.ok(kinds(log).includes("hedge.netted"));
});

test("the watchdog freezes once when a hedge misses its deadline; only the reducing side may act; the freeze lifts when nothing is left", async () => {
  const { h, log, clock } = setup();
  const r = await h.onFill(fill());
  clock(T0 + M.risk.hedgeWithinSec * 1000);
  assert.deepEqual(h.tick(), [], "on the deadline is not late");
  clock(T0 + M.risk.hedgeWithinSec * 1000 + 1);
  assert.deepEqual(h.tick(), [r.clientOrderId]);
  assert.equal(h.state.frozen, true);
  assert.match(h.state.frozenReason, /not filled within 30s/);
  h.tick();
  assert.equal(log.filter((e) => e.kind === "hedge.late").length, 1, "logged once");
  assert.equal(check({ venue: "midnight", kind: "quote", pair: "tBTC/tUSD", side: "ask", sizeBtc: 0.001, price: MARK * 1.005, ttlSec: 60 }, h.state).rule, "frozen", "an ask would add to the short");
  assert.equal(check({ venue: "midnight", kind: "quote", pair: "tBTC/tUSD", side: "bid", sizeBtc: 0.0005, price: MARK * 0.995, ttlSec: 60 }, h.state), null, "a bid reduces the short: allowed while frozen");
  assert.equal(check({ venue: "strike", kind: "order", symbol: "BTC-USD", side: "buy", sizeBtc: 0.001 }, h.state), null, "the late hedge itself is still allowed");
  await h.onStrikeEvent({ kind: "fill", clientOrderId: r.clientOrderId, side: "BUY", size: "0.001", price: "80000", at: T0 + 40_000 });
  assert.equal(h.state.frozen, false, "hedged late, but hedged");
  assert.equal(log.at(-1).kind, "resumed");
});

test("a rejected hedge order, or one Strike does not accept, freezes the agent; the exposure stays on the books", async () => {
  const a = setup();
  const r = await a.h.onFill(fill());
  await a.h.onStrikeEvent({ kind: "order", clientOrderId: r.clientOrderId, status: "REJECTED", terminal: true, closeReason: "insufficient_balance", at: T0 + 100 });
  assert.equal(a.h.state.frozen, true);
  assert.match(a.h.state.frozenReason, /rejected: insufficient_balance/);
  const b = setup({ placeOrder: async () => { throw new Error("Strike 503 on /v2/order: service unavailable"); } });
  const r2 = await b.h.onFill(fill());
  assert.equal(r2.placed, false);
  assert.equal(b.h.pending.length, 0);
  assert.equal(b.h.state.frozen, true);
  assert.equal(b.h.state.unhedgedBtc, -0.001);
});

test("a hedge the mandate refuses (market not allowed) is not placed and freezes the agent", async () => {
  const orders = [];
  const h = hedger({ mandate: { ...M, strike: { ...M.strike, markets: ["ETH-USD"] } }, symbol: "BTC-USD", strike: { mark: () => MARK, placeOrder: async (o) => { orders.push(o); return {}; } }, now: () => T0 });
  const r = await h.onFill(fill());
  assert.equal(r.placed, false);
  assert.equal(r.refused.rule, "strike.markets");
  assert.equal(orders.length, 0);
  assert.equal(h.state.frozen, true);
});

test("the books come back from a snapshot as one carried exposure; rehedge places its order and the fill lifts the freeze", async () => {
  const { h, orders, log } = setup({ state: { midnightInventoryBtc: 0.0018, unhedgedBtc: 0.0018, frozen: true, frozenReason: "last run" } });
  assert.equal(h.state.frozen, true);
  assert.equal(h.exposures.length, 1);
  const r = await h.rehedge();
  assert.ok(r.placed);
  assert.deepEqual([orders[0].side, orders[0].size], ["sell", 0.0018]);
  assert.equal(kinds(log)[0], "carry");
  await h.onStrikeEvent({ kind: "fill", clientOrderId: r.clientOrderId, side: "SELL", size: "0.0018", price: "80000", at: T0 + 500 });
  assert.equal(h.state.frozen, false);
  assert.equal(h.state.unhedgedBtc, 0);
  assert.deepEqual(await setup().h.rehedge(), { placed: false });
});

test("a market hedge canceled for slippage becomes a resting limit at the edge of the band; its fill closes the loop", async () => {
  const { h, orders, log } = setup();
  const r = await h.onFill(fill({ side: "buy", sizeBtc: 0.002 }));
  await h.onStrikeEvent({ kind: "order", clientOrderId: r.clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 200 });
  assert.equal(h.state.frozen, false, "a resting hedge is not a lost hedge");
  assert.equal(orders.length, 2);
  assert.deepEqual([orders[1].type, orders[1].side, orders[1].size, orders[1].price, orders[1].timeInForce, orders[1].clientOrderId], ["limit", "sell", 0.002, 78_400, "GTC", `${r.clientOrderId}-L`]);
  assert.equal(h.pending.length, 1);
  assert.equal(log.at(-1).kind, "hedge.resting");
  await h.onStrikeEvent({ kind: "fill", clientOrderId: `${r.clientOrderId}-L`, side: "SELL", size: "0.002", price: "78400", at: T0 + 9_000 });
  assert.equal(h.pending.length, 0);
  assert.equal(h.state.unhedgedBtc, 0);
  assert.equal(h.hedges[0].latencyMs, 9_000);
  assert.equal(h.hedges[0].hedge.how, "limit");
  await h.onStrikeEvent({ kind: "order", clientOrderId: "nope", status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 });
  assert.equal(orders.length, 2, "an unknown order changes nothing");
});

test("a resting limit hedge that is canceled freezes", async () => {
  const { h } = setup();
  const r = await h.onFill(fill({ side: "buy", sizeBtc: 0.002 }));
  await h.onStrikeEvent({ kind: "order", clientOrderId: r.clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 200 });
  await h.onStrikeEvent({ kind: "order", clientOrderId: `${r.clientOrderId}-L`, status: "CANCELED", terminal: true, closeReason: "", at: T0 + 300 });
  assert.equal(h.state.frozen, true);
});

test("a netting fill that leaves less than one step closes the exposure; the dust stays in the inventory", async () => {
  const { h, orders } = setup();
  await h.onFill(fill({ id: "a", side: "buy", sizeBtc: 0.00176749, at: T0 }));
  await h.onStrikeEvent({ kind: "order", clientOrderId: orders[0].clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 100 });
  await h.onFill(fill({ id: "b", side: "sell", sizeBtc: 0.00176, at: T0 + 2_000 }));
  assert.equal(h.exposures.length, 0);
  assert.equal(h.state.unhedgedBtc, 0);
  assert.equal(h.hedges[0].hedge.how, "netted");
  assert.equal(h.state.midnightInventoryBtc, 0.00000749);
  assert.equal(h.state.frozen, false);
});

test("a carried hedge may cross zero by less than a step (the inventory's dust), never by more; a few dollars of exposure close as dust", async () => {
  const { h, orders } = setup({ minNotionalUsd: 100, state: { midnightInventoryBtc: 0.00178749, strikePositionBtc: -0.00319, unhedgedBtc: -0.00141, frozen: true, frozenReason: "late" } });
  const r = await h.rehedge();
  assert.ok(r.placed);
  assert.deepEqual([orders[0].side, orders[0].size], ["buy", 0.00141], "0.00141 crosses zero by 0.0000075: allowed, a step short would leave the fill open");
  await h.onStrikeEvent({ kind: "fill", clientOrderId: r.clientOrderId, side: "BUY", size: "0.00141", price: "84000", at: T0 + 300 });
  assert.deepEqual([h.state.unhedgedBtc, h.state.frozen, h.pending.length], [0, false, 0]);
  const far = setup({ state: { midnightInventoryBtc: 0.003, strikePositionBtc: -0.001, unhedgedBtc: 0.003 } });
  await far.h.rehedge();
  assert.deepEqual([far.orders[0].side, far.orders[0].size], ["sell", 0.002], "net is 0.002: the hedge stops there, 0.001 of the exposure is already offset");
  const { h: d, log } = setup({ minNotionalUsd: 100, state: { midnightInventoryBtc: 0.00003, unhedgedBtc: 0.00003, frozen: true, frozenReason: "late" } });
  assert.deepEqual(await d.rehedge(), { placed: false, dust: true });
  assert.deepEqual([d.state.unhedgedBtc, d.state.frozen], [0, false]);
  assert.ok(log.some((e) => e.kind === "dust"));
});

test("another agent's fill on a shared account is ignored, and so is the account's position; an own fill without a pending order still moves the position", async () => {
  const { h } = setup();
  await h.onStrikeEvent({ kind: "fill", clientOrderId: "mm-claude-hedge-1-5", side: "BUY", size: "0.005", price: "80000", at: T0 });
  assert.equal(h.state.strikePositionBtc, 0);
  await h.onStrikeEvent({ kind: "fill", clientOrderId: "mm-rule-tool-7", side: "SELL", size: "0.002", price: "80000", at: T0 });
  assert.equal(h.state.strikePositionBtc, -0.002, "a tool order of this agent counts");
  await h.onStrikeEvent({ kind: "position", symbol: "BTC-USD", size: "0.5", at: T0 });
  assert.equal(h.state.strikePositionBtc, 0.5, "an own account's position is the truth");
  const shared = hedger({ mandate: M, symbol: "BTC-USD", strike: { mark: () => MARK, placeOrder: async () => ({}) }, ownAccount: false });
  await shared.onStrikeEvent({ kind: "position", symbol: "BTC-USD", size: "0.5", at: T0 });
  assert.equal(shared.state.strikePositionBtc, 0, "a shared account's position is everyone's");
});

test("syncOrder after a stream gap: a fill the stream missed completes the hedge; a canceled market order rests as a limit", async () => {
  const { h, orders, log } = setup();
  const r = await h.onFill(fill({ id: "q-1", side: "sell", sizeBtc: 0.001 }));
  await h.syncOrder({ clientOrderId: r.clientOrderId, status: "FILLED", filledBtc: 0.001, price: 80_010, at: T0 + 2_000 });
  assert.equal(h.pending.length, 0);
  assert.deepEqual([h.state.strikePositionBtc, h.state.unhedgedBtc, h.hedges[0].latencyMs, h.hedges[0].hedge.price], [0.001, 0, 2_000, 80_010]);
  const r2 = await h.onFill(fill({ id: "q-2", side: "buy", sizeBtc: 0.002, at: T0 + 3_000 }));
  await h.syncOrder({ clientOrderId: r2.clientOrderId, status: "CANCELED", filledBtc: 0.0005, price: 80_000, closeReason: "market_order_exceeded_slippage", at: T0 + 4_000 });
  assert.deepEqual(h.pending.map((p) => [p.resting, p.sizeBtc]), [[true, 0.0015]], "the part that filled is applied, the rest rests");
  assert.equal(orders.at(-1).type, "limit");
  await h.syncOrder({ clientOrderId: "nobody-1", status: "FILLED", filledBtc: 1 });
  assert.equal(h.state.strikePositionBtc, 0.0005, "an unknown order changes nothing");
  assert.ok(kinds(log).includes("hedge.resting"));
});

test("every hedged fill is reported once with how it was closed: netting, a Strike fill, or dust", async () => {
  const hedgedFills = [];
  const h = hedger({ mandate: M, symbol: "BTC-USD", minNotionalUsd: 100, strike: { mark: () => MARK, placeOrder: async () => ({}), cancel: async () => ({}) }, now: () => T0, onHedged: (x) => hedgedFills.push([x.fill.id, x.hedge.how, x.hedge.clientOrderIds.length]) });
  await h.onFill(fill({ id: "a", side: "sell", sizeBtc: 0.00003 }));
  assert.deepEqual(hedgedFills, [["a", "dust", 0]], "2.4 USD of exposure is dust");
  const r = await h.onFill(fill({ id: "b", side: "sell", sizeBtc: 0.002 }));
  await h.onStrikeEvent({ kind: "fill", clientOrderId: r.clientOrderId, side: "BUY", size: "0.002", price: "80000", at: T0 + 500 });
  await h.onFill(fill({ id: "c", side: "buy", sizeBtc: 0.001 }));
  await h.onFill(fill({ id: "d", side: "sell", sizeBtc: 0.001 }));
  assert.deepEqual(hedgedFills.slice(1), [["b", "market", 1], ["c", "netted", 0], ["d", "netted", 0]]);
});

test("two fills of opposite sides while a hedge is in flight: nothing nets against a flying order; when both orders die the fills net each other and nothing rests", async () => {
  const { h, orders, cancels, log } = setup();
  const r1 = await h.onFill(fill({ id: "a", side: "sell", sizeBtc: 0.00142, at: T0 }));
  const r2 = await h.onFill(fill({ id: "b", side: "buy", sizeBtc: 0.00142, at: T0 + 100 }));
  assert.deepEqual(orders.map((o) => [o.side, o.type]), [["buy", "market"], ["sell", "market"]], "the second fill gets its own hedge: the first may still fill");
  assert.deepEqual(h.exposures.map((e) => [e.fillId, e.coveredBy]), [["a", r1.clientOrderId], ["b", r2.clientOrderId]]);
  assert.equal(h.hedges.length, 0);
  await h.onStrikeEvent({ kind: "order", clientOrderId: r1.clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 200 });
  assert.equal(orders.length, 2, "no limit yet: the other order is still in flight and may net it");
  assert.equal(h.exposures[0].coveredBy, null);
  await h.onStrikeEvent({ kind: "order", clientOrderId: r2.clientOrderId, status: "EXPIRED", terminal: true, closeReason: "order_expired_in_match", at: T0 + 300 });
  assert.equal(orders.length, 2, "nothing rests: the two fills net each other");
  assert.deepEqual(h.hedges.map((x) => [x.fill.id, x.hedge.how]).sort(), [["a", "netted"], ["b", "netted"]]);
  assert.deepEqual([h.pending.length, h.state.unhedgedBtc, h.state.frozen, cancels.length], [0, 0, false, 0]);
  assert.deepEqual(kinds(log).filter((k) => k === "frozen" || k === "hedge.resting"), []);
});

test("a deferred rest: the other order fills, so the dead order's exposure rests as a limit afterwards", async () => {
  const { h, orders } = setup();
  const r1 = await h.onFill(fill({ id: "a", side: "sell", sizeBtc: 0.00142, at: T0 }));
  const r2 = await h.onFill(fill({ id: "b", side: "buy", sizeBtc: 0.00142, at: T0 + 100 }));
  await h.onStrikeEvent({ kind: "order", clientOrderId: r1.clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 200 });
  await h.onStrikeEvent({ kind: "fill", clientOrderId: r2.clientOrderId, side: "SELL", size: "0.00142", price: "80000", at: T0 + 250 });
  assert.deepEqual(orders.at(-1) && [orders.at(-1).type, orders.at(-1).side, orders.at(-1).size, orders.at(-1).price, orders.at(-1).clientOrderId], ["limit", "buy", 0.00142, 81_600, `${r1.clientOrderId}-L`]);
  assert.deepEqual(h.pending.map((p) => [p.resting, p.sizeBtc]), [[true, 0.00142]]);
  assert.deepEqual(h.hedges.map((x) => [x.fill.id, x.hedge.how]), [["b", "market"]]);
  assert.equal(h.state.strikePositionBtc, -0.00142);
  await h.onStrikeEvent({ kind: "fill", clientOrderId: `${r1.clientOrderId}-L`, side: "BUY", size: "0.00142", price: "81600", at: T0 + 9_000 });
  assert.deepEqual([h.pending.length, h.state.unhedgedBtc, h.state.strikePositionBtc], [0, 0, 0]);
  assert.deepEqual(h.hedges.at(-1).hedge.how, "limit");
});

test("a fill on the other side nets a resting limit's exposure but never a flying order's; a partly filled market order rests only what is left", async () => {
  const { h, orders } = setup();
  const r1 = await h.onFill(fill({ id: "a", side: "sell", sizeBtc: 0.002, at: T0 }));
  await h.onStrikeEvent({ kind: "fill", clientOrderId: r1.clientOrderId, side: "BUY", size: "0.0005", price: "80000", at: T0 + 50 });
  await h.onStrikeEvent({ kind: "order", clientOrderId: r1.clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 100 });
  assert.deepEqual([orders.at(-1).type, orders.at(-1).size], ["limit", 0.0015], "the filled 0.0005 does not rest again");
  await h.onFill(fill({ id: "b", side: "buy", sizeBtc: 0.0015, at: T0 + 500 }));
  assert.deepEqual([h.pending.length, h.state.unhedgedBtc], [0, 0], "the resting limit was pulled and the rest netted");
  assert.deepEqual(h.hedges.map((x) => [x.fill.id, x.hedge.how, x.hedge.parts.map((p) => p.how)]), [["a", "netted", ["market", "netted"]], ["b", "netted", ["netted"]]]);
});

test("a carried exposure under Strike's minimum lifts a freeze: nothing can be ordered, so quoting goes on; a later fill completes it", async () => {
  const { h, orders, log } = setup({ minNotionalUsd: 100, state: { midnightInventoryBtc: 0.0003, unhedgedBtc: 0.0003, frozen: true, frozenReason: "late" } });
  assert.deepEqual(await h.rehedge(), { placed: false, small: true });
  assert.deepEqual([h.state.frozen, h.state.unhedgedBtc, orders.length], [false, 0.0003, 0]);
  assert.ok(kinds(log).includes("carry.small"));
  assert.ok(log.some((e) => e.kind === "resumed" && /minimum/.test(e.reason)));
  assert.equal(check({ venue: "midnight", kind: "quote", pair: "tBTC/tUSD", side: "bid", sizeBtc: 0.001, price: MARK * 0.995, ttlSec: 60 }, h.state), null, "not frozen: both sides may quote again");
  await h.onFill(fill({ id: "q", side: "buy", sizeBtc: 0.0012, at: T0 + 1000 }));
  assert.deepEqual([orders[0].side, orders[0].size], ["sell", 0.0015], "the carry is hedged together with the new fill");
});


test("on ADA-USD a resting limit sits on the market's tick inside the band, not on a whole dollar", async () => {
  const orders = [];
  const m = { ...M, agentId: "t-ada1", strike: { ...M.strike, markets: ["ADA-USD"], priceBandPct: 2 } };
  const h = hedger({ mandate: m, symbol: "ADA-USD", tickSize: 0.0001, stepBtc: 1, minNotionalUsd: 5, strike: { mark: () => 0.2125, placeOrder: async (o) => { orders.push(o); return { status: "pending" }; }, cancel: async () => ({}) }, now: () => T0, state: { equityStartUsd: 1000, equityNowUsd: 1000 } });
  const r = await h.onFill({ id: "f-ada", pair: "tADA/tUSD", side: "sell", sizeBtc: 566, price: 0.2125, at: T0 });
  await h.onStrikeEvent({ kind: "order", symbol: "ADA-USD", clientOrderId: r.clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 200 });
  assert.equal(h.state.frozen, false, `a resting limit on the tick passes the band check: ${h.state.frozenReason}`);
  assert.deepEqual([orders[1].type, orders[1].side, orders[1].size, orders[1].price], ["limit", "buy", 566, 0.2167]);
});

test("a hand freeze is kept in the snapshot and survives a new hedger over it: rehedge does not lift it, a mandate signed anew does", async () => {
  const { h, log } = setup({ state: { unhedgedBtc: 0 } });
  h.freeze("stopped by the owner", { manual: true });
  assert.deepEqual([h.snapshot().frozen, h.snapshot().manual], [true, true]);
  const again = setup({ state: h.snapshot() });
  await again.h.rehedge();
  assert.deepEqual([again.h.state.frozen, again.h.state.manual, again.h.state.frozenReason], [true, true, "stopped by the owner"], "the freeze stands after a restart");
  again.h.resume();
  assert.equal(again.h.state.frozen, false);
  assert.ok(!kinds(log).includes("resumed"));
});

test("a hand freeze over an automatic one holds: settle no longer lifts it", async () => {
  const { h, clock } = setup();
  const r = await h.onFill(fill());
  clock(T0 + 40_000);
  h.tick();
  assert.deepEqual([h.state.frozen, h.state.manual], [true, false], "late: frozen by the watchdog");
  h.freeze("paused by the owner", { manual: true });
  assert.deepEqual([h.state.frozen, h.state.manual, h.state.frozenReason], [true, true, "paused by the owner"]);
  await h.onStrikeEvent({ kind: "fill", symbol: "BTC-USD", clientOrderId: r.clientOrderId, side: "BUY", size: "0.001", price: "80010", at: T0 + 41_000 });
  assert.deepEqual([h.pending.length, h.state.frozen], [0, true], "hedged, still paused by hand");
});

test("a mandate signed anew reaches the hedger: the band prices the next resting limit, the deadline times the next hedge", async () => {
  const { h, orders, clock } = setup();
  h.setMandate({ ...M, strike: { ...M.strike, priceBandPct: 1 }, risk: { ...M.risk, hedgeWithinSec: 10 } });
  const r = await h.onFill(fill());
  assert.equal(h.pending[0].deadline, T0 + 10_000, "the new deadline");
  await h.onStrikeEvent({ kind: "order", symbol: "BTC-USD", clientOrderId: r.clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 200 });
  assert.deepEqual([orders[1].type, orders[1].price], ["limit", 80_800], "one percent over the mark, not two");
  clock(T0 + 11_000);
  h.tick();
  assert.match(h.state.frozenReason, /within 10s/);
});

test("the slowest hedge counts fills of this run only: a book carried from the last run is hedged without a latency of its own", async () => {
  const { h, orders, clock } = setup({ state: { midnightInventoryBtc: 0.002, strikePositionBtc: 0, unhedgedBtc: 0.002 } });
  await h.rehedge();
  assert.equal(orders.length, 1);
  clock(T0 + 7_200_000);
  await h.onStrikeEvent({ kind: "fill", symbol: "BTC-USD", clientOrderId: orders[0].clientOrderId, side: "SELL", size: "0.002", price: "80010", at: T0 + 7_200_000 });
  assert.deepEqual([h.hedges.length, h.hedges[0].latencyMs > 7_000_000, h.maxLatencyMs], [1, true, 0]);
  const r = await h.onFill(fill({ at: T0 + 7_200_000 }));
  await h.onStrikeEvent({ kind: "fill", symbol: "BTC-USD", clientOrderId: r.clientOrderId, side: "BUY", size: "0.001", price: "80010", at: T0 + 7_204_000 });
  assert.equal(h.maxLatencyMs, 4_000);
});

test("stop means flat: flatten pulls a resting limit and sends what is unhedged as a market order; a thin book leaves a limit resting again", async () => {
  const { h, orders, cancels, clock } = setup();
  const r = await h.onFill(fill());
  await h.onStrikeEvent({ kind: "order", symbol: "BTC-USD", clientOrderId: r.clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 200 });
  assert.deepEqual([orders.length, orders[1].type, h.pending[0].resting], [2, "limit", true]);
  h.freeze("stopped by the owner", { manual: true });
  clock(T0 + 1_000);
  const f = await h.flatten();
  assert.deepEqual([f.placed, cancels.length, orders[2].type, orders[2].side, orders[2].size], [true, 1, "market", "buy", 0.001], "the limit pulled, the remainder sent at once");
  await h.onStrikeEvent({ kind: "order", symbol: "BTC-USD", clientOrderId: f.clientOrderId, status: "CANCELED", terminal: true, closeReason: "market_order_exceeded_slippage", at: T0 + 1_200 });
  assert.deepEqual([orders[3].type, h.pending.filter((p) => p.resting).length, h.state.frozen, h.state.manual], ["limit", 1, true, true], "Strike could not fill it: a limit rests, the agent stays stopped");
});
