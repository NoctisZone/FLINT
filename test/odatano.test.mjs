/** The ODATANO chain client against a stand-in gateway: UTxO mapping, a built transfer, submit, lookups. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { odatano } from "../gateway/odatano.mjs";

function gateway(answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname + decodeURIComponent(new URL(url).search);
    calls.push({ path, method: init.method ?? "GET", auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const a = answers(path, calls.at(-1));
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  };
  return { calls, fetch };
}

test("utxos come back in the Koios shape, a transfer is built server-side, submit answers the hash, an unknown tx is skipped", async () => {
  const g = gateway((path, call) => {
    if (path.startsWith("/odata/v4/cardano/LedgerUTxOs")) return { body: { value: [{ txHash: "ab".repeat(32), outputIndex: 1, lovelace: "6399200000" }, { txHash: "cd".repeat(32), outputIndex: 0, lovelace: "2000000", assets: [{ unit: "x" }] }] } };
    if (path.endsWith("/BuildSimpleAdaTransaction")) return { body: { unsignedTxCbor: "84a4", fee: "167261", ID: "b-1" } };
    if (path.endsWith("/SubmitSignedTransaction")) return { body: { txHash: "ef".repeat(32), status: "pending", hasErrors: false } };
    if (path.endsWith("/GetTransaction")) return call.body.hash === "11".repeat(32) ? { status: 404, body: { error: { message: "[ODATANO_NOT_FOUND] not found" } } } : { body: { value: JSON.stringify({ hash: call.body.hash, blockHeight: 5319302 }) } };
    return { status: 404, body: {} };
  });
  const o = odatano({ key: "oda_test", fetch: g.fetch });
  const u = await o.utxos("addr_test1vq");
  assert.deepEqual(u, [{ tx_hash: "ab".repeat(32), tx_index: 1, value: "6399200000" }], "the UTxO with a native asset is left out");
  assert.equal(await o.balance("addr_test1vq"), 6_399_200_000n);
  assert.equal(g.calls[0].auth, "Bearer oda_test");
  assert.match(g.calls[0].path, /LedgerUTxOs\?\$filter=address eq 'addr_test1vq' and spentTxHash eq null/);
  const b = await o.buildTransfer({ from: "a", to: "b", lovelace: 900_000_000n });
  assert.deepEqual(b, { unsignedTxCbor: "84a4", fee: "167261", buildId: "b-1" });
  assert.deepEqual(g.calls.at(-1).body, { senderAddress: "a", recipientAddress: "b", lovelaceAmount: "900000000" });
  assert.equal(await o.submit("84a5"), "ef".repeat(32));
  assert.deepEqual(g.calls.at(-1).body, { signedTxCbor: "84a5", network: "preprod" });
  const t = await o.txInfo(["11".repeat(32), "22".repeat(32)]);
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].tx_hash, t[0].block_height], ["22".repeat(32), 5319302]);
  assert.throws(() => odatano({}), /oda_ key/);
});
