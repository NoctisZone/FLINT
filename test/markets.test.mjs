/** The markets table, a mandate's market, and coin sizes per market. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKETS, SYMBOLS, assertMarkets, marketOf, marketOfMandate, marketOfPair, placesOf } from "../gateway/markets.mjs";
import { coinSizes } from "../gateway/onboard.mjs";
import { profiles } from "../agents/profiles.mjs";

test("three markets, each with its Midnight pair and base token; an unknown symbol is refused", () => {
  assert.deepEqual(SYMBOLS, ["BTC-USD", "ADA-USD", "SOL-USD"]);
  assert.deepEqual([marketOf("ADA-USD").pair, marketOf("ADA-USD").token, marketOf("ADA-USD").decimals], ["tADA/tUSD", "market:tADA", 6]);
  assert.equal(marketOfPair("tSOL/tUSD").symbol, "SOL-USD");
  assert.equal(marketOfPair("tETH/tUSD"), null);
  assert.throws(() => marketOf("ETH-USD"), /no such market: ETH-USD/);
  assert.deepEqual([placesOf(0.00001), placesOf(1), placesOf(0.01), placesOf(0.0001)], [5, 0, 2, 4]);
});

test("a mandate's market is its Strike symbol, and its Midnight pair has to be that market's", () => {
  const P = profiles({ owner: "o", expiry: "2026-10-30T00:00:00Z" });
  assert.equal(marketOfMandate(P["mm-rule"]).symbol, "BTC-USD");
  const ada = { ...P["mm-rule"], strike: { ...P["mm-rule"].strike, markets: ["ADA-USD"] }, midnight: { ...P["mm-rule"].midnight, pairs: ["tADA/tUSD"] } };
  assert.equal(marketOfMandate(ada).symbol, "ADA-USD");
  const mixed = { ...ada, midnight: { ...ada.midnight, pairs: ["tBTC/tUSD"] } };
  assert.throws(() => marketOfMandate(mixed), /pair tBTC\/tUSD does not belong to ADA-USD/);
  assert.deepEqual(P["citizen-a"].midnight.pairs, ["tBTC/tUSD", "tADA/tUSD", "tSOL/tUSD"], "the citizens take on every market");
});

test("coins for an ADA maker are counted in lovelace, for a SOL maker in lamports", () => {
  assert.deepEqual(coinSizes({ quoteUsd: 150, mark: 0.4, decimals: MARKETS["ADA-USD"].decimals }), { sats: 393_750_000, cents: 15750, usd: 157.5 });
  assert.deepEqual(coinSizes({ quoteUsd: 100, mark: 200, headroom: 1, decimals: MARKETS["SOL-USD"].decimals }), { sats: 500_000_000, cents: 10000, usd: 100 });
});

test("a mandate may name several markets; the pairs must be exactly theirs, in order, none twice", () => {
  const P = profiles({ owner: "o", expiry: "2026-10-30T00:00:00Z" });
  const two = { ...P["mm-rule"], strike: { ...P["mm-rule"].strike, markets: ["BTC-USD", "ADA-USD"] }, midnight: { ...P["mm-rule"].midnight, pairs: ["tBTC/tUSD", "tADA/tUSD"] } };
  assert.deepEqual(assertMarkets(two).map((m) => m.symbol), ["BTC-USD", "ADA-USD"]);
  assert.throws(() => assertMarkets({ ...two, midnight: { ...two.midnight, pairs: ["tBTC/tUSD"] } }), /midnight.pairs must be tBTC\/tUSD, tADA\/tUSD/);
  assert.throws(() => assertMarkets({ ...two, midnight: { ...two.midnight, pairs: ["tADA/tUSD", "tBTC/tUSD"] } }), /midnight.pairs must be/);
  assert.throws(() => assertMarkets({ ...two, strike: { ...two.strike, markets: ["BTC-USD", "BTC-USD"] } }), /twice/);
  assert.throws(() => assertMarkets({ ...two, strike: { ...two.strike, markets: [] } }), /names no market/);
  assert.throws(() => assertMarkets({ ...two, strike: { ...two.strike, markets: ["ETH-USD"] } }), /no such market/);
});
