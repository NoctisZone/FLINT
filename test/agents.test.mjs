/** The rule market maker's and the citizens' decisions on a few views. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { citizenDecision, makerDecision } from "../agents/rule-maker.mjs";
import { profiles } from "../agents/profiles.mjs";

const P = profiles({ owner: "o", expiry: "2026-10-23T15:00:00Z" });
const T0 = Date.parse("2026-10-22T12:00:00Z");
const view = (o = {}) => ({ mandate: P["mm-rule"], mark: 80_000, holdings: { btc: 0.007, usd: 470, spendable: { btc: 0.0028, usd: 188 } }, openQuotes: [], frozen: false, now: T0, ...o });

test("flat: a bid and an ask 25 bps either side of the mark, sized by the cap and the wallet", () => {
  const d = makerDecision(view());
  assert.deepEqual(d.retire, []);
  assert.deepEqual(d.quotes, [
    { side: "ask", sizeBtc: 0.00187, price: 80_200, ttlSec: 300 },
    { side: "bid", sizeBtc: 0.00187, price: 79_800, ttlSec: 300 },
  ]);
  assert.match(d.reason, /quoting ask and bid 25 bps off 80000/);
  const small = makerDecision(view({ holdings: { btc: 0.0005, usd: 50, spendable: { btc: 0.0005, usd: 50 } } }));
  assert.deepEqual(small.quotes.map((q) => [q.side, q.sizeBtc]), [["ask", 0.0005], ["bid", Math.floor(50 / 79_800 * 1e5) / 1e5]]);
  const tooSmall = makerDecision(view({ holdings: { btc: 0.0005, usd: 50, spendable: { btc: 0.0005, usd: 50 } } }), { minQuoteUsd: 100 });
  assert.deepEqual(tooSmall.quotes, []);
  assert.match(tooSmall.reason, /not enough tBTC for an ask of at least 100 USD; not enough tUSD for a bid/);
});

test("standing quotes stay while the mark is near; past the spread they are retired and replaced; near expiry too", () => {
  const standing = [{ quoteId: "a", side: "ask", price: 80_200, sizeBtc: 0.001, expiresAt: "2026-10-22T12:04:00Z" }, { quoteId: "b", side: "bid", price: 79_800, sizeBtc: 0.001, expiresAt: "2026-10-22T12:04:00Z" }];
  const same = makerDecision(view({ openQuotes: standing, mark: 80_100 }));
  assert.deepEqual([same.retire, same.quotes], [[], []]);
  const moved = makerDecision(view({ openQuotes: standing, mark: 80_300 }));
  assert.deepEqual(moved.retire, ["a", "b"]);
  assert.equal(moved.quotes.length, 2);
  const closing = makerDecision(view({ openQuotes: standing, now: Date.parse("2026-10-22T12:03:30Z") }));
  assert.deepEqual(closing.retire, ["a", "b"]);
  const frozen = makerDecision(view({ openQuotes: standing, frozen: true }));
  assert.deepEqual([frozen.retire, frozen.quotes], [["a", "b"], []], "frozen and flat: nothing stands");
  const frozenLong = makerDecision(view({ openQuotes: standing, frozen: true, netDeltaBtc: 0.001 }));
  assert.deepEqual([frozenLong.retire, frozenLong.quotes], [["b"], []], "frozen and long: the ask stands, the bid goes");
  const frozenShort = makerDecision(view({ frozen: true, netDeltaBtc: -0.001 }));
  assert.deepEqual(frozenShort.quotes.map((q) => [q.side, q.sizeBtc]), [["bid", 0.001]], "sized to the delta, never across it");
  assert.equal(makerDecision(view({ frozen: true, netDeltaBtc: 0.00176749 })).quotes[0].sizeBtc, 0.00176);
  assert.match(frozenShort.reason, /frozen: only the bid/);
});

test("the spread is clamped into the mandate's band and the ttl into its limit", () => {
  const d = makerDecision(view(), { spreadBps: 400, ttlSec: 999 });
  assert.equal(d.quotes[0].price, 80_800, "100 bps max spread per side");
  assert.equal(d.quotes[0].ttlSec, 300);
  assert.equal(makerDecision(view(), { spreadBps: 1 }).quotes[0].price, 80_200, "25 bps minimum per side");
  const odd = makerDecision(view({ mark: 80_001.23 }), { spreadBps: 25 });
  assert.deepEqual(odd.quotes.map((q) => q.price), [80_201.3, 79_801.2], "prices round away from the mark, never inside the spread");
});

test("a citizen takes the best ask within tolerance when it feels like it and can pay; never its own quote", () => {
  const board = [
    { quoteId: "x", side: "ask", price: 80_200, sizeBtc: 0.001, maker: "mm-rule", expiresAt: "2026-10-22T12:05:00Z" },
    { quoteId: "y", side: "ask", price: 80_150, sizeBtc: 0.001, maker: "citizen-a", expiresAt: "2026-10-22T12:05:00Z" },
    { quoteId: "z", side: "bid", price: 79_800, sizeBtc: 0.001, maker: "mm-rule", expiresAt: "2026-10-22T12:05:00Z" },
  ];
  const v = { agentId: "citizen-a", mark: 80_000, board, holdings: { spendable: { btc: 0.002, usd: 200 } }, frozen: false, now: T0 };
  assert.equal(citizenDecision(v, { side: "buy", rnd: () => 0 }).take.quoteId, "x", "its own ask is skipped");
  assert.equal(citizenDecision(v, { side: "sell", rnd: () => 0 }).take.quoteId, "z");
  assert.equal(citizenDecision(v, { side: "buy", rnd: () => 0.9 }).take, null);
  assert.match(citizenDecision(v, { side: "buy", rnd: () => 0, tolBps: 10 }).reason, /25 bps off the mark/);
  assert.match(citizenDecision({ ...v, holdings: { spendable: { btc: 0, usd: 10 } } }, { side: "buy", rnd: () => 0 }).reason, /cannot pay/);
  assert.match(citizenDecision({ ...v, board: [] }, { side: "buy", rnd: () => 0 }).reason, /no ask/);
});

test("net delta shrinks the side that would grow it: long 29 USD leaves a 121 USD bid; long 150 leaves none", () => {
  const long = makerDecision(view({ netDeltaBtc: 29 / 80_000 }));
  assert.equal(long.quotes.find((q) => q.side === "ask").sizeBtc, 0.00187, "an ask reduces it: full size");
  assert.equal(long.quotes.find((q) => q.side === "bid").sizeBtc, Math.floor((150 - 29) / 80_000 * 1e5) / 1e5);
  const full = makerDecision(view({ netDeltaBtc: 150 / 80_000 }), { minQuoteUsd: 100 });
  assert.deepEqual(full.quotes.map((q) => q.side), ["ask"]);
  assert.match(full.reason, /net delta leaves no room for a bid/);
  const short = makerDecision(view({ netDeltaBtc: -100 / 80_000 }), { minQuoteUsd: 100 });
  assert.deepEqual(short.quotes.map((q) => q.side), ["bid"]);
});

test("the Strike position cap sizes the side whose hedge would push the position past it", () => {
  // short 270 USD on Strike against long inventory: a bid's hedge sells more, only 30 USD of room; an ask's hedge buys, plenty
  const v = view({ netDeltaBtc: 0, strikePositionBtc: -270 / 80_000 });
  const d = makerDecision(v, { minQuoteUsd: 100 });
  assert.deepEqual(d.quotes.map((q) => q.side), ["ask"]);
  assert.match(d.reason, /Strike position cap leaves no room to hedge a bid/);
  const e = makerDecision(view({ netDeltaBtc: 0, strikePositionBtc: -200 / 80_000 }));
  assert.equal(e.quotes.find((q) => q.side === "bid").sizeBtc, Math.floor(100 / 80_000 * 1e5) / 1e5, "100 USD of room");
});

test("a fill that nets open exposure needs no hedge: a short maker at the position cap may still bid up to its short", () => {
  const v = view({ frozen: true, netDeltaBtc: -0.00141, strikePositionBtc: -270 / 80_000 });
  const d = makerDecision(v, { minQuoteUsd: 100 });
  assert.deepEqual(d.quotes.map((q) => [q.side, q.sizeBtc]), [["bid", 0.00141]]);
});

test("an auto citizen sells when most of its worth is BTC and buys otherwise", () => {
  const board = [
    { quoteId: "x", side: "ask", price: 80_200, sizeBtc: 0.001, maker: "mm-rule", expiresAt: "2026-10-22T12:05:00Z" },
    { quoteId: "z", side: "bid", price: 79_800, sizeBtc: 0.001, maker: "mm-rule", expiresAt: "2026-10-22T12:05:00Z" },
  ];
  const v = (btc, usd) => ({ agentId: "c", mark: 80_000, board, holdings: { btc, usd, spendable: { btc, usd } }, frozen: false, now: T0 });
  assert.equal(citizenDecision(v(0.005, 100), { side: "auto", rnd: () => 0 }).take.quoteId, "z", "400 USD of BTC against 100 USD: sells");
  assert.equal(citizenDecision(v(0.0005, 300), { side: "auto", rnd: () => 0 }).take.quoteId, "x", "40 USD of BTC against 300 USD: buys");
});

test("an auto citizen takes the other side when that is all the board offers", () => {
  const board = [{ quoteId: "z", side: "bid", price: 79_800, sizeBtc: 0.001, maker: "mm-rule", expiresAt: "2026-10-22T12:05:00Z" }];
  const v = { agentId: "c", mark: 80_000, board, holdings: { btc: 0.001, usd: 900, spendable: { btc: 0.001, usd: 900 } }, frozen: false, now: T0 };
  const d = citizenDecision(v, { side: "auto", rnd: () => 0 });
  assert.equal(d.take.quoteId, "z");
  assert.match(d.reason, /only side on the board/);
  assert.equal(citizenDecision(v, { side: "buy", rnd: () => 0 }).take, null, "a fixed side does not switch");
});
