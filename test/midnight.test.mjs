/** The Midnight venue against a stand-in trader: units, quotes, retire, take, the fill poll, the board. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { midnightVenue } from "../gateway/midnight.mjs";

const T = { tBTC: "b".repeat(64), tUSD: "u".repeat(64) };
const T0 = Date.parse("2026-10-22T12:00:00Z");

function stand() {
  const calls = [];
  const rows = new Map();
  let n = 0;
  const trader = {
    async makeOffer({ give, want }) { calls.push(["make", give, want]); return { text: `half-${++n}`, half: { id: `h${n}` }, provingMs: 5 }; },
    async post({ offer, tags, expiresAt }) { calls.push(["post", offer, tags, expiresAt]); const id = `q${n}`; rows.set(id, { offerId: id, offer, status: "open", tags: JSON.stringify(tags), expiresAt }); return { offerId: id }; },
    async retire(id) { calls.push(["retire", id]); rows.get(id).status = "retired"; },
    async revert(half) { calls.push(["revert", half.id]); },
    async takeOffer({ text, offerId, expect }) { calls.push(["take", text, offerId, expect]); return { takerHalf: { id: "t1" }, provingMs: 6 }; },
    async submitSwap({ offerId, takerHalf }) { calls.push(["sponsor", offerId, takerHalf.id]); return { status: "succeeded", txHash: "ff".repeat(32) }; },
    async getOffer(id) { calls.push(["get", id]); return rows.get(id); },
    async myOffers(filter) { calls.push(["mine", filter]); return [...rows.values()]; },
    async listOffers({ givesType, wantsType, tag, limit }) {
      calls.push(["list", tag ?? null, limit ?? null]);
      const ask = { offerId: "o1", offer: "x", givesType: T.tBTC, givesAmount: "70000", wantsType: T.tUSD, wantsAmount: "5894", tags: '["flint","mm-rule","ask"]', expiresAt: "2026-10-22T12:05:00Z" };
      const bid = { offerId: "o2", offer: "y", givesType: T.tUSD, givesAmount: "5852", wantsType: T.tBTC, wantsAmount: "70000", tags: '["flint","mm-rule","bid"]' };
      if (tag) return [ask, bid, { offerId: "o3", givesType: "f".repeat(64), wantsType: T.tUSD, givesAmount: "1", wantsAmount: "1" }];
      return givesType === T.tBTC
        ? [{ offerId: "o1", offer: "x", givesType: T.tBTC, givesAmount: "70000", wantsType: T.tUSD, wantsAmount: "5894", tags: '["flint","mm-rule","ask"]', expiresAt: "2026-10-22T12:05:00Z" }]
        : [{ offerId: "o2", offer: "y", givesType: T.tUSD, givesAmount: "5852", wantsType: T.tBTC, wantsAmount: "70000", tags: '["flint","mm-rule","bid"]' }];
    },
    async holdings() { return { maxInputs: 4, tokens: [{ tokenType: T.tBTC, balance: 700000n, coins: 10, spendable: 280000n }, { tokenType: T.tUSD, balance: 47000n, coins: 10, spendable: 18800n }] }; },
  };
  return { trader, calls, rows };
}

test("an ask gives tBTC in satoshi and wants tUSD in cents; a bid the other way round; the quote is tagged and expires", async () => {
  const { trader, calls } = stand();
  const log = [];
  const v = midnightVenue({ trader, agentId: "mm-rule", types: T, now: () => T0, log: (e) => log.push(e) });
  const a = await v.quote({ side: "ask", sizeBtc: 0.0007, price: 84_200, ttlSec: 300 });
  assert.deepEqual(calls[0], ["make", { type: T.tBTC, value: 70000n }, { type: T.tUSD, value: 5894n }]);
  assert.deepEqual(calls[1], ["post", "half-1", ["flint", "mm-rule", "ask"], "2026-10-22T12:05:00.000Z"]);
  assert.deepEqual(a, { quoteId: "q1", pair: "tBTC/tUSD", side: "ask", sizeBtc: 0.0007, price: 84_200, expiresAt: "2026-10-22T12:05:00.000Z" });
  const b = await v.quote({ side: "bid", sizeBtc: 0.0007, price: 83_600, ttlSec: 120 });
  assert.deepEqual(calls[2], ["make", { type: T.tUSD, value: 5852n }, { type: T.tBTC, value: 70000n }]);
  assert.equal(b.side, "bid");
  assert.equal(v.openQuotes.length, 2);
  assert.equal(log[0].kind, "quote.posted");
});

test("retire takes the quote off the board and frees its coins; a failed post frees them too", async () => {
  const { trader, calls } = stand();
  const v = midnightVenue({ trader, agentId: "mm-rule", types: T, now: () => T0 });
  const a = await v.quote({ side: "ask", sizeBtc: 0.001, price: 80_000, ttlSec: 60 });
  assert.equal(await v.retire(a.quoteId), true);
  assert.deepEqual(calls.slice(-2), [["retire", "q1"], ["revert", "h1"]]);
  assert.equal(v.openQuotes.length, 0);
  assert.equal(await v.retire("nope"), false);
  trader.post = async () => { throw new Error("board down"); };
  await assert.rejects(v.quote({ side: "ask", sizeBtc: 0.001, price: 80_000, ttlSec: 60 }), /board down/);
  assert.deepEqual(calls.at(-1), ["revert", "h2"]);
});

test("the fill poll turns a filled row into a fill with the maker's trade side and the txHash; expired rows free their coins", async () => {
  const { trader, rows, calls } = stand();
  const log = [];
  const v = midnightVenue({ trader, agentId: "mm-rule", types: T, now: () => T0 + 5000, log: (e) => log.push(e) });
  const a = await v.quote({ side: "ask", sizeBtc: 0.0007, price: 84_200, ttlSec: 300 });
  const b = await v.quote({ side: "bid", sizeBtc: 0.0007, price: 83_600, ttlSec: 300 });
  assert.deepEqual(await v.pollFills(), []);
  rows.get(a.quoteId).status = "filled";
  rows.get(a.quoteId).filledTxHash = "ab".repeat(32);
  rows.get(b.quoteId).status = "expired";
  const fills = await v.pollFills();
  assert.deepEqual(fills, [{ id: "q1", pair: "tBTC/tUSD", side: "sell", sizeBtc: 0.0007, price: 84_200, txHash: "ab".repeat(32), at: T0 + 5000 }]);
  assert.equal(v.openQuotes.length, 0);
  assert.deepEqual(calls.at(-1), ["revert", "h2"], "the expired bid's coins come back");
  assert.equal(log.at(-1).kind, "quote.expired");
  const reads = calls.filter(([c]) => c === "mine" || c === "get");
  assert.deepEqual(reads.map(([c]) => c), ["mine", "mine"], "one read of the caller's changes per poll, no read per quote");
  assert.deepEqual(reads[0][1], { limit: 200 }, "the first poll reads without since");
  assert.deepEqual(reads[1][1], { since: new Date(T0 + 5000 - 120_000).toISOString(), limit: 200 }, "then the changes since the last poll, two minutes back");
  assert.deepEqual(await v.pollFills(), []);
  assert.equal(calls.filter(([c]) => c === "mine").length, 2, "nothing open: no read at all");
});

test("a quote the changes read does not name is asked for alone once it is past its expiry", async () => {
  const { trader, rows, calls } = stand();
  let t = T0;
  const v = midnightVenue({ trader, agentId: "mm-rule", types: T, now: () => t });
  const a = await v.quote({ side: "ask", sizeBtc: 0.0007, price: 84_200, ttlSec: 300 });
  trader.myOffers = async () => [];
  assert.deepEqual(await v.pollFills(), []);
  assert.equal(calls.filter(([c]) => c === "get").length, 0, "not yet expired: no single read");
  t = T0 + 300_000 + 121_000;
  rows.get(a.quoteId).status = "expired";
  assert.deepEqual(await v.pollFills(), []);
  assert.deepEqual(calls.filter(([c]) => c === "get"), [["get", a.quoteId]]);
  assert.equal(v.openQuotes.length, 0);
});

test("a citizen takes a quote: expect mirrors the row, the sponsor's answer says whether it landed", async () => {
  const { trader, calls } = stand();
  const log = [];
  const v = midnightVenue({ trader, agentId: "citizen-a", types: T, now: () => T0, log: (e) => log.push(e) });
  const [ask, bid, ...rest] = await v.board();
  assert.deepEqual([bid.quoteId, rest.length], ["o2", 0], "both sides, the foreign row dropped");
  assert.deepEqual(calls.splice(0), [["list", "flint", 200]], "the server board in one read by the market's tag");
  assert.deepEqual(ask, { quoteId: "o1", pair: "tBTC/tUSD", side: "ask", sizeBtc: 0.0007, price: 84_200, expiresAt: "2026-10-22T12:05:00Z", maker: "mm-rule", offer: "x" });
  const r = await v.take(ask);
  assert.deepEqual(calls[0], ["take", "x", "o1", { gives: { [T.tBTC]: "70000" }, wants: { [T.tUSD]: "5894" } }]);
  assert.deepEqual(calls[1], ["sponsor", "o1", "t1"]);
  assert.equal(r.landed, true);
  assert.equal(log.at(-1).kind, "take");
  assert.equal(log.at(-1).side, "buy", "taking an ask buys BTC");
  trader.submitSwap = async () => ({ status: "failed", error: "ledger 103" });
  const r2 = await v.take(ask);
  assert.equal(r2.landed, false);
  assert.deepEqual(calls.at(-1), ["revert", "t1"]);
});

test("holdings in BTC and USD, with coins and what one half can give", async () => {
  const v = midnightVenue({ trader: stand().trader, agentId: "x", types: T });
  assert.deepEqual(await v.holdings(), { btc: 0.007, usd: 470, coins: { tBTC: 10, tUSD: 10 }, spendable: { btc: 0.0028, usd: 188 }, maxInputs: 4, bases: { "tBTC/tUSD": { btc: 0.007, coins: 10, spendable: 0.0028 } } });
});
