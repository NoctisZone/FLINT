/** A payout over stand-ins: Strike's quote signed by the agent's wallet, the confirm, the ADA landing on the agent's wallet, the forward to the owner. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withdrawRoom, withdrawSteps, WITHDRAW_STEPS } from "../gateway/withdraw.mjs";
import { onboardJob } from "../gateway/onboard-job.mjs";
import { agentWallet, treasuryWallet } from "../gateway/onboard.mjs";
import { cborDecode, verifySignData } from "../gateway/cardano.mjs";

const MASTER = "cd".repeat(32);
const noSleep = async () => {};
const T0 = Date.parse("2026-10-22T12:00:00Z");

/** Strike's limits as the testnet answers them: 100 ADA an hour, 500 a day, the hour window started 20 minutes ago. */
const limits = ({ hourUsed = 0, dayUsed = 77.67 } = {}) => ({
  asset: "ADA", blockchain: "cardano", as_of: T0 / 1000,
  buckets: {
    per_asset_1h: { window_seconds: 3600, limit: "100", used: String(hourUsed), remaining: String(100 - hourUsed), window_start: T0 / 1000 - 1200 },
    per_asset_24h: { window_seconds: 86400, limit: "500", used: String(dayUsed), remaining: String(500 - dayUsed), window_start: T0 / 1000 - 40000 },
    global_1h: { window_seconds: 3600, limit: "100", used: String(hourUsed), remaining: String(100 - hourUsed), window_start: T0 / 1000 - 1200 },
    global_24h: { window_seconds: 86400, limit: "500", used: String(dayUsed), remaining: String(500 - dayUsed), window_start: T0 / 1000 - 40000 },
  },
  large_withdrawal: { threshold: "50", queue_delay_seconds: 600, estimated_total_delay_seconds: 720 },
});

function stand({ landsAfter = 2, usd = "all", available = "150.25", lim = limits(), adaUsd = "0.2125" } = {}) {
  const wallet = agentWallet(MASTER, "nova-7");
  const owner = treasuryWallet(MASTER).address;
  const calls = { quotes: [], confirms: [], submits: [] };
  let reads = 0;
  const strike = {
    balances: async () => [{ walletBalance: "181.50", availableBalance: available, maxWithdrawAmount: available }],
    withdrawLimits: async () => lim,
    markPrice: async (symbol) => ({ s: symbol, p: adaUsd }),
    withdrawQuote: async (b) => { calls.quotes.push(b); return { withdraw_id: "wd-1", fee: "0.5", message_to_sign: Buffer.from(`Withdraw ${b.usd_value} USD`, "utf8").toString("hex"), tx_cbor: null }; },
    withdrawConfirm: async (b) => { calls.confirms.push(b); return { request_id: "req-9", status: "pending" }; },
  };
  const chain = {
    kind: "koios",
    balance: async () => (++reads > landsAfter ? 702_000_000n : 2_000_000n),
    utxos: async () => [{ tx_hash: "ab".repeat(32), tx_index: 0, value: "2000000" }, { tx_hash: "ac".repeat(32), tx_index: 1, value: "700000000" }],
    submit: async (cbor) => { calls.submits.push(cbor); return "ef".repeat(32); },
  };
  let t = T0;
  const steps = withdrawSteps({ agentId: "nova-7", wallet, owner, strike, chain, usd, sleep: noSleep, now: () => (t += 60_000), settleMs: 3600_000 });
  return { steps, calls, wallet, owner, strike };
}

test("all of what Strike lets go: quoted, the message signed by the agent's wallet, confirmed, settled when the wallet balance rises, forwarded to the owner minus what the wallet keeps", async () => {
  const { steps, calls, wallet, owner } = stand({ available: "20.25" });
  const j = onboardJob({ agentId: "nova-7", index: null, owner, mind: null, kind: "withdraw", order: WITHDRAW_STEPS, spec: { usd: "all" }, steps, now: () => 0 });
  const r = await j.run();
  assert.equal(r.status, "done", r.error);
  assert.deepEqual(calls.quotes, [{ blockchain: "cardano", mode: "balance", usd_value: "20.25", asset: "ADA" }], "the asset named: Strike refuses the quote without it");
  const [sig, key] = calls.confirms[0].wallet_signature.split(":");
  const v = verifySignData(sig, key);
  assert.deepEqual([v.ok, v.payload.toString("utf8"), Buffer.from(v.addressBytes).toString("hex") === Buffer.from(wallet.addressBytes).toString("hex")], [true, "Withdraw 20.25 USD", true], "Strike's hex message signed as bytes by the registered wallet");
  assert.equal(calls.confirms[0].withdraw_id, "wd-1");
  assert.equal("signed_tx_cbor" in calls.confirms[0], false, "no Cardano tx in this quote");
  const v2 = j.view();
  assert.deepEqual([v2.kind, v2.usd, v2.askedUsd, v2.cappedFromUsd, v2.feeUsd, v2.requestId, v2.strikeStatus, v2.paidOut, v2.txHash], ["withdraw", 20.25, "all", null, "0.5", "req-9", "pending", "698800000", "ef".repeat(32)]);
  assert.deepEqual(v2.limit, { limitAda: 100, usedAda: 0, remainingAda: 100, resetsAt: "2026-10-22T12:40:00.000Z", adaUsd: 0.2125 });
  const tx = cborDecode(Buffer.from(calls.submits[0], "hex"));
  const outputs = tx.value[0].get(1n);
  assert.equal(outputs[0][1], 698_800_000n, "702 on the wallet, 3 kept for Strike's next request, 0.2 fee: 698.8 to the owner");
  assert.match(v2.steps[0].detail, /^20\.25 USD quoted, Strike fee 0\.5 USD$/);
  assert.match(v2.steps.at(-1).detail, /698\.80 tADA sent to your wallet/);
});

