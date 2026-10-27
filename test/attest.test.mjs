/** Attestations against a stand-in MCP server: the envelope, the build-sponsor-wait chain, the verify call. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { attester, badgeClaims, badgeDocument, mandateEnvelope, sha256, windowEnvelope } from "../gateway/attest.mjs";
import { profiles } from "../agents/profiles.mjs";

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

test("attest builds under the agent's id, hands the txId to the sponsor, takes the job's outcome from it; verify asks live state", async () => {
  const calls = [];
  let outcome = { status: "succeeded", jobId: "job-1", txHash: "00ab".repeat(16) };
  const call = async (tool, args) => {
    calls.push([tool, args]);
    if (tool === "get_attester_identity") return { attesterId: "a1".repeat(32), network: "preprod" };
    if (tool === "build_sponsorable_transaction") return { txId: "tx-1", attesterId: "a1".repeat(32), bytes: 1234 };
    if (tool === "sponsor_unbound_transaction") return outcome;
    if (tool === "verify_attestation") return { verified: true, recordKey: "rk".repeat(32), attesterId: args.attesterId, payloadHash: args.payloadHash };
    throw new Error(`unexpected ${tool}`);
  };
  const log = [];
  const a = attester({ call, contractAddress: "e7".repeat(32), log: (e) => log.push(e), now: () => 1000 });
  const r = await a.attest({ payloadHash: "cd".repeat(32), metadataHash: "ef".repeat(32), label: "mandate" });
  assert.deepEqual([r.status, r.txHash, r.attesterId, r.label], ["succeeded", "00ab".repeat(16), "a1".repeat(32), "mandate"]);
  assert.deepEqual(calls[0], ["build_sponsorable_transaction", { contractAddress: "e7".repeat(32), call: "attest", params: { payloadHash: "cd".repeat(32), metadataHash: "ef".repeat(32) }, compiledArtifactRef: "attestation-vault-32", bind: false }]);
  assert.deepEqual(calls[1], ["sponsor_unbound_transaction", { txId: "tx-1", idempotencyKey: `flint-attest-${"cd".repeat(8)}` }]);
  assert.equal(log[0].kind, "attested");
  const v = await a.verify({ payloadHash: "cd".repeat(32) });
  assert.equal(v.verified, true);
  assert.equal(calls.at(-1)[1].attesterId, "a1".repeat(32), "the agent's own id when none is given");
  outcome = { status: "failed", jobId: "job-2", errorCode: "CHAIN_EXECUTION_FAILED" };
  const failed = attester({ call, contractAddress: "e7".repeat(32), log: (e) => log.push(e) });
  const f = await failed.attest({ payloadHash: "cd".repeat(32), metadataHash: "ef".repeat(32), label: "window" });
  assert.deepEqual([f.status, f.error, log.at(-1).kind], ["failed", "CHAIN_EXECUTION_FAILED", "attest.failed"]);
});

test("badges: the claims document is prepared, attested and rooted; a true claim is proven and verified, a false one earns nothing and costs no transaction", async () => {
  const M = profiles({ owner: "o", expiry: "2026-10-23T15:00:00Z" })["mm-rule"];
  const claims = { violations: 1, maxNetDeltaUsd: 118.25, maxFillToHedgeSec: 10, venuesOutsideMandate: 0 };
  const { document, proofFields } = badgeDocument({ agentId: "mm-rule", mandateHash: "ab".repeat(32), runStart: "2026-10-22T06:00:00Z", asOf: "2026-10-22T07:00:00Z", claims, counts: { midnightFills: 3 } });
  assert.deepEqual(proofFields.map((f) => f.field), ["claims.violations", "claims.maxNetDeltaUsd", "claims.maxFillToHedgeSec", "claims.venuesOutsideMandate"]);
  assert.deepEqual(badgeClaims(M).map((c) => [c.badge, c.scaledThreshold]), [["no-violations", "0"], ["delta-held", "15000"], ["hedged-in-time", "30"], ["allowed-venues", "0"]]);
  const key = (i) => String(i).repeat(64).slice(0, 64);
  const fields = proofFields.map((f, i) => ({ field: f.field, fieldKey: key(i + 1), salt: key(5 + i), siblings: [key(7), key(8), key(9), key(7), key(8)], dirs: [true, false, true, true, true], kind: "uint", value: String(Math.round(document.claims[f.field.split(".")[1]] * f.scale)) }));
  const calls = [];
  const call = async (tool, args) => {
    calls.push([tool, args]);
    if (tool === "get_attester_identity") return { attesterId: "a1".repeat(32) };
    if (tool === "prepare_document_proof") return { payloadHash: "dd".repeat(32), contentRoot: "cc".repeat(32), schemaId: "ee".repeat(32), canonicalDocument: "{}", fields: JSON.stringify(fields), schema: "[]", opening: JSON.stringify({ saltSeed: key(3), slots: [] }) };
    if (tool === "build_sponsorable_transaction") return { txId: `tx-${calls.length}`, attesterId: "a1".repeat(32) };
    if (tool === "sponsor_unbound_transaction") return { jobId: `job-${calls.length}`, status: "succeeded", txHash: "00ab".repeat(16) };
    if (tool === "verify_predicate") return { verified: true };
    throw new Error(`unexpected ${tool}`);
  };
  const log = [];
  const a = attester({ call, contractAddress: "e7".repeat(32), log: (e) => log.push(e), now: () => 1000 });
  const b = await a.badges({ agentId: "mm-rule", mandate: M, mandateHash: "ab".repeat(32), runStart: "2026-10-22T06:00:00Z", asOf: "2026-10-22T07:00:00Z", claims, counts: { midnightFills: 3 } });
  assert.deepEqual([b.payloadHash, b.contentRoot, b.anchor.status, b.root.status], ["dd".repeat(32), "cc".repeat(32), "succeeded", "succeeded"]);
  assert.deepEqual(b.claims.map((c) => [c.badge, c.status, c.earned, c.verified]), [["no-violations", "false", false, false], ["delta-held", "succeeded", true, true], ["hedged-in-time", "succeeded", true, true], ["allowed-venues", "succeeded", true, true]]);
  assert.deepEqual(b.earned, ["delta-held", "hedged-in-time", "allowed-venues"]);
  const builds = calls.filter(([t]) => t === "build_sponsorable_transaction").map(([, x]) => x);
  assert.deepEqual(builds.map((x) => x.call), ["attest", "anchorContentRoot", "proveFieldPredicate", "proveFieldPredicate", "proveFieldPredicate"], "one false claim: no transaction for it");
  assert.deepEqual(builds[1].params, { payloadHash: "dd".repeat(32), contentRoot: "cc".repeat(32), schemaId: "ee".repeat(32) });
  assert.deepEqual(builds[2].params, { payloadHash: "dd".repeat(32), fieldKey: key(2), threshold: "15000", op: 0 });
  assert.deepEqual(builds[2].merkleProof, { fieldValue: "11825", fieldSalt: key(6), siblings: fields[1].siblings, dirs: fields[1].dirs });
  assert.equal(builds[2].compiledArtifactRef, "attestation-vault-32");
  const verify = calls.find(([t]) => t === "verify_predicate")[1];
  assert.deepEqual([verify.predicate, verify.threshold, verify.fieldKey, verify.attesterId], ["lessOrEqual", "15000", key(2), "a1".repeat(32)]);
  assert.ok(b.witness.opening.saltSeed, "the opening stays with the file, never on the feed");
});

test("a rate-limited sponsor is retried after the time it names, a pending job is asked for again; a different error is not", async () => {
  let n = 0;
  const waits = [];
  const call = async (tool) => {
    if (tool === "get_attester_identity") return { attesterId: "a1".repeat(32) };
    if (tool === "build_sponsorable_transaction") return { txId: "tx", attesterId: "a1".repeat(32) };
    if (tool === "sponsor_unbound_transaction") { n += 1; if (n < 3) throw new Error("Rate limited (sponsor: 60 per hour). Retry after 15s"); return n === 3 ? { status: "pending", jobId: "j" } : { status: "succeeded", jobId: "j", txHash: "00".repeat(32) }; }
    throw new Error(`unexpected ${tool}`);
  };
  const a = attester({ call, contractAddress: "e7".repeat(32), sleep: async (ms) => { waits.push(ms); }, now: () => 0 });
  const r = await a.attest({ payloadHash: "cd".repeat(32), metadataHash: "ef".repeat(32), label: "window" });
  assert.deepEqual([r.status, n, waits], ["succeeded", 4, [17_000, 17_000, 5_000]], "two waits the sponsor named, one short one after pending");
  const other = attester({ call: async (tool) => { if (tool === "build_sponsorable_transaction") return { txId: "tx" }; throw new Error("no dust backing free"); }, contractAddress: "e7".repeat(32), sleep: async () => {} });
  await assert.rejects(() => other.attest({ payloadHash: "cd".repeat(32), metadataHash: "ef".repeat(32), label: "window" }), /no dust backing/);
});

