/** The two boards a maker's half can wait on: the server's and the gateway's; the venue over the gateway's board. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayBoard, serverBoard } from "../gateway/desk.mjs";
import { midnightVenue } from "../gateway/midnight.mjs";

const T = { tBTC: "b".repeat(64), tUSD: "u".repeat(64) };
const T0 = Date.parse("2026-10-22T12:00:00Z");
const ask = { offer: "half-1", tags: ["flint", "mm-rule", "ask"], expiresAt: "2026-10-22T12:05:00Z", gives: { type: T.tBTC, value: 70000n }, wants: { type: T.tUSD, value: 5894n } };

test("gateway board: a posted half is listed by its legs, newest first, in the board's row shape", async () => {
  let t = T0;
  const b = gatewayBoard({ now: () => t });
  const { offerId } = await b.post(ask);
  t += 1000;
  const second = await b.post({ ...ask, offer: "half-2" });
  const rows = await b.listOffers({ givesType: T.tBTC, wantsType: T.tUSD });
  assert.deepEqual(rows.map((r) => r.offer), ["half-2", "half-1"]);
  assert.deepEqual(await b.listOffers({ givesType: T.tUSD, wantsType: T.tBTC }), []);
  const r = await b.getOffer(offerId);
  assert.deepEqual({ ...r, postedAt: undefined }, { offerId, offer: "half-1", tags: ask.tags, expiresAt: ask.expiresAt, givesType: T.tBTC, givesAmount: "70000", wantsType: T.tUSD, wantsAmount: "5894", status: "open", filledTxHash: null, postedAt: undefined });
  assert.ok(!("takenBy" in r), "the claim is the board's own business");
  assert.equal(b.kind, "gateway");
  assert.equal(b.size, 2);
  await b.retire(second.offerId);
  assert.equal((await b.getOffer(second.offerId)).status, "retired");
});

test("gateway board: a claimed row is off the list and refused to a second taker; settled turns it filled, released puts it back", async () => {
  const b = gatewayBoard({ now: () => T0 });
  const { offerId } = await b.post(ask);
  b.claim(offerId, "citizen-a");
  assert.deepEqual(await b.listOffers({}), []);
  assert.throws(() => b.claim(offerId, "citizen-b"), /being taken/);
  await assert.rejects(b.retire(offerId), /being taken/);
  b.release(offerId);
  assert.equal((await b.listOffers({})).length, 1);
  b.claim(offerId, "citizen-b");
  b.settled(offerId, "ff".repeat(32));
  assert.deepEqual([(await b.getOffer(offerId)).status, (await b.getOffer(offerId)).filledTxHash], ["filled", "ff".repeat(32)]);
  assert.throws(() => b.claim(offerId, "citizen-a"), /is filled/);
  await assert.rejects(b.getOffer("nope"), /no offer nope/);
});

test("gateway board: a row expires at its expiresAt and cannot be taken or retired after", async () => {
  let t = T0;
  const b = gatewayBoard({ now: () => t });
  const { offerId } = await b.post(ask);
  t = Date.parse(ask.expiresAt);
  assert.deepEqual(await b.listOffers({}), []);
  assert.equal((await b.getOffer(offerId)).status, "expired");
  assert.throws(() => b.claim(offerId, "citizen-a"), /is expired/);
  await assert.rejects(b.retire(offerId), /is expired/);
});

test("server board: the trader's board tools, the legs dropped from the post", async () => {
  const calls = [];
  const trader = { post: (a) => { calls.push(a); return { offerId: "q1" }; }, listOffers: async () => [], getOffer: async (id) => ({ offerId: id }), retire: async (id) => { calls.push(["retire", id]); } };
  const b = serverBoard(trader);
  assert.equal(b.kind, "server");
  assert.deepEqual(await b.post(ask), { offerId: "q1" });
  assert.deepEqual(calls[0], { offer: "half-1", tags: ask.tags, expiresAt: ask.expiresAt });
  await b.retire("q1");
  assert.deepEqual(calls[1], ["retire", "q1"]);
});

/** Two venues of one process over one gateway board: a maker and a taker, the trader's board tools never called. */
function pair() {
  const calls = [];
  const board = gatewayBoard({ now: () => T0 });
  const trader = (name, outcome = { status: "succeeded", txHash: "ff".repeat(32) }) => ({
    async makeOffer({ give, want }) { calls.push([name, "make", give, want]); return { text: `${name}-half`, half: { id: `${name}-h` }, provingMs: 5 }; },
    async revert(half) { calls.push([name, "revert", half.id]); },
    async takeOffer({ text, offerId, expect }) { calls.push([name, "take", text, offerId, expect]); return { takerHalf: { id: `${name}-t` }, provingMs: 6 }; },
    async submitSwap({ offerId, takerHalf }) { calls.push([name, "sponsor", offerId, takerHalf.id]); if (outcome instanceof Error) throw outcome; return outcome; },
    post() { throw new Error("server board touched"); }, retire() { throw new Error("server board touched"); }, getOffer() { throw new Error("server board touched"); }, listOffers() { throw new Error("server board touched"); },
  });
  return { calls, board, trader };
}

