#!/usr/bin/env node
/**
 * The owner's console by hand, with a headless owner key: the same calls
 * the page makes with a browser wallet. The key is an Ed25519 seed in
 * OWNER_SEED_HEX; its address is what the agents' mandates name as owner.
 *
 *   npm run owner -- address
 *   npm run owner -- whoami
 *   npm run owner -- agents
 *   npm run owner -- pause mm-rule | resume mm-rule | stop mm-rule | close mm-rule
 *   npm run owner -- sign mm-rule risk.maxNetDeltaUsd=120 midnight.maxQuoteUsd=140
 *
 * OWNER_URL is the /owner/ prefix (default http://localhost:4482/owner/).
 */
import { cardanoWallet, signData } from "../gateway/cardano.mjs";
import { canonical, mandateHash } from "../gateway/mandate.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const seed = process.env.OWNER_SEED_HEX;
if (!cmd) { console.error("usage: owner address | whoami | agents | pause|resume|stop|close <agentId> | sign <agentId> [path=value ...]"); process.exit(2); }
if (!seed || !/^[0-9a-f]{64}$/i.test(seed)) { console.error("OWNER_SEED_HEX must be 32 bytes of hex"); process.exit(2); }
const wallet = cardanoWallet(seed, { stakeSeedHex: process.env.OWNER_STAKE_SEED_HEX });
if (cmd === "address") { console.log(wallet.address); process.exit(0); }

const base = (process.env.OWNER_URL || "http://localhost:4482/owner/").replace(/\/?$/, "/");
let token = null;
async function call(path, method = "GET", body) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error ?? r.status}`);
  return j;
}
const sign = (text) => { const s = signData(wallet, Buffer.from(text, "utf8")); return { signature: s.signature, key: s.key }; };

// a refused call is one line, not a stack
process.on("unhandledRejection", (err) => { console.error(err.message ?? String(err)); process.exit(1); });
const ch = await call("challenge", "POST", { address: wallet.address });
const s = await call("session", "POST", { nonce: ch.nonce, signature: sign(ch.message) });
token = s.token;

if (cmd === "whoami") console.log(JSON.stringify({ address: s.address, agents: s.agents }, null, 1));
else if (cmd === "agents") console.log(JSON.stringify(await call("agents"), null, 1));
else if (["pause", "resume", "stop", "close"].includes(cmd)) {
  if (!rest[0]) { console.error(`${cmd} needs an agent id`); process.exit(2); }
  console.log(JSON.stringify(await call(`agents/${rest[0]}/${cmd}`, "POST", {}), null, 1));
} else if (cmd === "sign") {
  const [agentId, ...sets] = rest;
  if (!agentId) { console.error("sign needs an agent id"); process.exit(2); }
  const a = (await call("agents")).agents.find((x) => x.agentId === agentId);
  if (!a) { console.error(`${agentId} is not one of this owner's agents`); process.exit(1); }
  const m = JSON.parse(JSON.stringify(a.mandate));
  for (const kv of sets) {
    const [path, raw] = kv.split("=");
    const keys = path.split("."); const last = keys.pop();
    const o = keys.reduce((x, k) => (x[k] ??= {}), m);
    o[last] = raw === "block" || raw === "freeze" || Number.isNaN(Number(raw)) ? raw : Number(raw);
  }
  if (Date.parse(m.expiry) - Date.now() < 86_400_000) m.expiry = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const hash = mandateHash(m);
  const r = await call(`agents/${agentId}/mandate`, "PUT", { mandate: m, signature: sign(hash) });
  console.log(JSON.stringify({ ...r, canonical: canonical(m).length + " bytes" }, null, 1));
} else { console.error(`unknown command ${cmd}`); process.exit(2); }
await call("session", "DELETE").catch(() => {});
