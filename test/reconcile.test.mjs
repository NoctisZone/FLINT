/** The reconciler on a clean run and on runs with one defect each. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../gateway/reconcile.mjs";
import { profiles } from "../agents/profiles.mjs";

const M = profiles({ owner: "o", expiry: "2026-10-23T15:00:00Z" })["mm-rule"];
const clean = () => ({
  entries: [
    { seq: 1, kind: "fill", id: "q1", pair: "tBTC/tUSD", side: "sell", sizeBtc: 0.001, price: 84_200, mark: 84_000 },
    { seq: 2, kind: "hedge.placed", fillId: "q1", clientOrderId: "h1", side: "buy", sizeBtc: 0.001, mark: 84_000 },
    { seq: 3, kind: "hedge.filled", fillId: "q1", clientOrderId: "h1", side: "buy", sizeBtc: 0.001, latencyMs: 6200, mark: 84_000 },
    { seq: 4, kind: "refusal", rule: "midnight.maxSpreadBps", agent: "rogue" },
  ],
  strikeFills: [{ client_order_id: "h1", symbol: "BTC-USD", side: "buy", size: "0.001", price: "84010" }],
  mandate: M,
});

test("a clean run: no violations, the four claims", () => {
  const r = reconcile(clean());
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { midnightFills: 1, hedgesPlaced: 1, hedgesFilled: 1, strikeFills: 1, refusals: 1 });
  assert.deepEqual(r.claims, { violations: 0, maxNetDeltaUsd: 84, maxFillToHedgeSec: 7, venuesOutsideMandate: 0 });
});

test("a Strike fill the gateway never placed, a late hedge, an unhedged fill and an over-hedge are each a violation", () => {
  const a = clean();
  a.strikeFills.push({ client_order_id: "mystery", symbol: "BTC-USD", side: "sell", size: "0.002" });
  assert.deepEqual(reconcile(a).violations.map((v) => v.rule), ["unknown-strike-fill"]);

  const b = clean();
  b.entries[2].latencyMs = 31_000;
  assert.deepEqual(reconcile(b).violations.map((v) => v.rule), ["risk.hedgeWithinSec"]);
  assert.equal(reconcile(b).claims.maxFillToHedgeSec, 31);

  const c = clean();
  c.entries.push({ seq: 5, kind: "fill", id: "q2", pair: "tBTC/tUSD", side: "buy", sizeBtc: 0.002, mark: 84_000 });
  const rc = reconcile(c);
  assert.deepEqual(rc.violations.map((v) => v.rule), ["unhedged-fill", "risk.maxNetDeltaUsd"]);
  assert.equal(rc.claims.maxNetDeltaUsd, 168);

  const d = clean();
  d.strikeFills.push({ client_order_id: "h1", symbol: "BTC-USD", side: "buy", size: "0.0005" });
  assert.deepEqual(reconcile(d).violations.map((v) => v.rule), ["over-hedged"]);

  const e = clean();
  e.strikeFills[0].symbol = "ETH-USD";
  assert.deepEqual(reconcile(e).violations.map((v) => v.rule), ["strike.markets"]);
  assert.equal(reconcile(e).claims.venuesOutsideMandate, 1);
});

test("a fill hedged by netting counts as hedged; the delta walk starts from the carried books", () => {
  const r = reconcile({
    entries: [
      { kind: "fill", id: "a", pair: "tBTC/tUSD", side: "buy", sizeBtc: 0.001, mark: 80_000 },
      { kind: "fill", id: "b", pair: "tBTC/tUSD", side: "sell", sizeBtc: 0.001, mark: 80_000 },
      { kind: "hedge.netted", fillId: "a", latencyMs: 4000, side: "sell", sizeBtc: 0.001 },
      { kind: "hedge.netted", fillId: "b", latencyMs: 0, side: "sell", sizeBtc: 0.001, by: "netting" },
    ],
    strikeFills: [], mandate: M, startDeltaBtc: 0.0005,
  });
  assert.deepEqual(r.violations, []);
  assert.equal(r.claims.maxFillToHedgeSec, 4);
  assert.equal(r.claims.maxNetDeltaUsd, 120, "0.0015 at 80000 after the first fill");
});

test("with timestamps the delta walk follows Strike's own fills: a hedge one step short leaves one step of delta, not a phantom position", () => {
  const T = Date.parse("2026-10-22T07:00:00Z");
  const entries = [
    { seq: 1, kind: "decision", ts: "2026-10-22T06:59:00Z", mark: 82_000 },
    { seq: 2, kind: "fill", id: "a", pair: "tBTC/tUSD", side: "buy", sizeBtc: 0.00145, at: T },
    { seq: 3, kind: "hedge.placed", clientOrderId: "h1", side: "sell", sizeBtc: 0.00144, covers: ["a"], ts: "2026-10-22T07:00:00.100Z" },
    { seq: 4, kind: "fill", id: "b", pair: "tBTC/tUSD", side: "sell", sizeBtc: 0.00145, at: T + 240_000 },
    { seq: 5, kind: "hedge.netted", fillId: "a", latencyMs: 240_000, side: "sell", sizeBtc: 0.00145 },
    { seq: 6, kind: "hedge.placed", clientOrderId: "h2", side: "buy", sizeBtc: 0.00144, covers: ["b"], ts: "2026-10-22T07:04:00.100Z" },
    { seq: 7, kind: "hedge.filled", fillId: "b", clientOrderId: "h2", side: "buy", sizeBtc: 0.00145, latencyMs: 80 },
  ];
  const strikeFills = [
    { client_order_id: "h1", symbol: "BTC-USD", side: "sell", size: "0.00144", price: "81990", timestamp: T + 90 },
    { client_order_id: "h2", symbol: "BTC-USD", side: "buy", size: "0.00144", price: "82010", timestamp: T + 240_080 },
  ];
  const r = reconcile({ entries, strikeFills, mandate: M, now: T + 300_000 });
  assert.deepEqual(r.violations.map((v) => v.rule), ["risk.hedgeWithinSec"], "the step left open counted as the fill's latency, nothing else");
  assert.equal(r.claims.maxNetDeltaUsd, 118.9, "0.00145 BTC at 82000 for 90 ms, then one step");
});

test("a fill whose hedge is placed and still inside its deadline is pending, not unhedged; past the deadline it is", () => {
  const T = Date.parse("2026-10-22T07:00:00Z");
  const entries = [
    { seq: 1, kind: "decision", ts: "2026-10-22T06:59:00Z", mark: 82_000 },
    { seq: 2, kind: "fill", id: "a", pair: "tBTC/tUSD", side: "buy", sizeBtc: 0.00145, at: T },
    { seq: 3, kind: "hedge.placed", clientOrderId: "h1", side: "sell", sizeBtc: 0.00145, covers: ["a"], ts: "2026-10-22T07:00:00.100Z" },
  ];
  assert.deepEqual(reconcile({ entries, strikeFills: [], mandate: M, now: T + 10_000 }).violations, []);
  assert.deepEqual(reconcile({ entries, strikeFills: [], mandate: M, now: T + 40_000 }).violations.map((v) => v.rule), ["unhedged-fill"]);
});

test("a resting limit, an owner's close and a tool order are the gateway's own orders: their Strike fills are known, not violations", () => {
  const a = clean();
  a.entries.push(
    { seq: 5, kind: "hedge.resting", clientOrderId: "h1-L", side: "buy", sizeBtc: 0.001, price: 83_000 },
    { seq: 6, kind: "decision", action: { venue: "strike", kind: "order", symbol: "BTC-USD", side: "sell", sizeBtc: 0.002, reduceOnly: true, clientOrderId: "mm-rule-close-1" }, mark: 84_000 },
    { seq: 7, kind: "decision", action: { venue: "strike", kind: "order", symbol: "BTC-USD", side: "buy", sizeBtc: 0.0005, clientOrderId: "mm-rule-tool-2" }, mark: 84_000 },
  );
  a.strikeFills.push(
    { client_order_id: "h1-L", symbol: "BTC-USD", side: "buy", size: "0.001" },
    { client_order_id: "mm-rule-close-1", symbol: "BTC-USD", side: "sell", size: "0.002" },
    { client_order_id: "mm-rule-tool-2", symbol: "BTC-USD", side: "buy", size: "0.0005" },
  );
  const r = reconcile(a);
  assert.deepEqual(r.violations, []);
  assert.equal(r.counts.hedgesPlaced, 4);
  a.strikeFills.push({ client_order_id: "mm-rule-tool-2", symbol: "BTC-USD", side: "buy", size: "0.0005" });
  assert.deepEqual(reconcile(a).violations.map((v) => v.rule), ["over-hedged"], "a tool order filled twice over is still caught");
});

test("an agent on two markets is walked market by market: each market's delta against the limit, the claim is the largest market's", () => {
  const two = { ...M, strike: { ...M.strike, markets: ["BTC-USD", "ADA-USD"] }, midnight: { ...M.midnight, pairs: ["tBTC/tUSD", "tADA/tUSD"] } };
  const T = Date.parse("2026-10-22T07:00:00Z");
  const entries = [
    { seq: 1, kind: "decision", ts: "2026-10-22T06:59:00Z", action: { venue: "midnight", kind: "quote", pair: "tBTC/tUSD" }, mark: 80_000 },
    { seq: 2, kind: "decision", ts: "2026-10-22T06:59:00Z", action: { venue: "midnight", kind: "quote", pair: "tADA/tUSD" }, mark: 0.2 },
    { seq: 3, kind: "fill", id: "a", pair: "tBTC/tUSD", side: "buy", sizeBtc: 0.001, at: T },
    { seq: 4, kind: "fill", id: "b", pair: "tADA/tUSD", side: "buy", sizeBtc: 500, at: T + 10 },
    { seq: 5, kind: "hedge.placed", clientOrderId: "h1", side: "sell", sizeBtc: 0.001, covers: ["a"], ts: "2026-10-22T07:00:00.100Z" },
    { seq: 6, kind: "hedge.placed", clientOrderId: "h2", side: "sell", sizeBtc: 500, covers: ["b"], ts: "2026-10-22T07:00:00.100Z" },
    { seq: 7, kind: "hedge.filled", fillId: "a", clientOrderId: "h1", side: "sell", sizeBtc: 0.001, latencyMs: 2000 },
    { seq: 8, kind: "hedge.filled", fillId: "b", clientOrderId: "h2", side: "sell", sizeBtc: 500, latencyMs: 3000 },
  ];
  const strikeFills = [
    { client_order_id: "h1", symbol: "BTC-USD", side: "sell", size: "0.001", timestamp: T + 2000 },
    { client_order_id: "h2", symbol: "ADA-USD", side: "sell", size: "500", timestamp: T + 3010 },
  ];
  const r = reconcile({ entries, strikeFills, mandate: two, now: T + 60_000 });
  assert.deepEqual(r.violations, [], "80 USD on BTC and 100 USD on ADA, each under the 150 USD limit; summed they would not be");
  assert.deepEqual([r.markets["BTC-USD"].maxDeltaUsd, r.markets["ADA-USD"].maxDeltaUsd, r.claims.maxNetDeltaUsd, r.claims.maxFillToHedgeSec], [80, 100, 100, 3]);
  // the books carried in per market
  const c = reconcile({ entries, strikeFills, mandate: two, now: T + 60_000, startDeltaBtc: { "ADA-USD": 300 } });
  assert.deepEqual(c.violations.map((v) => [v.rule, v.symbol]), [["risk.maxNetDeltaUsd", "ADA-USD"]]);
});