test("over the gateway board a quote is posted with its legs, the taker finds it, takes it without an offerId, and the maker's poll sees the fill", async () => {
  const { calls, board, trader } = pair();
  const maker = midnightVenue({ trader: trader("maker"), agentId: "mm-rule", types: T, board, now: () => T0 });
  const taker = midnightVenue({ trader: trader("taker"), agentId: "citizen-a", types: T, board, now: () => T0 });
  assert.equal(maker.boardKind, "gateway");
  const q = await maker.quote({ side: "ask", sizeBtc: 0.0007, price: 84_200, ttlSec: 300 });
  const seen = await taker.board();
  assert.equal(seen.length, 1);
  assert.deepEqual({ side: seen[0].side, sizeBtc: seen[0].sizeBtc, price: seen[0].price, maker: seen[0].maker, offer: seen[0].offer, quoteId: seen[0].quoteId }, { side: "ask", sizeBtc: 0.0007, price: 84_200, maker: "mm-rule", offer: "maker-half", quoteId: q.quoteId });
  const r = await taker.take(seen[0]);
  assert.equal(r.landed, true);
  const take = calls.find((c) => c[1] === "take");
  assert.deepEqual([take[2], take[3]], ["maker-half", undefined], "the offer text is handed over, no board id");
  assert.deepEqual(take[4], { gives: { [T.tBTC]: "70000" }, wants: { [T.tUSD]: "5894" } });
  assert.deepEqual(calls.find((c) => c[1] === "sponsor").slice(2), [undefined, "taker-t"], "the sponsor gets the taken half alone");
  const fills = await maker.pollFills();
  assert.deepEqual(fills.map(({ at, ...f }) => f), [{ id: q.quoteId, pair: "tBTC/tUSD", side: "sell", sizeBtc: 0.0007, price: 84_200, txHash: "ff".repeat(32) }]);
  assert.deepEqual(maker.openQuotes, []);
  assert.deepEqual(await taker.board(), []);
});

test("over the gateway board a take that fails releases the row for the next taker and reverts the taker's half", async () => {
  const { calls, board, trader } = pair();
  const maker = midnightVenue({ trader: trader("maker"), agentId: "mm-rule", types: T, board, now: () => T0 });
  const bad = midnightVenue({ trader: trader("bad", new Error("sponsor down")), agentId: "citizen-a", types: T, board, now: () => T0 });
  const good = midnightVenue({ trader: trader("good", { status: "failed", txHash: null }), agentId: "citizen-b", types: T, board, now: () => T0 });
  await maker.quote({ side: "bid", sizeBtc: 0.0007, price: 84_000, ttlSec: 300 });
  const [q] = await bad.board();
  await assert.rejects(bad.take(q), /sponsor down/);
  assert.deepEqual(calls.filter((c) => c[1] === "revert").map((c) => c[2]), ["bad-t"]);
  assert.equal((await good.board()).length, 1, "released");
  const r = await good.take(q);
  assert.equal(r.landed, false);
  assert.equal((await maker.board()).length, 1, "a failed swap leaves the quote open");
  assert.deepEqual(await maker.pollFills(), []);
  await maker.retireAll();
  assert.equal((await maker.board()).length, 0);
  assert.deepEqual(calls.filter((c) => c[0] === "maker" && c[1] === "revert").map((c) => c[2]), ["maker-h"], "the maker's coins are freed");
});
