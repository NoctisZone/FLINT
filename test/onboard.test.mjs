/** The onboarding functions and the steps of an order over stand-ins: no chain, no Strike. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountsFile, agentWallet, coinSizes, connectStrike, fundFromTreasury, onboardSteps, orderPayments, ORDER_STEPS, serverRetry, sponsoredRetry, treasuryWallet, waitForCredit } from "../gateway/onboard.mjs";
import { utxoHex } from "../gateway/cardano.mjs";
import { onboardJob } from "../gateway/onboard-job.mjs";
import { profiles } from "../agents/profiles.mjs";

const MASTER = "ab".repeat(32);
// where the set-up fee goes in these tests: a wallet of its own
const PAY_TO = agentWallet(MASTER, "project").address;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "flint-onb-"));
const noSleep = async () => {};

test("wallets from the master seed are stable; the accounts file is written with mode 600 and read back", () => {
  const w = agentWallet(MASTER, "nova-7");
  assert.equal(w.address, agentWallet(MASTER, "nova-7").address);
  assert.notEqual(w.address, agentWallet(MASTER, "mm-rule").address);
  assert.match(treasuryWallet(MASTER).address, /^addr_test1v/, "the treasury is an enterprise address");
  assert.match(w.address, /^addr_test1q/, "an agent has a base address");
  const f = accountsFile(path.join(tmp(), "acc.json"));
  assert.deepEqual(f.read(), {});
  f.save({ "nova-7": { accountId: "acc-1" } });
  assert.deepEqual(f.read(), { "nova-7": { accountId: "acc-1" } });
});

test("coin sizes: quote-sized with headroom, in satoshi and cents", () => {
  assert.deepEqual(coinSizes({ quoteUsd: 150, mark: 80_000 }), { sats: 196875, cents: 15750, usd: 157.5 });
  assert.deepEqual(coinSizes({ quoteUsd: 100, mark: 80_000, headroom: 1 }), { sats: 125000, cents: 10000, usd: 100 });
});

test("sponsoredRetry waits for 'Retry after N s' and gives up after its tries; other errors pass through", async () => {
  const waits = [];
  let n = 0;
  const r = await sponsoredRetry(async () => { if (n++ < 2) throw new Error("Rate limited. Retry after 7 s"); return "ok"; }, { sleep: async (ms) => waits.push(ms) });
  assert.deepEqual([r, waits], ["ok", [9000, 9000]]);
  await assert.rejects(sponsoredRetry(async () => { throw new Error("Rate limited. Retry after 1 s"); }, { tries: 2, sleep: noSleep }), /Retry after/);
  await assert.rejects(sponsoredRetry(async () => { throw new Error("boom"); }, { sleep: noSleep }), /boom/);
});

test("serverRetry tries again after a 5xx from Strike or ODATANO, says so, and gives up; a 4xx is final", async () => {
  const notes = [];
  let n = 0;
  const r = await serverRetry(async () => { if (n++ < 2) throw new Error("Strike 500 on /v2/deposit/build-tx: failed to build transaction"); return "built"; }, { sleep: noSleep, onRetry: (w) => notes.push(w) });
  assert.deepEqual([r, notes.length], ["built", 2]);
  assert.match(notes[0], /Strike 500/);
  await assert.rejects(serverRetry(async () => { throw new Error("ODATANO 503 on /x"); }, { tries: 2, sleep: noSleep }), /ODATANO 503/);
  await assert.rejects(serverRetry(async () => { throw new Error("Strike 400 on /x: bad"); }, { sleep: noSleep }), /Strike 400/);
});

test("fund from the treasury over Koios and over ODATANO, then wait until the indexer shows it", async () => {
  const treasury = treasuryWallet(MASTER);
  const to = agentWallet(MASTER, "nova-7").address;
  const seen = [];
  const chain = { kind: "koios", utxos: async () => [{ tx_hash: "ab".repeat(32), tx_index: 0, value: "900000000" }], submit: async (cbor) => { seen.push(cbor.length > 100); return "cd".repeat(32); }, txInfo: async () => (seen.length > 1 ? [{ tx_hash: "cd".repeat(32) }] : []) };
  const log = [];
  const r = await fundFromTreasury({ chain, treasury, to, lovelace: 850_000_000n, sleep: async () => seen.push(true), everyMs: 1, log: (e) => log.push(e.kind) });
  assert.deepEqual([r.txHash, r.landed, log], ["cd".repeat(32), true, ["fund.submitted", "fund.landed"]]);
  let built = null;
  const od = { kind: "odatano", buildTransfer: async (x) => { built = x; return { unsignedTxCbor: "84a300818258200000000000000000000000000000000000000000000000000000000000000000000181825839" + "0".repeat(114) + "1a05f5e100021a00030d40a0f5f6" }; }, submit: async () => "ef".repeat(32), txInfo: async () => [] };
  const r2 = await fundFromTreasury({ chain: od, treasury, to, lovelace: 1_000_000n, tries: 2, sleep: noSleep });
  assert.deepEqual([built.from, built.to, built.lovelace, r2.landed], [treasury.address, to, 1_000_000n, false]);
});

test("builder connect saves the account under the agent, an earlier one goes to previous", async () => {
  const dir = tmp();
  const accounts = accountsFile(path.join(dir, "acc.json"));
  const wallet = agentWallet(MASTER, "nova-7");
  let n = 0;
  const fetch = async (url, init) => url.endsWith("request-signature")
    ? new Response(JSON.stringify({ nonce: "n", message_to_sign: `Connect ${JSON.parse(init.body).public_key}` }))
    : new Response(JSON.stringify({ account_id: `acc-${++n}`, builder_code: "flint", fee_share_bps: 5 }));
  const a = await connectStrike({ agentId: "nova-7", wallet, master: MASTER, accounts, baseUrl: "https://x", code: "flint", feeShareBps: 5, fetch, now: () => 1 });
  assert.deepEqual([a.accountId, a.builderCode, a.feeShareBps, a.address], ["acc-1", "flint", 5, wallet.address]);
  assert.equal(accounts.read()["nova-7"].apiWalletPrivateKeyHex.length, 64);
  await connectStrike({ agentId: "nova-7", wallet, master: MASTER, accounts, baseUrl: "https://x", code: "flint", fetch, now: () => 2 });
  assert.deepEqual([accounts.read()["nova-7"].accountId, accounts.read().previous[0].accountId], ["acc-2", "acc-1"]);
  await assert.rejects(connectStrike({ agentId: "x", wallet, master: MASTER, accounts, baseUrl: "https://x", code: "", fetch }), /STRIKE_BUILDER_CODE/);
});

test("waitForCredit polls the balance until it is there, or gives up", async () => {
  let n = 0;
  const strike = { balances: async () => { n++; if (n === 1) throw new Error("503"); return [{ walletBalance: n < 3 ? "0" : "193.5" }]; } };
  assert.equal(await waitForCredit({ strike, sleep: noSleep, everyMs: 1 }), 193.5);
  let t = 0;
  assert.equal(await waitForCredit({ strike: { balances: async () => [{ walletBalance: "0" }] }, sleep: async () => { t += 60_000; }, now: () => t, timeoutMs: 100_000 }), null);
});

/** The steps of an order over stand-ins, driven by the job: wallet, pay, account, deposit, mint, credit, open, register, quote. */
function stand({ accounts, creditAfter = 1, mintFails = 0, paid = null, waitMs = 100_000 } = {}) {
  const calls = { mints: [], submits: [], builds: [], confirms: [], balanceAsks: 0, registered: null, txInfo: [] };
  const owner = treasuryWallet(MASTER).address;
  const agent = agentWallet(MASTER, "nova-7");
  const balances = { agent: 0n };
  const chain = {
    kind: "koios",
    utxos: async (addr) => (addr === agent.address ? [{ tx_hash: "ad".repeat(32), tx_index: 0, value: "505000000" }] : [{ tx_hash: "ab".repeat(32), tx_index: 0, value: "900000000" }, { tx_hash: "ac".repeat(32), tx_index: 1, value: "50000000" }]),
    submit: async (cbor) => { calls.submits.push(cbor); balances.agent = 505_000_000n; return "cd".repeat(32); },
    txInfo: async (h) => { calls.txInfo.push(h[0]); return [{ tx_hash: h[0] }]; },
    balance: async () => balances.agent,
  };
  const client = {
    syncClock: async () => {}, balances: async () => [{ walletBalance: ++calls.balanceAsks > creditAfter ? "193.2" : "0" }],
    depositQuote: async () => ({ request_id: "req-1", quote: { usd_value: "193.2" } }),
    depositBuildTx: async (b) => { calls.builds.push(b); return { format: "cardano_cbor", unsigned_tx: UNSIGNED, expires_at: "x" }; },
    depositConfirm: async (b) => { calls.confirms.push(b); return { status: "pending" }; },
  };
  const strike = { baseUrl: "https://x", code: "flint", feeShareBps: 5, master: MASTER, accounts, chain, clientOf: () => client };
  // Strike's testnet connect answers stand in for fetch
  globalThis.__connect = async (url, init) => url.endsWith("request-signature") ? new Response(JSON.stringify({ nonce: "n", message_to_sign: `Connect ${JSON.parse(init.body).public_key}` })) : new Response(JSON.stringify({ account_id: "acc-7", builder_code: "flint", fee_share_bps: 5 }));
  let quotes = 0, t = 0;
  const mandate = { ...profiles({ owner, expiry: "2026-10-30T00:00:00Z" })["mm-rule"], agentId: "nova-7" };
  const steps = onboardSteps({
    agentId: "nova-7", index: 5, mandate, wallet: agent, owner,
    fee: { lovelace: 20_000_000n, to: PAY_TO, paid }, depositLovelace: 500_000_000n,
    mint: async (spec, amount, index) => { calls.mints.push([spec, Number(amount), index]); if (mintFails-- > 0) throw new Error("Rate limited. Retry after 3 s"); return { status: "succeeded", txHash: "ee".repeat(32) }; },
    mark: async () => 80_000, minQuoteUsd: 100, coins: 2, strike, waitMs,
    open: async () => ({ name: "trader-5" }), register: async (trader, ctx) => { calls.registered = trader.name; ctx.set("toolsKey", "flint_test"); quotes = 1; }, quoted: () => quotes > 0,
    sleep: noSleep, now: () => (t += 20_000), log: () => {},
  });
  const payments = orderPayments({ jobOf: (id) => (id === "nova-7" ? stand.job : null), chain });
  return { steps, calls, payments, owner, agent, client };
}
// an unsigned deposit transaction shaped like the one Strike builds: a body map, an empty witness set, valid, no auxiliary data
import { cborEncode, cborDecode, signTransaction } from "../gateway/cardano.mjs";
const W = agentWallet(MASTER, "nova-7");
const UNSIGNED = Buffer.concat([Buffer.from([0x84]), Buffer.from(cborEncode(new Map([[0n, [[Buffer.from("ad".repeat(32), "hex"), 0n]]], [1n, [[new Uint8Array(29), 500_000_000n], [W.addressBytes, 4_800_000n]]], [2n, 200_000n]]))), Buffer.from(cborEncode(new Map())), Buffer.from([0xf5, 0xf6])]).toString("hex");
// timers the job's waits use: fired by hand
const timers = [];
const setTimer = (fn) => { timers.push(fn); return timers.length; };
const clearTimer = () => {};
const jobOf = (steps, extra = {}) => onboardJob({ agentId: "nova-7", index: 5, owner: "o", mind: "rules", order: ORDER_STEPS, spec: { pay: "wallet", depositLovelace: "500000000", feeLovelace: "20000000", toolsKey: true }, steps, now: () => 0, setTimer, clearTimer, ...extra });
const tick = () => new Promise((r) => setImmediate(r));

