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
