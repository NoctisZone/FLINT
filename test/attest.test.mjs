/** Attestations against a stand-in MCP server: the envelope, the build-sponsor-wait chain, the verify call. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { attester, mandateEnvelope, sha256, windowEnvelope } from "../gateway/attest.mjs";

test("the window envelope hashes inputs and outputs and is stable for the same content", () => {
  const w = { agentId: "mm-rule", policyHash: "ab".repeat(32), from: "2026-10-22T10:00:00Z", to: "2026-10-22T11:00:00Z", marks: [84000, 84010], decisions: [{ a: 1 }], fills: [], hedges: [], refusals: [{ rule: "x" }] };
  const a = windowEnvelope(w);
  const b = windowEnvelope({ ...w, decisions: [{ a: 1 }] });
  assert.equal(a.payloadHash, b.payloadHash);
  assert.notEqual(a.payloadHash, windowEnvelope({ ...w, marks: [84000] }).payloadHash);
  assert.match(a.payloadHash, /^[0-9a-f]{64}$/);
  assert.deepEqual([a.envelope.inputs.marks, a.envelope.outputs.decisions, a.envelope.outputs.refusals, a.envelope.policyHash], [2, 1, 1, "ab".repeat(32)]);
  assert.equal(a.payloadHash, sha256(a.envelope), "anyone can re-hash the envelope");
  const m = mandateEnvelope({ agentId: "mm-rule", mandateHash: "cd".repeat(32) });
  assert.equal(m.payloadHash, "cd".repeat(32));
});

test("attest builds under the agent's id, hands the txId to the sponsor, waits for the job; verify asks live state", async () => {
  const calls = [];
  const call = async (tool, args) => {
    calls.push([tool, args]);
    if (tool === "get_attester_identity") return { attesterId: "a1".repeat(32), network: "preprod" };
    if (tool === "build_sponsorable_transaction") return { txId: "tx-1", attesterId: "a1".repeat(32), bytes: 1234 };
    if (tool === "sponsor_unbound_transaction") return { jobId: "job-1", sessionId: "s-1", status: "queued" };
    if (tool === "verify_attestation") return { verified: true, recordKey: "rk".repeat(32), attesterId: args.attesterId, payloadHash: args.payloadHash };
    throw new Error(`unexpected ${tool}`);
  };
  const log = [];
  const a = attester({ call, contractAddress: "e7".repeat(32), waitForJob: async (jobId) => ({ status: "succeeded", txHash: "00ab".repeat(16) }), log: (e) => log.push(e), now: () => 1000 });
  const r = await a.attest({ payloadHash: "cd".repeat(32), metadataHash: "ef".repeat(32), label: "mandate" });
  assert.deepEqual([r.status, r.txHash, r.attesterId, r.label], ["succeeded", "00ab".repeat(16), "a1".repeat(32), "mandate"]);
  assert.deepEqual(calls[0], ["build_sponsorable_transaction", { contractAddress: "e7".repeat(32), call: "attest", params: { payloadHash: "cd".repeat(32), metadataHash: "ef".repeat(32) }, compiledArtifactRef: "attestation-vault-32", bind: false }]);
  assert.deepEqual(calls[1], ["sponsor_unbound_transaction", { txId: "tx-1", idempotencyKey: `flint-attest-${"cd".repeat(8)}` }]);
  assert.equal(log[0].kind, "attested");
  const v = await a.verify({ payloadHash: "cd".repeat(32) });
  assert.equal(v.verified, true);
  assert.equal(calls.at(-1)[1].attesterId, "a1".repeat(32), "the agent's own id when none is given");
  const failed = attester({ call, contractAddress: "e7".repeat(32), waitForJob: async () => ({ status: "failed", errorCode: "CHAIN_EXECUTION_FAILED" }), log: (e) => log.push(e) });
  const f = await failed.attest({ payloadHash: "cd".repeat(32), metadataHash: "ef".repeat(32), label: "window" });
  assert.deepEqual([f.status, f.error, log.at(-1).kind], ["failed", "CHAIN_EXECUTION_FAILED", "attest.failed"]);
});
