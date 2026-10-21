/** The capital trail from a Strike deposit record and three preprod transactions. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalTrail } from "../gateway/capital.mjs";

const OWNER = "2a4b2776f4835c872c31c253a52d5bf2eec03ca7623b7efc216ad2582906d897";
const MOVE = "f0e6f413b0bca92f0f044e6d123f449fefed43f51336fcf3f52d44fd6ef5e8c0";
const SETTLE = "3d5aa67bbed506a5004eb42402fb1ee37c4e2d8a702e6fc84d6b521c258959e1";
const addr = (s) => ({ payment_addr: { bech32: s.padEnd(60, "x") } });
const txs = {
  [OWNER]: { tx_hash: OWNER, block_height: 5318563, tx_timestamp: 1792594629, inputs: [{ ...addr("addr_test1qrgem4"), value: "20000000000", tx_hash: "aa".repeat(32), tx_index: 1 }], outputs: [{ ...addr("addr_test1qrgem4"), value: "9997822047" }, { ...addr("addr_test1qzs2ll"), value: "10002000000", inline_datum: {} }], metadata: null },
  [MOVE]: { tx_hash: MOVE, block_height: 5318564, tx_timestamp: 1792594686, inputs: [{ ...addr("addr_test1qzs2ll"), value: "10002000000", tx_hash: OWNER, tx_index: 0 }], outputs: [{ ...addr("addr_test1qrgem4"), value: "1820243" }, { ...addr("addr_test1wrprva"), value: "10000000000", inline_datum: {} }], metadata: { 674: { msg: ["Strike V2 Deposit Refund", "Request ID: 9c4d", "Asset: ADA"] } } },
  [SETTLE]: { tx_hash: SETTLE, block_height: 5318573, tx_timestamp: 1792594828, inputs: [{ ...addr("addr_test1wrprva"), value: "10000000000", tx_hash: MOVE, tx_index: 0 }], outputs: [{ ...addr("addr_test1wqgwwc"), value: "184583345577", inline_datum: {} }], metadata: null },
};
const history = async () => ({ transactions: [
  { type: "fee", amount: "-0.06" }, { type: "funding", amount: "0.0018" }, { type: "fee", amount: "-0.07" },
  { type: "deposit", request_id: "9c4d", status: "settled", blockchain: "cardano", blockchain_address: "d19d", tx_hash: `${MOVE}#0`, settlement_tx_hash: SETTLE, asset_symbol: "ADA", asset_amount: "10000000000", amount: "2273.059971", timestamp: 1792594686768 },
] });

test("one deposit, three hops in order, sums and a stable trail hash", async () => {
  const asked = [];
  const txInfo = async (hashes) => { asked.push(hashes); return hashes.map((h) => txs[h]).filter(Boolean); };
  const c = await capitalTrail({ history, txInfo, balance: async () => 2272.93 });
  assert.equal(c.balanceUsd, 2272.93);
  assert.equal(c.depositedUsd, 2273.059971);
  assert.equal(c.feesUsd, -0.13);
  assert.equal(c.fundingUsd, 0.0018);
  assert.equal(c.deposits.length, 1);
  const d = c.deposits[0];
  assert.deepEqual([d.lovelace, d.usd, d.usdPerAda, d.settledAt], [10_000_000_000, 2273.059971, 0.227306, "2026-10-21T14:58:06.768Z"]);
  assert.deepEqual(d.hops.map((h) => [h.label, h.txHash, h.block]), [["owner → Strike intake", OWNER, 5318563], ["Strike intake → vault", MOVE, 5318564], ["vault settlement", SETTLE, 5318573]]);
  assert.equal(d.hops[1].memo, "Strike V2 Deposit Refund | Request ID: 9c4d | Asset: ADA");
  assert.deepEqual(d.hops[0].outputs[1], { address: "addr_test1qzs2…xxxxxx", lovelace: 10_002_000_000, datum: true });
  assert.deepEqual(asked, [[MOVE, SETTLE], [OWNER]], "the owner's transaction is found through the intake move's input");
  assert.match(c.trailHash, /^[0-9a-f]{64}$/);
  assert.equal((await capitalTrail({ history, txInfo })).trailHash, c.trailHash, "the hash does not depend on the balance or the time");
});

test("no deposits: nothing asked of the indexer", async () => {
  const c = await capitalTrail({ history: async () => ({ transactions: [{ type: "fee", amount: "-1" }] }), txInfo: async () => { throw new Error("should not be called"); } });
  assert.deepEqual([c.deposits, c.feesUsd, c.balanceUsd], [[], -1, null]);
});
