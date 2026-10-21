/**
 * A trader over the MCP tools, against a stand-in `call`: the market's shapes
 * go in, tool calls come out, and what the tools answer is handed back in
 * the market's shapes. No process, no chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpTrader, traderEnv } from "../market/mcp-trader.mjs";
import { proofServersOf } from "../market/chain.mjs";

test("several proof servers: each wallet takes the one its index points to; a server off this machine is refused", () => {
  const cfg = { nightgateUrl: "https://gw.example", proofServerUrl: "http://localhost:6300", proofServerUrls: ["http://localhost:6300", "http://localhost:6311"] };
  const at = (index) => traderEnv({ seedHex: "ab".repeat(32), key: "oda_x", cfg, stateFile: "s", index }).NIGHTGATE_PROOF_SERVER_URL;
  assert.deepEqual([at(0), at(1), at(2), at(98)], ["http://localhost:6300", "http://localhost:6311", "http://localhost:6300", "http://localhost:6300"]);
  assert.equal(traderEnv({ seedHex: "ab".repeat(32), key: "oda_x", cfg: { proofServerUrl: "http://localhost:6300" }, stateFile: "s", index: 3 }).NIGHTGATE_PROOF_SERVER_URL, "http://localhost:6300");
  assert.deepEqual(proofServersOf(" http://localhost:6300, http://127.0.0.1:6311 "), ["http://localhost:6300", "http://127.0.0.1:6311"]);
  assert.deepEqual(proofServersOf(undefined), ["http://localhost:6300"]);
  assert.throws(() => proofServersOf("http://localhost:6300,http://proofs.example:6300"), /on this machine, not http:\/\/proofs\.example:6300/);
});

const C = "c".repeat(64);
const D = "d".repeat(64);
const POOL = "00000000-0000-0000-0000-706f6f6c0000";
const OFFER = "11111111-2222-4333-8444-555555555555";

/** Tools by name; each answers a value, a function of its arguments, or throws. */
function trader(tools, extra = {}) {
  const calls = [];
  const call = async (tool, args = {}) => {
    calls.push([tool, args]);
    if (!(tool in tools)) throw new Error(`unexpected tool ${tool}`);
    const t = tools[tool];
    return typeof t === "function" ? t(args) : t;
  };
  return { calls, t: mcpTrader({ name: "trader-0", call, pollMs: 1, ...extra }) };
}

const wallet = (tokens, maxInputs = 4) => ({ synced: true, maxInputs, tokens, pendingHalves: [] });

test("the server of a trader gets its seed, its key, its state file, the proof server and the chain endpoints, nothing else", () => {
  const cfg = { nightgateUrl: "https://gw.example", network: "preprod", indexerHttpUrl: "https://i/http", indexerWsUrl: "wss://i/ws", nodeUrl: "wss://n", proofServerUrl: "http://localhost:6300" };
  const env = traderEnv({ seedHex: "ab".repeat(64), key: "oda_x", cfg, stateFile: "/data/trader-0.state" });
  assert.deepEqual(env, {
    ODATANO_ACCESS_URL: "https://gw.example", ODATANO_ACCESS_KEY: "oda_x", NIGHTGATE_SEED_HEX: "ab".repeat(64),
    NIGHTGATE_SWAP_STATE_FILE: "/data/trader-0.state", NIGHTGATE_PROOF_SERVER_URL: "http://localhost:6300",
    NIGHTGATE_INDEXER_HTTP_URL: "https://i/http", NIGHTGATE_INDEXER_WS_URL: "wss://i/ws", NIGHTGATE_NODE_URL: "wss://n",
  });
});

test("balances and what one half can give come from get_swap_wallet", async () => {
  const { t } = trader({ get_swap_wallet: wallet([{ tokenType: C, balance: "1000", coins: 6, spendable: "700" }]) });
  assert.deepEqual(await t.balances(), { [C]: 1000n });
  assert.equal(await t.spendable(C), 700n);
  assert.equal(await t.spendable(D), 0n, "a type it does not hold");
});

test("a wallet that is still syncing is not read as empty", async () => {
  const { t } = trader({ get_swap_wallet: { synced: false, syncingSeconds: 40 } });
  await assert.rejects(t.balances(), /still syncing \(40 s\)/);
});