test("an order paid from the wallet: the job waits for the owner's one transaction (fee to the project, deposit money to the agent), the agent's wallet deposits at Strike, then mints, credit, open, register and quote", async () => {
  const accounts = accountsFile(path.join(tmp(), "acc.json"));
  const { steps, calls, payments, owner, agent } = stand({ accounts });
  const origFetch = globalThis.fetch;
  globalThis.fetch = globalThis.__connect;
  try {
    const j = jobOf(steps);
    stand.job = j;
    const run = j.run();
    for (let i = 0; i < 20 && !j.waitingFor.includes("pay"); i++) await tick();
    const v0 = j.view();
    assert.deepEqual([v0.current, j.waitingFor, v0.feeLovelace, v0.depositLovelace, v0.toAgentLovelace, v0.cardano, v0.owner], ["pay", ["pay"], "20000000", "500000000", "505000000", agent.address, owner]);
    assert.match(v0.steps[1].detail, /waiting for your payment of 525 tADA/);
    // the payment: built over the owner's CIP-30 UTxOs, two outputs, signed by the owner's key here, submitted, delivered
    const cip30 = [utxoHex({ tx_hash: "ab".repeat(32), tx_index: 0, value: "900000000" }, treasuryWallet(MASTER).addressBytes)];
    const built = await payments.build("nova-7", { utxos: cip30 });
    assert.deepEqual(built.outputs, [{ to: PAY_TO, lovelace: "20000000" }, { to: agent.address, lovelace: "505000000" }]);
    assert.equal(built.total, "525000000");
    const body = cborDecode(Buffer.from(built.unsignedTxCbor, "hex")).value[0];
    assert.deepEqual(body.get(1n).map((o) => o[1]), [20_000_000n, 505_000_000n, 900_000_000n - 525_000_000n - 200_000n], "fee, deposit money, change");
    const signedPay = signTransaction(built.unsignedTxCbor, treasuryWallet(MASTER));
    const f = await payments.submit("nova-7", { signedTxCbor: signedPay.cborHex });
    assert.equal(f.txHash, "cd".repeat(32));
    const r = await run;
    assert.equal(r.status, "done", r.error);
    const v = j.view();
    assert.deepEqual(v.steps.map((s) => s.step), ORDER_STEPS);
    assert.match(v.steps[1].detail, /fee 20 tADA and deposit money paid, tx cdcd/);
    assert.equal(accounts.read()["nova-7"].accountId, "acc-7");
    assert.deepEqual([calls.builds[0].user_address, calls.confirms[0]], [agent.address, { request_id: "req-1", tx_hash: "cd".repeat(32) }], "the agent's own wallet deposits at Strike");
    assert.deepEqual(calls.mints.map((m) => m[0]), ["market:tBTC", "market:tBTC", "market:tUSD", "market:tUSD"]);
    assert.deepEqual([v.steps[5].detail, v.toolsKey, calls.registered], ["193.20 USD credited on Strike", "flint_test", "trader-5"]);
    assert.equal(await payments.build("ghost").catch((e) => e.status), 404);
  } finally { globalThis.fetch = origFetch; }
});

