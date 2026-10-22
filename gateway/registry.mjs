/**
 * The agents made from the page, so a restart brings them back: one entry
 * each in data/agents.json, their owner-signed mandate in data/mandates/.
 * The built-in agents stay on the command line and never appear here.
 */
import fs from "node:fs";
import path from "node:path";
import { verifySignData } from "./cardano.mjs";
import { mandateHash } from "./mandate.mjs";

export const REGISTRY_FILE = path.join("data", "agents.json");
export const MANDATE_DIR = path.join("data", "mandates");

/**
 * @typedef {object} RegistryEntry
 * @prop {string} agentId
 * @prop {number} index        the Midnight wallet index (trader-<index>)
 * @prop {"rules"|"claude"} mind
 * @prop {string|null} side    citizens only
 * @prop {string} owner        the Cardano address the mandate names
 * @prop {"treasury"|"owner"} [funding]   who paid the agent's tADA
 * @prop {string} mandateFile
 * @prop {string} createdAt
 * @prop {{ accountId: string|null }} strike
 */

export function registry(file = REGISTRY_FILE) {
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []);
  const write = (all) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(all, null, 1)); };
  return {
    list: read,
    get: (agentId) => read().find((e) => e.agentId === agentId) ?? null,
    /** A new agent; its id and wallet index must both be free. */
    add(entry) {
      const all = read();
      if (all.some((e) => e.agentId === entry.agentId)) throw new Error(`${entry.agentId} is already registered`);
      if (all.some((e) => e.index === entry.index)) throw new Error(`wallet index ${entry.index} is taken`);
      all.push(entry);
      write(all);
      return entry;
    },
    /** The first wallet index after the built-ins (`reserved`) and every registered agent. */
    nextIndex(reserved = []) {
      return Math.max(-1, ...reserved, ...read().map((e) => e.index)) + 1;
    },
  };
}

/** Where an agent's signed mandate lives. */
export const mandateFileOf = (agentId, dir = MANDATE_DIR) => path.join(dir, `${agentId}.json`);

/** Write a signed mandate next to the others: what the owner signed, the signature, when. */
export function saveSignedMandate(agentId, { mandate, signature, hash }, dir = MANDATE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const file = mandateFileOf(agentId, dir);
  fs.writeFileSync(file, JSON.stringify({ mandate, signature: { signature: signature.signature, key: signature.key }, hash, signedAt: new Date().toISOString() }, null, 1));
  return file;
}

/**
 * An agent's signed mandate from its file: `ok` when the signature is over
 * the mandate's hash, the mandate names `owner` and has not expired; else
 * `why`. Null when there is no file or it is unreadable.
 */
export function loadSignedMandate(agentId, { owner, dir = MANDATE_DIR, now = Date.now } = {}) {
  const file = mandateFileOf(agentId, dir);
  if (!fs.existsSync(file)) return null;
  let mandate, signature;
  try { ({ mandate, signature } = JSON.parse(fs.readFileSync(file, "utf8"))); } catch (err) { return { file, mandate: null, ok: false, why: err.message.slice(0, 100) }; }
  let why = null;
  try {
    const v = verifySignData(String(signature?.signature ?? ""), String(signature?.key ?? ""));
    if (!v.ok || Buffer.from(v.payload).toString("utf8") !== mandateHash(mandate)) why = "signature does not hold";
  } catch { why = "signature unreadable"; }
  if (!why && owner && mandate?.owner !== owner) why = "mandate names another owner";
  if (!why && !(Date.parse(mandate?.expiry) > now())) why = "mandate expired";
  return { file, mandate, ok: !why, why };
}
