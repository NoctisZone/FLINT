/**
 * The owner-signed mandate: its shape, its canonical form and its hash. The
 * hash is what the owner signs and what every attestation carries as
 * `policyHash`. Sizes are in USD, spreads and fees in basis points.
 */
import crypto from "node:crypto";

const num = (min, max = Infinity) => (v) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const str = (v) => typeof v === "string" && v.length > 0;
const list = (v) => Array.isArray(v) && v.every(str);

/** Field → check; a mandate must pass every one. */
const SHAPE = {
  owner: str, agentId: str,
  "strike.markets": list, "strike.maxLeverage": num(1, 150), "strike.maxPositionUsd": num(0), "strike.priceBandPct": num(0, 5), "strike.builderFeeBps": num(0, 100),
  "midnight.pairs": list, "midnight.maxQuoteUsd": num(0), "midnight.minSpreadBps": num(0), "midnight.maxSpreadBps": num(0), "midnight.quoteTtlSec": num(1), "midnight.maxOpenQuotes": num(0),
  "risk.maxNetDeltaUsd": num(0), "risk.hedgeWithinSec": num(1), "risk.dailyLossStopPct": num(0, 100), "risk.maxActionsPerMin": num(1),
  expiry: (v) => str(v) && !Number.isNaN(Date.parse(v)),
  onBreach: (v) => v === "block" || v === "freeze",
};

const get = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);

/** The fields that fail, empty when the mandate is well formed. */
export function mandateProblems(m) {
  if (!m || typeof m !== "object") return ["not an object"];
  const out = Object.entries(SHAPE).filter(([path, ok]) => !ok(get(m, path))).map(([path]) => path);
  if (m.midnight && m.midnight.minSpreadBps > m.midnight.maxSpreadBps) out.push("midnight.minSpreadBps > maxSpreadBps");
  return out;
}

export function assertMandate(m) {
  const p = mandateProblems(m);
  if (p.length) throw new Error(`mandate invalid: ${p.join(", ")}`);
  return m;
}

/** JSON with keys sorted at every level and no whitespace: the same mandate always hashes the same. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

export const mandateHash = (m) => crypto.createHash("sha256").update(canonical(m), "utf8").digest("hex");

/**
 * The owner's signature over the hash. `signature` is { key, signature }
 * with an Ed25519 public key and a signature over the UTF-8 hash string,
 * both hex: what a headless owner key produces. A CIP-30 wallet signature
 * is verified by a different `verify` passed to the checker.
 */
export function verifyOwnerSignature(hash, signature) {
  try {
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(signature.key, "hex")]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(hash, "utf8"), pub, Buffer.from(signature.signature, "hex"));
  } catch {
    return false;
  }
}

export function signAsOwner(hash, ownerKey) {
  return { key: ownerKey.publicKeyHex, signature: crypto.sign(null, Buffer.from(hash, "utf8"), ownerKey.key).toString("hex") };
}