test("an order paid by x402 asks the owner for the deposit money alone; a payment not signed in time fails the job and the retry waits again; a payment that comes early is kept for the step", async () => {
  const accounts = accountsFile(path.join(tmp(), "acc.json"));
  const paid = stand({ accounts, paid: { txHash: "0a".repeat(32), amountUnits: "20000000" } });
  const origFetch = globalThis.fetch;
  globalThis.fetch = globalThis.__connect;
  try {
    const j = jobOf(paid.steps);
    stand.job = j;
    const run = j.run();
    for (let i = 0; i < 20 && !j.waitingFor.includes("pay"); i++) await tick();
    assert.match(j.view().steps[1].detail, /waiting for your payment of 505 tADA/);
    const built = await paid.payments.build("nova-7");
    assert.deepEqual(built.outputs.map((o) => o.lovelace), ["505000000"], "no fee output: x402 paid it");
    j.deliver("pay", { txHash: "cd".repeat(32) });
    assert.equal((await run).status, "done");
    assert.match(j.view().steps[1].detail, /deposit money paid/);
    // not signed in time
    const slow = stand({ accounts: accountsFile(path.join(tmp(), "acc.json")) });
    const j2 = jobOf(slow.steps);
    stand.job = j2;
    const run2 = j2.run();
    for (let i = 0; i < 20 && !j2.waitingFor.includes("pay"); i++) await tick();
    timers.at(-1)();
    const r2 = await run2;
    assert.deepEqual([r2.status, j2.view().current], ["failed", "pay"]);
    assert.match(r2.error, /not signed in time/);
    j2.deliver("pay", { txHash: "cd".repeat(32) });
    assert.equal((await j2.retry()).status, "done");
  } finally { globalThis.fetch = origFetch; }
});

test("a retry after a failed mint goes on with the coins still missing", async () => {
  const accounts = accountsFile(path.join(tmp(), "acc.json"));
  const { steps, calls } = stand({ accounts, mintFails: 6, paid: { txHash: "0a".repeat(32) } });
  const origFetch = globalThis.fetch;
  globalThis.fetch = globalThis.__connect;
  try {
    const j = jobOf(steps);
    stand.job = j;
    const run = j.run();
    for (let i = 0; i < 20 && !j.waitingFor.includes("pay"); i++) await tick();
    j.deliver("pay", { txHash: "cd".repeat(32) });
    const r = await run;
    assert.deepEqual([r.status, j.view().current], ["failed", "mint"]);
    assert.match(r.error, /Retry after/);
    calls.mints.length = 0;
    const r2 = await j.retry();
    assert.equal(r2.status, "done", r2.error);
    assert.equal(calls.mints.length, 6, "two more refusals, then the four coins");
  } finally { globalThis.fetch = origFetch; }
});
