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
 *
 * The badges: the reconciler's four claims go into one document whose
 * fields are Merkle leaves; each badge is a zero-knowledge proof that a
 * field is at most the mandate's limit, verifiable by anyone with the
 * attester id and the payload hash, without seeing the numbers.
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

/** The badge document: the reconciler's claims and counts, the four claim fields as provable leaves (USD in cents). */
export function badgeDocument({ agentId, mandateHash, runStart, asOf, claims, counts }) {
  const document = { v: 1, kind: "flint-badges", agentId, mandateHash, runStart, asOf, claims, counts };
  const proofFields = [
    { field: "claims.violations", scale: 1 },
    { field: "claims.maxNetDeltaUsd", scale: 100 },
    { field: "claims.maxFillToHedgeSec", scale: 1 },
    { field: "claims.venuesOutsideMandate", scale: 1 },
  ];
  return { document, proofFields };
}

/** The four badges as "field at most limit" claims against the mandate; thresholds scaled like the leaves. */
export function badgeClaims(mandate) {
  return [
    { badge: "no-violations", field: "claims.violations", threshold: 0, scale: 1 },
    { badge: "delta-held", field: "claims.maxNetDeltaUsd", threshold: mandate.risk.maxNetDeltaUsd, scale: 100 },
    { badge: "hedged-in-time", field: "claims.maxFillToHedgeSec", threshold: mandate.risk.hedgeWithinSec, scale: 1 },
    { badge: "allowed-venues", field: "claims.venuesOutsideMandate", threshold: 0, scale: 1 },
  ].map((c) => ({ ...c, scaledThreshold: String(Math.round(c.threshold * c.scale)) }));
}

const parsed = (x) => (typeof x === "string" ? JSON.parse(x) : x);

/**
 * @param {object} o
 * @param {(tool: string, args: object) => Promise<any>} o.call   the agent's MCP server (trader.call)
 * @param {string} o.contractAddress                               the AttestationVault
 * @param {string} [o.artifact]                                    vault lineage
 * @param {(jobId: string, sessionId?: string) => Promise<object>} o.waitForJob
 */
