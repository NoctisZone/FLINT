/**
 * Attestations on Midnight through an agent's own NIGHTGATE MCP server: the
 * agent builds and proves the vault call under its own attester id, the
 * sponsor pays and submits, and anyone can check the record against live
 * contract state. What goes on chain is a payload hash; the envelope it
 * hashes is kept as a file so a third party can re-hash it.
 *
 * Two payloads: the mandate anchor (payloadHash = the mandate hash) once per
 * agent, and a window attestation every so often over the Strike marks,
 * the decisions and the fills of that window, bound to the mandate.
 */
import crypto from "node:crypto";
import { canonical } from "./mandate.mjs";

export const sha256 = (s) => crypto.createHash("sha256").update(typeof s === "string" ? s : canonical(s), "utf8").digest("hex");

/** The window envelope: everything hashed, nothing private; `payloadHash` is what the chain holds. */
export function windowEnvelope({ agentId, policyHash, from, to, marks = [], decisions = [], fills = [], hedges = [], refusals = [], capitalTrailHash = null }) {
  const envelope = {
    v: 1, agentId, policyHash, window: { from, to },
    inputs: { marks: marks.length, marksHash: sha256(marks) },
    outputs: { decisions: decisions.length, decisionsHash: sha256(decisions), fills: fills.length, fillsHash: sha256(fills), hedges: hedges.length, hedgesHash: sha256(hedges), refusals: refusals.length, refusalsHash: sha256(refusals) },
    ...(capitalTrailHash ? { capitalTrailHash } : {}),
  };
  return { envelope, payloadHash: sha256(envelope), metadataHash: sha256({ agentId, kind: "window", from, to }) };
}

export function mandateEnvelope({ agentId, mandateHash }) {
  return { payloadHash: mandateHash, metadataHash: sha256({ agentId, kind: "mandate" }) };
}

/**
 * @param {object} o
 * @param {(tool: string, args: object) => Promise<any>} o.call   the agent's MCP server (trader.call)
 * @param {string} o.contractAddress                               the AttestationVault
 * @param {string} [o.artifact]                                    vault lineage
 * @param {(jobId: string, sessionId?: string) => Promise<object>} o.waitForJob
 */
export function attester({ call, contractAddress, artifact = "attestation-vault-32", waitForJob, log = () => {}, now = Date.now }) {
  let identity = null;
  return {
    async identity() {
      if (!identity) identity = await call("get_attester_identity", {});
      return identity;
    },
    /** Build, prove, sponsor, wait: resolves with the job's outcome and the attester id. */
    async attest({ payloadHash, metadataHash, label }) {
      const t0 = now();
      const built = await call("build_sponsorable_transaction", { contractAddress, call: "attest", params: { payloadHash, metadataHash }, compiledArtifactRef: artifact, bind: false });
      const provingMs = now() - t0;
      const sub = await call("sponsor_unbound_transaction", { txId: built.txId, idempotencyKey: `flint-attest-${payloadHash.slice(0, 16)}` });
      const job = await waitForJob(sub.jobId, sub.sessionId);
      const attesterId = built.attesterId ?? (await this.identity()).attesterId;
      const out = { label, payloadHash, metadataHash, attesterId, txHash: job?.txHash ?? null, status: job?.status ?? "unknown", error: job?.errorMessage ?? job?.errorCode ?? null, jobId: sub.jobId, provingMs, at: new Date(now()).toISOString(), contractAddress, artifact };
      log({ kind: out.status === "succeeded" ? "attested" : "attest.failed", ...out });
      return out;
    },
    /** Live contract state: does the attester's record of the payload stand? */
    async verify({ payloadHash, attesterId }) {
      const r = await call("verify_attestation", { contractAddress, compiledArtifactRef: artifact, payloadHash, attesterId: attesterId ?? (await this.identity()).attesterId });
      return { verified: r?.verified === true, recordKey: r?.recordKey ?? null, raw: r };
    },
  };
}
