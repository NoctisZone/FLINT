/**
 * One key per agent for its tools endpoint: the owner issues it (and pays
 * for it with x402 when the gateway prices it), the outside mind sends it
 * as a bearer token to /mcp/<agentId>. Only the hash is kept; the key is
 * shown once. An agent without a key keeps an open endpoint.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const KEYS_FILE = path.join("data", "agent-keys.json");
const hashOf = (key) => crypto.createHash("sha256").update(String(key), "utf8").digest("hex");

export function agentKeys(file = KEYS_FILE, { now = Date.now, random = () => crypto.randomBytes(24).toString("hex") } = {}) {
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
  const write = (all) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(all, null, 1), { mode: 0o600 }); };
  return {
    /** A fresh key for the agent; the one before it stops working. */
    issue(agentId) {
      const key = `flint_${random()}`;
      const all = read();
      all[agentId] = { hash: hashOf(key), prefix: key.slice(0, 12), issuedAt: new Date(now()).toISOString() };
      write(all);
      return { key, prefix: all[agentId].prefix, issuedAt: all[agentId].issuedAt };
    },
    revoke(agentId) { const all = read(); const had = Boolean(all[agentId]); delete all[agentId]; write(all); return had; },
    has: (agentId) => Boolean(read()[agentId]),
    /** What the owner may see of a key: its prefix and when it was issued; null without one. */
    info(agentId) { const k = read()[agentId]; return k ? { prefix: k.prefix, issuedAt: k.issuedAt } : null; },
    /** Does the request's bearer token open this agent's tools? An agent without a key is open. */
    authorize(agentId, authorizationHeader) {
      const k = read()[agentId];
      if (!k) return true;
      const m = /^Bearer (\S+)$/.exec(authorizationHeader ?? "");
      return Boolean(m) && hashOf(m[1]) === k.hash;
    },
  };
}