export function attester({ call, contractAddress, artifact = "attestation-vault-32", waitForJob, log = () => {}, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let identity = null;
  // the sponsor allows 60 transactions an hour and says how long to wait; a few waits are better than a lost proof
  async function sponsor(args, tries = 4) {
    for (let i = 1; ; i++) {
      try { return await call("sponsor_unbound_transaction", args); } catch (err) {
        const m = /Retry after (\d+)\s*s/i.exec(err.message ?? "");
        if (!m || i >= tries) throw err;
        await sleep((Number(m[1]) + 2) * 1000);
      }
    }
  }
  return {
    async identity() {
      if (!identity) identity = await call("get_attester_identity", {});
      return identity;
    },
    /** Build, prove, sponsor, wait: resolves with the job's outcome and the attester id. */
    async attest({ payloadHash, metadataHash, label }) {
      return this.sponsored({ circuit: "attest", params: { payloadHash, metadataHash }, label, key: `flint-attest-${payloadHash.slice(0, 16)}`, out: { payloadHash, metadataHash } });
    },
    /** One vault call built and proven on the agent's server, paid by the sponsor, waited for. */
    async sponsored({ circuit, params, merkleProof, label, key, out = {} }) {
      const t0 = now();
      const built = await call("build_sponsorable_transaction", { contractAddress, call: circuit, params, ...(merkleProof ? { merkleProof } : {}), compiledArtifactRef: artifact, bind: false });
      const provingMs = now() - t0;
      const sub = await sponsor({ txId: built.txId, idempotencyKey: key });
      const job = await waitForJob(sub.jobId, sub.sessionId);
      const attesterId = built.attesterId ?? (await this.identity()).attesterId;
      const result = { label, ...out, attesterId, txHash: job?.txHash ?? null, status: job?.status ?? "unknown", error: job?.errorMessage ?? job?.errorCode ?? null, jobId: sub.jobId, provingMs, at: new Date(now()).toISOString(), contractAddress, artifact };
      log({ kind: result.status === "succeeded" ? "attested" : "attest.failed", ...result });
      return result;
    },
    /** The document's leaves, root and witness material; compute-only on the agent's server. */
    async prepare({ document, proofFields }) {
      const r = await call("prepare_document_proof", { document, proofFields, compiledArtifactRef: artifact });
      return { payloadHash: r.payloadHash, contentRoot: r.contentRoot, schemaId: r.schemaId, canonicalDocument: r.canonicalDocument, fields: parsed(r.fields), schema: parsed(r.schema), opening: parsed(r.opening) };
    },
    /**
     * The four badges for one reconciler report: the document attested, its
     * root anchored, one proof per claim. A claim that is false fails at
     * proving and earns nothing; the others still go on chain.
     */
    async badges({ agentId, mandate, mandateHash, runStart, asOf, claims, counts }) {
      const { document, proofFields } = badgeDocument({ agentId, mandateHash, runStart, asOf, claims, counts });
      const prep = await this.prepare({ document, proofFields });
      const { payloadHash, contentRoot, schemaId } = prep;
      const anchor = await this.attest({ payloadHash, metadataHash: sha256({ agentId, kind: "badges", asOf }), label: "badges" });
      const root = anchor.status === "succeeded"
        ? await this.sponsored({ circuit: "anchorContentRoot", params: { payloadHash, contentRoot, schemaId }, label: "badges.root", key: `flint-root-${payloadHash.slice(0, 16)}`, out: { payloadHash, contentRoot } })
        : { status: "skipped", txHash: null };
      const results = [];
      for (const c of badgeClaims(mandate)) {
        const leaf = prep.fields.find((f) => f.field === c.field);
        const base = { badge: c.badge, field: c.field, predicate: "lessOrEqual", threshold: c.threshold, scaledThreshold: c.scaledThreshold, fieldKey: leaf?.fieldKey ?? null, value: claims[c.field.split(".")[1]] };
        if (!leaf || root.status !== "succeeded") { results.push({ ...base, status: "skipped", txHash: null, verified: false, earned: false }); continue; }
        if (Number(leaf.value) > Number(c.scaledThreshold)) { results.push({ ...base, status: "false", txHash: null, verified: false, earned: false }); continue; }
        let r;
        try {
          r = await this.sponsored({
            circuit: "proveFieldPredicate", params: { payloadHash, fieldKey: leaf.fieldKey, threshold: c.scaledThreshold, op: 0 },
            merkleProof: { fieldValue: leaf.value, fieldSalt: leaf.salt, siblings: leaf.siblings, dirs: leaf.dirs },
            label: `badge.${c.badge}`, key: `flint-badge-${payloadHash.slice(0, 12)}-${c.badge}`, out: { payloadHash, fieldKey: leaf.fieldKey, threshold: c.scaledThreshold },
          });
        } catch (err) { r = { status: "failed", txHash: null, error: err.message }; log({ kind: "attest.failed", label: `badge.${c.badge}`, payloadHash, error: err.message }); }
        const v = r.status === "succeeded" ? await this.verifyPredicate({ payloadHash, fieldKey: leaf.fieldKey, threshold: c.scaledThreshold }).catch((err) => ({ verified: false, error: err.message })) : { verified: false };
        results.push({ ...base, status: r.status, txHash: r.txHash, error: r.error ?? null, verified: v.verified, earned: r.status === "succeeded" });
      }
      const attesterId = anchor.attesterId ?? (await this.identity()).attesterId;
      return {
        at: new Date(now()).toISOString(), agentId, attesterId, vault: contractAddress, artifact, payloadHash, contentRoot, schemaId, asOf, runStart,
        anchor: { txHash: anchor.txHash, status: anchor.status }, root: { txHash: root.txHash, status: root.status },
        claims: results, earned: results.filter((r) => r.earned).map((r) => r.badge),
        document, witness: { opening: prep.opening, fields: prep.fields, schema: prep.schema },
      };
    },
    /** Live contract state: does a "field at most threshold" claim stand under this attester's record? */
    async verifyPredicate({ payloadHash, fieldKey, threshold, attesterId }) {
      const r = await call("verify_predicate", { contractAddress, compiledArtifactRef: artifact, attesterId: attesterId ?? (await this.identity()).attesterId, payloadHash, predicate: "lessOrEqual", fieldKey, threshold: String(threshold) });
      return { verified: r?.verified === true, raw: r };
    },
    /** Live contract state: does the attester's record of the payload stand? */
    async verify({ payloadHash, attesterId }) {
      const r = await call("verify_attestation", { contractAddress, compiledArtifactRef: artifact, payloadHash, attesterId: attesterId ?? (await this.identity()).attesterId });
      return { verified: r?.verified === true, recordKey: r?.recordKey ?? null, raw: r };
    },
  };
}
