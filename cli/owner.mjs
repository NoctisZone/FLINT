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
 *   npm run owner -- create nova-7 [rules|claude] [x402] [deposit=850] [path=value ...]   # order a new agent: the mm-rule mandate shape, signed; the fee by x402 or by `pay`
 *   npm run owner -- pay nova-7                 # the order's payment (fee and deposit money), signed by this wallet from its own tADA
 *   npm run owner -- onboarding nova-7 | retry nova-7
 *   npm run owner -- key nova-7 | revoke-key nova-7   # a tools key for the agent (shown once), or none
 *   npm run owner -- withdraw nova-7 <usd|all> | withdrawals nova-7   # a payout to this wallet
 *
 * OWNER_URL is the /owner/ prefix (default http://localhost:4482/owner/). Paid calls (x402) are
 * settled from BUYER_MNEMONIC's wallet when it is set; `pay` spends this owner wallet's own tADA.
 */
import { cardanoWallet, koios, signData, signTransaction, utxoHex } from "../gateway/cardano.mjs";
import { paidFetch, receiptOf } from "../lib/paid-fetch.mjs";
import { canonical, mandateHash } from "../gateway/mandate.mjs";
import { profiles } from "../agents/profiles.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const seed = process.env.OWNER_SEED_HEX;
if (!cmd) { console.error("usage: owner address | whoami | agents | pause|resume|stop|close <agentId> | sign <agentId> [path=value ...] | create <name> [rules|claude] [x402] [deposit=ada] [path=value ...] | pay <name> | onboarding <name> | retry <name> | key <name> | revoke-key <name> | withdraw <name> <usd|all> | withdrawals <name>"); process.exit(2); }
if (!seed || !/^[0-9a-f]{64}$/i.test(seed)) { console.error("OWNER_SEED_HEX must be 32 bytes of hex"); process.exit(2); }
const wallet = cardanoWallet(seed, { stakeSeedHex: process.env.OWNER_STAKE_SEED_HEX });
if (cmd === "address") { console.log(wallet.address); process.exit(0); }

const base = (process.env.OWNER_URL || "http://localhost:4482/owner/").replace(/\/?$/, "/");
let token = null;
// a call that may cost: paid from the buyer wallet when there is one, else the 402 is the answer
const buyer = process.env.BUYER_MNEMONIC ? paidFetch({ mnemonic: process.env.BUYER_MNEMONIC, network: process.env.X402_NETWORK || "cardano:preprod", koiosUrl: process.env.KOIOS_URL || undefined }) : null;
async function call(path, method = "GET", body, { paid = false } = {}) {
  const f = paid && buyer ? buyer.fetch : fetch;
  const r = await f(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  const receipt = receiptOf(r);
  if (receipt?.transaction) console.error(`paid: tx ${receipt.transaction}`);
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error ?? r.status}${r.status === 402 ? ` (set BUYER_MNEMONIC to pay ${j.accepts?.[0]?.amount ?? "?"} lovelace to ${j.accepts?.[0]?.payTo ?? "?"})` : ""}`);
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
} else if (cmd === "sign" || cmd === "create") {
  const [agentId, ...sets] = rest;
  if (!agentId) { console.error(`${cmd} needs an agent id`); process.exit(2); }
  let m, mind = "rules", pay = "wallet", depositAda = 850;
  if (cmd === "sign") {
    const a = (await call("agents")).agents.find((x) => x.agentId === agentId);
    if (!a) { console.error(`${agentId} is not one of this owner's agents`); process.exit(1); }
    m = JSON.parse(JSON.stringify(a.mandate));
  } else {
    // a new agent starts from the rule maker's mandate, under this wallet, with the builder fee an outside maker pays
    if (sets[0] === "rules" || sets[0] === "claude") mind = sets.shift();
    if (sets[0] === "x402") { pay = sets.shift(); }
    if (/^deposit=/.test(sets[0] ?? "")) depositAda = Number(sets.shift().slice(8));
    m = { ...profiles({ owner: wallet.address, expiry: new Date(Date.now() + 3 * 86_400_000).toISOString() })["mm-rule"], agentId };
    m.strike = { ...m.strike, builderFeeBps: 5 };
  }
  for (const kv of sets) {
    const [path, raw] = kv.split("=");
    const keys = path.split("."); const last = keys.pop();
    const o = keys.reduce((x, k) => (x[k] ??= {}), m);
    o[last] = raw === "block" || raw === "freeze" || Number.isNaN(Number(raw)) ? raw : Number(raw);
  }
  if (Date.parse(m.expiry) - Date.now() < 86_400_000) m.expiry = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const hash = mandateHash(m);
  const r = cmd === "sign"
    ? await call(`agents/${agentId}/mandate`, "PUT", { mandate: m, signature: sign(hash) })
    : await call("agents", "POST", { name: agentId, mind, pay, depositAda, mandate: m, signature: sign(hash) }, { paid: pay === "x402" });
  console.log(JSON.stringify({ ...r, canonical: canonical(m).length + " bytes" }, null, 1));
} else if (cmd === "pay") {
  // the owner's one payment, signed by this wallet over its own UTxOs: the fee to the project, the deposit money to the agent's wallet
  const id = rest[0];
  if (!id) { console.error("pay needs an agent id"); process.exit(2); }
  const chain = koios({ baseUrl: process.env.KOIOS_URL || undefined });
  const b = await call(`agents/${id}/pay/build`, "POST", { utxos: (await chain.utxos(wallet.address)).map((u) => utxoHex(u, wallet.addressBytes)) });
  const r = await call(`agents/${id}/pay`, "POST", { signedTxCbor: signTransaction(b.unsignedTxCbor, wallet).cborHex });
  console.log(JSON.stringify({ paid: `${Number(b.total) / 1e6} tADA`, outputs: b.outputs.map((o) => `${Number(o.lovelace) / 1e6} tADA to ${o.to.slice(0, 20)}…`), ...r }, null, 1));
} else if (cmd === "withdraw" || cmd === "withdrawals") {
  if (!rest[0]) { console.error(`${cmd} needs an agent id`); process.exit(2); }
  console.log(JSON.stringify(cmd === "withdraw" ? await call(`agents/${rest[0]}/withdraw`, "POST", { usd: rest[1] === "all" ? "all" : Number(rest[1]) }) : await call(`agents/${rest[0]}/withdrawals`), null, 1));
} else if (cmd === "key" || cmd === "revoke-key") {
  if (!rest[0]) { console.error(`${cmd} needs an agent id`); process.exit(2); }
  console.log(JSON.stringify(cmd === "key" ? await call(`agents/${rest[0]}/key`, "POST", {}, { paid: true }) : await call(`agents/${rest[0]}/key`, "DELETE"), null, 1));
} else if (cmd === "onboarding" || cmd === "retry") {
  if (!rest[0]) { console.error(`${cmd} needs an agent id`); process.exit(2); }
  console.log(JSON.stringify(cmd === "retry" ? await call(`agents/${rest[0]}/onboarding/retry`, "POST", {}) : await call(`agents/${rest[0]}/onboarding`), null, 1));
} else { console.error(`unknown command ${cmd}`); process.exit(2); }
await call("session", "DELETE").catch(() => {});
