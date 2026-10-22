/** The stand-in market maker's plan: both sides around the mark, requotes on a move, the reducing side tighter, one side past the cap. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { liquidityPlan } from "../gateway/liquidity.mjs";

const T = 1_700_000_000_000;

test("flat: a bid and an ask 10 bps either side of the mark, on the tick, one order a side", () => {
  const p = liquidityPlan({ mark: 82_345.67, positionBtc: 0, open: [], now: T });
  assert.deepEqual(p.cancel, []);
  assert.deepEqual(p.place, [
    { side: "buy", price: 82_263.3, size: 0.01, clientOrderId: `liq-buy-${T}` },
    { side: "sell", price: 82_428.1, size: 0.01, clientOrderId: `liq-sell-${T}` },
  ]);
  assert.ok(p.place[0].price <= 82_345.67 * 0.999 && p.place[1].price >= 82_345.67 * 1.001, "rounded away from the mark");
});

test("standing orders stay while the mark is near; past half the spread they are replaced; a duplicate on a side goes", () => {
  const open = [{ clientOrderId: "liq-buy-1", side: "buy", price: 81_918 }, { clientOrderId: "liq-sell-1", side: "sell", price: 82_082 }];
  const same = liquidityPlan({ mark: 82_020, positionBtc: 0, open, now: T });
  assert.deepEqual([same.cancel, same.place], [[], []]);
  const moved = liquidityPlan({ mark: 82_100, positionBtc: 0, open, now: T });
  assert.deepEqual(moved.cancel, ["liq-buy-1", "liq-sell-1"]);
  assert.equal(moved.place.length, 2);
  const dup = liquidityPlan({ mark: 82_000, positionBtc: 0, open: [...open, { clientOrderId: "liq-sell-0", side: "sell", price: 82_090 }], now: T });
  assert.deepEqual(dup.cancel, ["liq-sell-0"], "the one nearest its price stays");
  assert.deepEqual(dup.place, []);
});

test("the side that reduces the account's position quotes tighter; past the cap only that side stands", () => {
  const short = liquidityPlan({ mark: 80_000, positionBtc: -0.02, open: [], now: T });
  assert.deepEqual(short.wanted, { buy: 79_960, sell: 80_080 }, "short: the bid is 5 bps off, the ask 10");
  const long = liquidityPlan({ mark: 80_000, positionBtc: 0.02, open: [{ clientOrderId: "liq-buy-1", side: "buy", price: 79_920 }], now: T });
  assert.deepEqual(long.wanted, { buy: 79_920, sell: 80_040 });
  assert.deepEqual([long.cancel, long.place.map((o) => o.side)], [[], ["sell"]], "the bid at 10 bps still stands");
  const capped = liquidityPlan({ mark: 80_000, positionBtc: 0.05, open: [{ clientOrderId: "liq-buy-1", side: "buy", price: 79_920 }], now: T });
  assert.deepEqual(capped.wanted, { buy: null, sell: 80_040 });
  assert.deepEqual(capped.cancel, ["liq-buy-1"], "at the cap the bid is pulled");
  assert.deepEqual(capped.place.map((o) => o.side), ["sell"]);
});

test("size snaps to Strike's step and the tick is honoured", () => {
  const p = liquidityPlan({ mark: 80_000, positionBtc: 0, open: [], sizeBtc: 0.012345678, tick: 1, now: T });
  assert.equal(p.place[0].size, 0.01234);
  assert.deepEqual(p.place.map((o) => o.price), [79_920, 80_080]);
});

test("an ADA-USD plan sizes on a step of one and prices on a tick of 0.0001", () => {
  const p = liquidityPlan({ mark: 0.21138571, positionBtc: 0, open: [], sizeBtc: 3784.3, step: 1, tick: 0.0001, maxPositionBtc: 20_000, now: T });
  assert.deepEqual(p.place.map((o) => [o.side, o.size, o.price]), [["buy", 3784, 0.2111], ["sell", 3784, 0.2116]]);
});
