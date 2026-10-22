/** A payout over stand-ins: Strike's quote signed by the agent's wallet, the confirm, the ADA landing on the agent's wallet, the forward to the owner. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withdrawSteps, WITHDRAW_STEPS } from "../gateway/withdraw.mjs";
import { onboardJob } from "../gateway/onboard-job.mjs";
import { agentWallet, treasuryWallet } from "../gateway/onboard.mjs";
import { cborDecode, verifySignData } from "../gateway/cardano.mjs";

const MASTER = "cd".repeat(32);
const noSleep = async () => {};

function stand({ landsAfter = 2 } = {}) {
  const wallet = agentWallet(MASTER, "nova-7");
  const owner = treasuryWallet(MASTER).address;
  const calls = { quotes: [], confirms: [], submits: [] };
  let reads = 0;
  const strike = {
    balances: async () => [{ walletBalance: "181.50", availableBalance: "150.25" }],
    withdrawQuote: async (b) => { calls.quotes.push(b); return { withdraw_id: "wd-1", fee: "0.5", message_to_sign: Buffer.from("Withdraw 150.25 USD", "utf8").toString("hex"), tx_cbor: null }; },
    withdrawConfirm: async (b) => { calls.confirms.push(b); return { request_id: "req-9", status: "pending" }; },
  };
  const chain = {
    kind: "koios",
    balance: async () => (++reads > landsAfter ? 702_000_000n : 2_000_000n),
    utxos: async () => [{ tx_hash: "ab".repeat(32), tx_index: 0, value: "2000000" }, { tx_hash: "ac".repeat(32), tx_index: 1, value: "700000000" }],
    submit: async (cbor) => { calls.submits.push(cbor); return "ef".repeat(32); },
  };
  let t = 0;
  const steps = withdrawSteps({ agentId: "nova-7", wallet, owner, strike, chain, usd: "all", sleep: noSleep, now: () => (t += 60_000), settleMs: 3600_000 });
  return { steps, calls, wallet, owner };
}

test("all of the available balance: quoted, the message signed by the agent's wallet, confirmed, settled when the wallet balance rises, forwarded to the owner minus what the wallet keeps", async () => {
  const { steps, calls, wallet, owner } = stand();
  const j = onboardJob({ agentId: "nova-7", index: null, owner, mind: null, kind: "withdraw", order: WITHDRAW_STEPS, spec: { usd: "all" }, steps, now: () => 0 });
  const r = await j.run();
  assert.equal(r.status, "done", r.error);
  assert.deepEqual(calls.quotes, [{ blockchain: "cardano", mode: "balance", usd_value: "150.25", asset: "ADA" }], "the asset named: Strike refuses the quote without it");
  const [sig, key] = calls.confirms[0].wallet_signature.split(":");
  const v = verifySignData(sig, key);
  assert.deepEqual([v.ok, v.payload.toString("utf8"), Buffer.from(v.addressBytes).toString("hex") === Buffer.from(wallet.addressBytes).toString("hex")], [true, "Withdraw 150.25 USD", true], "Strike's hex message signed as bytes by the registered wallet");
  assert.equal(calls.confirms[0].withdraw_id, "wd-1");
  assert.equal("signed_tx_cbor" in calls.confirms[0], false, "no Cardano tx in this quote");
  const v2 = j.view();
  assert.deepEqual([v2.kind, v2.usd, v2.feeUsd, v2.requestId, v2.strikeStatus, v2.paidOut, v2.txHash], ["withdraw", 150.25, "0.5", "req-9", "pending", "699800000", "ef".repeat(32)]);
  const tx = cborDecode(Buffer.from(calls.submits[0], "hex"));
  const outputs = tx.value[0].get(1n);
  assert.equal(outputs[0][1], 699_800_000n, "702 on the wallet, 2 kept, 0.2 fee: 699.8 to the owner");
  assert.match(v2.steps.at(-1).detail, /699\.80 tADA sent to your wallet/);
});

test("nothing available: the quote step refuses; Strike slow to pay: settle fails and a retry waits again", async () => {
  const { steps } = stand();
  steps.quote.__ = null;
  const poor = { ...steps, quote: withdrawSteps({ agentId: "x", wallet: agentWallet(MASTER, "x"), owner: "o", strike: { balances: async () => [{ availableBalance: "0" }] }, chain: {}, usd: "all" }).quote };
  const j = onboardJob({ agentId: "x", index: null, owner: "o", mind: null, kind: "withdraw", order: WITHDRAW_STEPS, spec: {}, steps: poor, now: () => 0 });
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
