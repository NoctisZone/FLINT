/**
 * The nine checks at their exact boundaries, and two properties over random
 * actions: a reducing hedge at a price inside the band is never refused,
 * and nothing that passes exceeds a limit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { check, netDeltaBtc, reducesDelta, signedSize } from "../gateway/checks.mjs";
import { profiles } from "../agents/profiles.mjs";

const MARK = 80_000;
const M = profiles({ owner: "o", expiry: "2026-10-23T15:00:00Z" })["mm-rule"];
// maxPositionUsd 300, priceBandPct 2, maxLeverage 3, maxQuoteUsd 150, spread 25..100 bps a side, ttl 300, 4 quotes, net delta 150, loss stop 10%, 12 actions/min
const usd = (x) => x / MARK;
const base = () => ({
  mandate: M, signatureOk: true, frozen: false, now: Date.parse("2026-10-22T12:00:00Z"), mark: MARK,
  strikePositionBtc: 0, leverage: 3, midnightInventoryBtc: 0, unhedgedBtc: 0, openQuotes: 0,
  equityStartUsd: 1000, equityNowUsd: 1000, actionsLastMinute: 0,
});
const order = (o = {}) => ({ venue: "strike", kind: "order", symbol: "BTC-USD", side: "buy", sizeBtc: usd(100), ...o });
const quote = (o = {}) => ({ venue: "midnight", kind: "quote", pair: "tBTC/tUSD", side: "ask", sizeBtc: usd(100), price: MARK * 1.005, ttlSec: 120, ...o });
const rule = (a, s = base()) => check(a, s)?.rule ?? null;

test("1. mandate, signature, expiry, frozen; a cancel passes once the mandate is valid", () => {
  assert.equal(rule(order(), { ...base(), mandate: { ...M, risk: {} } }), "mandate");
  assert.equal(rule(order(), { ...base(), signatureOk: false }), "signature");
  assert.equal(rule(order(), { ...base(), now: Date.parse(M.expiry) }), "expiry");
  assert.equal(rule(order(), { ...base(), now: Date.parse(M.expiry) - 1 }), null);
  assert.equal(rule(quote(), { ...base(), frozen: true }), "frozen");
  assert.equal(rule({ venue: "strike", kind: "cancel" }, { ...base(), frozen: true }), null);
  assert.equal(rule({ venue: "strike", kind: "cancel" }, { ...base(), signatureOk: false }), "signature");
});

test("2. venue and market, and a size of zero", () => {
  assert.equal(rule(order({ symbol: "ETH-USD" })), "strike.markets");
  assert.equal(rule(quote({ pair: "tETH/tUSD" })), "midnight.pairs");
  assert.equal(rule(order({ sizeBtc: 0 })), "size");
});

test("3. size at the cap passes, a hair over fails, on both venues", () => {
  assert.equal(rule(quote({ sizeBtc: usd(150) })), null);
  assert.equal(rule(quote({ sizeBtc: usd(150.01) })), "midnight.maxQuoteUsd");
  const short = { ...base(), midnightInventoryBtc: usd(-150) }; // 300 bought on Strike leaves a delta of 150, inside the limit
  assert.equal(rule(order({ sizeBtc: usd(300) }), short), null);
  assert.equal(rule(order({ sizeBtc: usd(300.01) }), short), "strike.maxPositionUsd");
  const r = check(quote({ sizeBtc: usd(200) }), base());
  assert.deepEqual([r.rule, r.limit, r.attempted], ["midnight.maxQuoteUsd", 150, 200]);
});

test("4. Strike limit within the band; Midnight quote inside the spread band and on the right side of the mark", () => {
  assert.equal(rule(order({ price: MARK * 0.98 })), null);
  assert.equal(rule(order({ price: MARK * 0.9799 })), "strike.priceBandPct");
  assert.equal(rule(order({ price: MARK * 1.0201 })), "strike.priceBandPct");
  assert.equal(rule(quote({ side: "ask", price: MARK * (1 + 0.0025) })), null, "25 bps ask");
  assert.equal(rule(quote({ side: "ask", price: MARK * (1 + 0.00249) })), "midnight.minSpreadBps");
  assert.equal(rule(quote({ side: "ask", price: MARK * (1 + 0.0100) })), null, "100 bps ask");
  assert.equal(rule(quote({ side: "ask", price: MARK * (1 + 0.0101) })), "midnight.maxSpreadBps");
  assert.equal(rule(quote({ side: "bid", price: MARK * (1 - 0.0025) })), null, "25 bps bid");
  assert.equal(rule(quote({ side: "bid", price: MARK * 1.001 })), "midnight.minSpreadBps", "a bid above the mark is a negative spread");
});

test("5. position after the order and leverage", () => {
  const long = { ...base(), strikePositionBtc: usd(200), midnightInventoryBtc: usd(-150) }; // net delta 50 before, 150 after a buy of 100
  assert.equal(rule(order({ sizeBtc: usd(100) }), long), null);
  assert.equal(rule(order({ sizeBtc: usd(100.01) }), long), "strike.maxPositionUsd");
  const flat = { ...base(), strikePositionBtc: usd(-200), midnightInventoryBtc: usd(200) };
  assert.equal(rule(order({ side: "sell", sizeBtc: usd(100) }), flat), null, "the short grows to 300: at the cap");
  assert.equal(rule(order({ side: "sell", sizeBtc: usd(100.01) }), flat), "strike.maxPositionUsd");
  assert.equal(rule(order(), { ...base(), leverage: 4 }), "strike.maxLeverage");
  assert.equal(rule(order(), { ...base(), leverage: 3 }), null);
});

test("6. open quotes and expiry", () => {
  assert.equal(rule(quote(), { ...base(), openQuotes: 3 }), null);
  assert.equal(rule(quote(), { ...base(), openQuotes: 4 }), "midnight.maxOpenQuotes");
  assert.equal(rule(quote({ ttlSec: 300 })), null);
  assert.equal(rule(quote({ ttlSec: 301 })), "midnight.quoteTtlSec");
});

test("7. net delta after the action counts inventory and Strike position", () => {
  const holding = { ...base(), midnightInventoryBtc: usd(100), unhedgedBtc: usd(100) };
  assert.equal(rule(quote({ side: "bid", sizeBtc: usd(50), price: MARK * 0.995 }), holding), null, "a bid that fills would hold 150");
  assert.equal(rule(quote({ side: "bid", sizeBtc: usd(50.01), price: MARK * 0.995 }), holding), "risk.maxNetDeltaUsd");
  const hedged = { ...base(), midnightInventoryBtc: usd(140), strikePositionBtc: usd(-140) };
  assert.equal(rule(quote({ side: "bid", sizeBtc: usd(150), price: MARK * 0.995 }), hedged), null, "hedged inventory is no delta");
  const unhedged = { ...base(), midnightInventoryBtc: usd(140), unhedgedBtc: usd(140) };
  assert.equal(rule(quote({ side: "bid", sizeBtc: usd(20), price: MARK * 0.995 }), unhedged), "risk.maxNetDeltaUsd");
  assert.equal(rule(quote({ side: "ask", sizeBtc: usd(150), price: MARK * 1.005 }), unhedged), null, "an ask would reduce it");
});

test("8. daily loss stop and 9. rate limit", () => {
  assert.equal(rule(order(), { ...base(), equityNowUsd: 900.01 }), null);
  assert.equal(rule(order(), { ...base(), equityNowUsd: 900 }), "risk.dailyLossStopPct");
  assert.equal(rule(order(), { ...base(), equityStartUsd: 0, equityNowUsd: 0 }), null, "no equity yet, no stop");
  assert.equal(rule(order(), { ...base(), actionsLastMinute: 11 }), null);
  assert.equal(rule(order(), { ...base(), actionsLastMinute: 12 }), "risk.maxActionsPerMin");
});

test("a hedge that reduces net delta passes every later check, frozen or not; crossing zero is not reducing", () => {
  const s = { ...base(), midnightInventoryBtc: usd(400), unhedgedBtc: usd(400), frozen: true, actionsLastMinute: 99, equityNowUsd: 500, leverage: 10 };
  const hedge = order({ side: "sell", sizeBtc: usd(400) });
  assert.ok(reducesDelta(hedge, s));
  assert.equal(rule(hedge, s), null);
  assert.equal(rule(order({ side: "sell", sizeBtc: usd(300) }), s), null, "partly reducing is still reducing");
  assert.equal(rule(order({ side: "sell", sizeBtc: usd(400.5) }), s), "frozen", "over-hedging crosses zero: not reducing");
  assert.equal(rule(order({ side: "buy", sizeBtc: usd(10) }), s), "frozen");
});

test("a reducing action still has to price inside the band: the limit band on Strike, the spread band on Midnight", () => {
  const s = { ...base(), midnightInventoryBtc: usd(400), unhedgedBtc: usd(400), frozen: true };
  assert.equal(rule(order({ side: "sell", sizeBtc: usd(300), price: MARK * 0.98 }), s), null);
  assert.equal(rule(order({ side: "sell", sizeBtc: usd(300), price: MARK * 0.979 }), s), "strike.priceBandPct");
  assert.equal(rule(quote({ side: "ask", sizeBtc: usd(150), price: MARK * 1.005 }), s), null);
  assert.equal(rule(quote({ side: "ask", sizeBtc: usd(150), price: MARK * 0.99 }), s), "midnight.minSpreadBps", "an ask under the mark reduces delta and is still refused");
  assert.equal(rule(quote({ side: "ask", sizeBtc: usd(150), price: MARK * 1.02 }), s), "midnight.maxSpreadBps");
});

test("property: over random states a reducing order is never refused, and nothing that passes breaks a limit", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  let passed = 0;
  for (let i = 0; i < 3000; i++) {
    const s = { ...base(), strikePositionBtc: usd((rnd() - 0.5) * 800), midnightInventoryBtc: usd((rnd() - 0.5) * 800), openQuotes: Math.floor(rnd() * 6), leverage: Math.ceil(rnd() * 5), equityNowUsd: 850 + rnd() * 200, actionsLastMinute: Math.floor(rnd() * 15), frozen: rnd() < 0.2 };
    const a = rnd() < 0.5
      ? order({ side: pick(["buy", "sell"]), sizeBtc: usd(rnd() * 500), ...(rnd() < 0.5 ? { price: MARK * (1 + (rnd() - 0.5) * 0.08) } : {}) })
      : quote({ side: pick(["bid", "ask"]), sizeBtc: usd(rnd() * 250), price: MARK * (1 + (rnd() - 0.5) * 0.04), ttlSec: Math.floor(rnd() * 400) });
    const r = check(a, s);
    const priced = a.venue === "strike" ? (a.price === undefined || Math.abs(a.price - MARK) / MARK <= 0.02) : (() => { const bps = (a.side === "ask" ? a.price - MARK : MARK - a.price) / MARK * 10_000; return bps >= M.midnight.minSpreadBps && bps <= M.midnight.maxSpreadBps; })();
    if (reducesDelta(a, s) && priced) assert.equal(r, null, `reducing order refused: ${JSON.stringify(r)}`);
    if (reducesDelta(a, s) && !priced) assert.match(r.rule, /^(strike\.priceBandPct|midnight\.(min|max)SpreadBps)$/, `a mispriced reducing order must fail on price: ${JSON.stringify(r)}`);
    if (r) continue;
    passed += 1;
    const notional = a.sizeBtc * MARK;
    if (!reducesDelta(a, s)) {
      assert.ok(!s.frozen);
      if (a.venue === "midnight") assert.ok(notional <= 150 + 1e-6 && s.openQuotes < 4 && a.ttlSec <= 300);
      if (a.venue === "strike") assert.ok(notional <= 300 + 1e-6 && Math.abs(s.strikePositionBtc + signedSize(a)) * MARK <= 300 + 1e-6 && s.leverage <= 3);
      assert.ok(Math.abs(netDeltaBtc(s) + signedSize(a)) * MARK <= 150 + 1e-6, "delta after");
      assert.ok((1000 - s.equityNowUsd) / 10 < 10 && s.actionsLastMinute < 12);
    }
    assert.ok(priced, "nothing passes at a price outside the band");
  }
  assert.ok(passed > 100, `only ${passed} passed`);
});
