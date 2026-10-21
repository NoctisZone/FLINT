/**
 * Deterministic trader identities from one master seed: trader i's Midnight
 * seed is HKDF-SHA512 over the master seed (data/master-seed), the derivation the agent
 * population of the simulation framework uses, so the same master seed names
 * the same wallets (and finds the coins minted to them).
 */
import crypto from "node:crypto";

const SALT = "agent-sim/identity/v1";

function hkdf(masterHex, info, length) {
  if (!/^[0-9a-f]{64}$/i.test(masterHex ?? "")) throw new Error("master seed must be 64 hex characters (32 bytes)");
  return Buffer.from(crypto.hkdfSync("sha512", Buffer.from(masterHex, "hex"), SALT, info, length));
}

/** 64-byte Midnight seed (128 hex, what @odatano/nightgate-tx expects) of trader `index`. */
export function midnightSeedOf(masterHex, index) {
  if (!Number.isInteger(index) || index < 0) throw new Error("trader index must be a non-negative integer");
  return hkdf(masterHex, `agent/${index}/midnight`, 64).toString("hex");
}

/** 32 bytes for one role of the market (issuer, builder), derived from the master seed; never stored. */
export const secretFor = (masterHex, ...label) =>
  Uint8Array.from(crypto.createHash("sha256").update([masterHex, "otc-live", ...label].join("|")).digest());