test("an offer is built with build_swap_offer and known by the half's id", async () => {
  const { t, calls } = trader({ build_swap_offer: { id: "a".repeat(32), offer: "swapoffer1xyz", halfB64: "b64", bound: true } });
  const made = await t.makeOffer({ give: { type: C, value: 100n }, want: { type: D, value: 30n } });
  assert.deepEqual(calls, [["build_swap_offer", { give: { tokenType: C, amount: "100" }, want: { tokenType: D, amount: "30" }, bind: true }]]);
  assert.equal(made.text, "swapoffer1xyz");
  assert.deepEqual(made.half, { id: "a".repeat(32) });
});

test("an unbound half has no offer file: its base64 is the text", async () => {
  const { t } = trader({ build_swap_offer: { id: "a".repeat(32), halfB64: "b64", bound: false } });
  assert.equal((await t.makeOffer({ give: { type: C, value: 1n }, want: { type: D, value: 1n }, bind: false })).text, "b64");
});

test("taking names the board entry and the agreed terms; the sponsor then gets the half's id and the offer's", async () => {
  const jobs = [{ status: "running" }, { status: "submitted" }, { status: "succeeded", txHash: "00ab" }];
  const { t, calls } = trader({
    take_swap_offer: { id: "b".repeat(32), makerHalfB64: "maker", takerHalfB64: "taker", bound: true },
    sponsor_swap: { jobId: "job-1", status: "pending", sessionId: POOL },
    get_job_status: () => jobs.shift(),
  });
  const taken = await t.takeOffer({ text: "swapoffer1xyz", offerId: OFFER, expect: { gives: { [C]: 100n }, wants: { [D]: 30n } } });
  assert.deepEqual(calls[0], ["take_swap_offer", { offer: "swapoffer1xyz", offerId: OFFER, expect: { gives: { tokenType: C, amount: "100" }, wants: { tokenType: D, amount: "30" } } }]);
  const done = await t.submitSwap({ offerId: OFFER, takerHalf: taken.takerHalf, makerHalfB64: taken.makerHalfB64, takerHalfB64: taken.takerHalfB64 });
  assert.deepEqual(calls[1], ["sponsor_swap", { halfId: "b".repeat(32), offerId: OFFER, idempotencyKey: `otc-swap-${"b".repeat(32)}` }]);
  assert.deepEqual(calls.slice(2).map((c) => c[1]), Array(3).fill({ jobId: "job-1", sessionId: POOL }), "polled with the session the sponsor answered");
  assert.deepEqual(done, { jobId: "job-1", status: "succeeded", txHash: "00ab", error: null });
});

test("terms that name two token types are refused before any tool is called", async () => {
  const { t, calls } = trader({});
  await assert.rejects(t.takeOffer({ text: "x", expect: { gives: { [C]: 1n, [D]: 1n }, wants: { [D]: 1n } } }), /names one token type, not 2/);
  assert.deepEqual(calls, []);
});

test("a failed job comes back with its reason; a poll the server could not answer is asked again", async () => {
  const answers = [() => { throw Object.assign(new Error("upstream down"), { status: 502 }); }, () => ({ status: "failed", errorCode: "CHAIN_EXECUTION_FAILED", errorMessage: "the offer was taken first" })];
  const { t } = trader({ sponsor_swap: { jobId: "job-2", sessionId: POOL }, get_job_status: () => answers.shift()() });
  assert.deepEqual(await t.submitSwap({ takerHalf: { id: "c".repeat(32) } }), { jobId: "job-2", status: "failed", txHash: null, error: "the offer was taken first" });
});

test("a poll the server refuses ends the wait", async () => {
  const { t } = trader({ sponsor_swap: { jobId: "job-3", sessionId: POOL }, get_job_status: () => { throw Object.assign(new Error("key revoked"), { status: 401 }); } });
  await assert.rejects(t.submitSwap({ takerHalf: { id: "c".repeat(32) } }), /key revoked/);
});

test("a swap without a board entry goes to the sponsor by the half's id alone", async () => {
  const { t, calls } = trader({ sponsor_swap: { jobId: "job-4", sessionId: POOL }, get_job_status: { status: "succeeded", txHash: "00cd" } });
  await t.submitSwap({ takerHalf: { id: "d".repeat(32) } });
  assert.deepEqual(calls[0][1], { halfId: "d".repeat(32), idempotencyKey: `otc-swap-${"d".repeat(32)}` });
});