test("a payout above Strike's hourly limit is capped at what is left, the step says so and when the rest can follow; a used-up limit refuses with the time", async () => {
  // 100 ADA left at 0.2125 USD with a 2 % haircut: 20.82 USD, out of the 150.25 available
  const all = stand();
  const j = onboardJob({ agentId: "nova-7", index: null, owner: "o", mind: null, kind: "withdraw", order: WITHDRAW_STEPS, spec: { usd: "all" }, steps: all.steps, now: () => 0 });
  assert.equal((await j.run()).status, "done");
  assert.equal(all.calls.quotes[0].usd_value, "20.82");
  const v = j.view();
  assert.deepEqual([v.usd, v.askedUsd, v.cappedFromUsd], [20.82, "all", 150.25]);
  assert.match(v.steps[0].detail, /^20\.82 USD quoted of the 150\.25 asked: Strike allows 100 ADA an hour and 100\.00 were left; the rest can follow in about 3\d min\. Strike fee 0\.5 USD$/);
  // 55 USD asked with 60 ADA used this hour: 40 ADA left, 8.33 USD
  const some = stand({ usd: 55, lim: limits({ hourUsed: 60 }) });
  const j2 = onboardJob({ agentId: "nova-7", index: null, owner: "o", mind: null, kind: "withdraw", order: WITHDRAW_STEPS, spec: { usd: 55 }, steps: some.steps, now: () => 0 });
  assert.equal((await j2.run()).status, "done");
  assert.deepEqual([some.calls.quotes[0].usd_value, j2.view().cappedFromUsd, j2.view().limit.remainingAda], ["8.33", 55, 40]);
  // the day window tighter than the hour: 30 ADA left of 500
  const day = stand({ usd: 10, lim: limits({ hourUsed: 0, dayUsed: 470 }) });
  const j3 = onboardJob({ agentId: "nova-7", index: null, owner: "o", mind: null, kind: "withdraw", order: WITHDRAW_STEPS, spec: { usd: 10 }, steps: day.steps, now: () => 0 });
  assert.equal((await j3.run()).status, "done");
  assert.match(j3.view().steps[0].detail, /Strike allows 500 ADA a day and 30\.00 were left/);
  // under the limit: untouched
  const fine = stand({ usd: 10 });
  const j4 = onboardJob({ agentId: "nova-7", index: null, owner: "o", mind: null, kind: "withdraw", order: WITHDRAW_STEPS, spec: { usd: 10 }, steps: fine.steps, now: () => 0 });
  assert.equal((await j4.run()).status, "done");
  assert.deepEqual([fine.calls.quotes[0].usd_value, j4.view().cappedFromUsd], ["10", null]);
  // nothing left this hour
  const none = stand({ usd: 10, lim: limits({ hourUsed: 100 }) });
  const j5 = onboardJob({ agentId: "nova-7", index: null, owner: "o", mind: null, kind: "withdraw", order: WITHDRAW_STEPS, spec: { usd: 10 }, steps: none.steps, now: () => 0 });
  const r5 = await j5.run();
  assert.equal(r5.status, "failed");
  assert.match(r5.error, /^quote: Strike's withdrawal limit is used up: 100\.00 of 100 ADA; the next payout can go in about 3\d min$/);
  assert.equal(none.calls.quotes.length, 0, "no quote asked for");
  // the room as the page reads it
  const room = await withdrawRoom({ strike: stand({ lim: limits({ hourUsed: 60 }) }).strike, now: () => T0 });
  assert.deepEqual([room.availableUsd, room.limitUsd, room.nowUsd, room.hour.remainingAda, room.day.limitAda, room.largeAboveAda, room.largeDelaySec, room.adaUsd], [150.25, 8.33, 8.33, 40, 500, 50, 720, 0.2125]);
  const free = await withdrawRoom({ strike: { ...stand().strike, withdrawLimits: async () => ({}) }, now: () => T0 });
  assert.deepEqual([free.limitUsd, free.nowUsd, free.hour], [null, 150.25, null], "no limits from Strike: the balance is the room");
});

test("nothing available: the quote step refuses; Strike slow to pay: settle fails and a retry waits again", async () => {
  const poor = stand({ available: "0" });
  const j = onboardJob({ agentId: "x", index: null, owner: "o", mind: null, kind: "withdraw", order: WITHDRAW_STEPS, spec: {}, steps: poor.steps, now: () => 0 });
  assert.match((await j.run()).error, /nothing to withdraw/);
  const slow = stand({ landsAfter: 1000 });
  const j2 = onboardJob({ agentId: "nova-7", index: null, owner: "o", mind: null, kind: "withdraw", order: WITHDRAW_STEPS, spec: {}, steps: slow.steps, now: () => 0 });
  const r2 = await j2.run();
  assert.deepEqual([r2.status, j2.view().current], ["failed", "settle"]);
  assert.match(r2.error, /not paid out yet/);
  assert.equal(slow.calls.confirms.length, 1);
  await j2.retry();
  assert.equal(slow.calls.confirms.length, 1, "the retry does not ask Strike twice");
});