test("merging is a swap with itself: each half gives the most one half can and gets it back as one coin", async () => {
  const { t, calls } = trader({
    get_swap_wallet: wallet([{ tokenType: C, balance: "1000", coins: 7, spendable: "640" }, { tokenType: D, balance: "300", coins: 1, spendable: "300" }]),
    build_swap_offer: { id: "a".repeat(32), offer: "swapoffer1self" },
    take_swap_offer: { id: "b".repeat(32), makerHalfB64: "maker", takerHalfB64: "taker" },
    revert_swap_offer: {},
  });
  const done = await t.consolidate([C, D]);
  const give = { tokenType: C, amount: "640" }, want = { tokenType: D, amount: "300" };
  assert.deepEqual(calls.slice(1), [
    ["build_swap_offer", { give, want, bind: true }],
    ["take_swap_offer", { offer: "swapoffer1self", expect: { gives: give, wants: want } }],
  ]);
  assert.deepEqual(done.takerHalf, { id: "b".repeat(32) });
  calls.length = 0;
  await done.revert();
  assert.deepEqual(calls, [["revert_swap_offer", { id: "b".repeat(32) }], ["revert_swap_offer", { id: "a".repeat(32) }]]);
});

test("nothing to merge: no type has more coins than one half spends, or one of the two is missing", async () => {
  const few = trader({ get_swap_wallet: wallet([{ tokenType: C, balance: "1000", coins: 4, spendable: "1000" }, { tokenType: D, balance: "300", coins: 2, spendable: "300" }]) });
  assert.equal(await few.t.consolidate([C, D]), null);
  const one = trader({ get_swap_wallet: wallet([{ tokenType: C, balance: "1000", coins: 9, spendable: "500" }]) });
  assert.equal(await one.t.consolidate([C, D]), null);
  assert.deepEqual([...few.calls, ...one.calls].map((c) => c[0]), ["get_swap_wallet", "get_swap_wallet"], "nothing was built");
});

test("a merge whose second half cannot be built frees the first", async () => {
  const { t, calls } = trader({
    get_swap_wallet: wallet([{ tokenType: C, balance: "1000", coins: 7, spendable: "640" }, { tokenType: D, balance: "300", coins: 1, spendable: "300" }]),
    build_swap_offer: { id: "a".repeat(32), offer: "swapoffer1self" },
    take_swap_offer: () => { throw new Error("proof server down"); },
    revert_swap_offer: {},
  });
  await assert.rejects(t.consolidate([C, D]), /proof server down/);
  assert.deepEqual(calls.at(-1), ["revert_swap_offer", { id: "a".repeat(32) }]);
});

test("the board: post, list, get and retire are the server's tools", async () => {
  const { t, calls } = trader({
    post_swap_offer: { offerId: OFFER, status: "open" },
    list_swap_offers: (args) => (args.givesType === C ? [{ offerId: OFFER }] : { value: [{ offerId: "other" }] }),
    get_swap_offer: { offerId: OFFER, status: "filled" },
    retire_swap_offer: { offerId: OFFER, status: "retired" },
    revert_swap_offer: {},
  });
  assert.equal((await t.post({ offer: "swapoffer1xyz", tags: ["otc-demo", "trader-0"], expiresAt: "2026-01-01T00:05:00.000Z" })).offerId, OFFER);
  assert.deepEqual(await t.listOffers({ givesType: C, wantsType: D }), [{ offerId: OFFER }]);
  assert.deepEqual(await t.listOffers({ givesType: D, wantsType: C }), [{ offerId: "other" }], "either answer shape");
  assert.equal((await t.getOffer(OFFER)).status, "filled");
  await t.retire(OFFER);
  await t.revert({ id: "a".repeat(32) });
  assert.deepEqual(calls.map((c) => c[0]), ["post_swap_offer", "list_swap_offers", "list_swap_offers", "get_swap_offer", "retire_swap_offer", "revert_swap_offer"]);
  assert.deepEqual(calls[0][1], { offer: "swapoffer1xyz", tags: ["otc-demo", "trader-0"], expiresAt: "2026-01-01T00:05:00.000Z" });
  assert.deepEqual(calls[4][1], { offerId: OFFER });
});
