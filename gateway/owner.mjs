/**
 * The owner's side of the gateway: a wallet session from a CIP-30 signData
 * over a challenge, then pause, resume, stop, unwind, close and a newly
 * signed mandate for the agents whose mandate names that owner, a new agent
 * from a signed mandate (its onboarding job runs on the gateway), payouts,
 * further deposits and a fresh Strike key. Mounted on the feed server under
 * /owner/. No key of any kind passes through here.
 */
import crypto from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "@scure/base";
import { verifySignData } from "./cardano.mjs";
import { assertMandate, mandateHash } from "./mandate.mjs";
import { assertMarkets } from "./markets.mjs";

/** A Cardano address as text from its bytes; the gateway lives on preprod, so a mainnet address (network nibble 1) is refused. */
export const addressOf = (bytes) => {
  if ((bytes[0] & 0x0f) !== 0) throw Object.assign(new Error("a mainnet address: switch the wallet to Cardano preprod"), { status: 400 });
  return bech32.encode("addr_test", bech32.toWords(Uint8Array.from(bytes)), 200);
};

const addressBytes = (text) => Uint8Array.from(bech32.fromWords(bech32.decode(text, 200).words));

/**
 * @param {object} o
 * @param {Array<{agentId, mandate}>} o.agents
 * @param {{freeze, resume, stop, unwind?, close, setMandate, stateOf}} o.gateway
 * @param {(agent, signature) => Promise<void>} [o.onMandate]   after a mandate is swapped in: persist, anchor
 * @param {{ create: (spec) => Promise<object>, get: (agentId) => object|null, retry: (agentId) => Promise<object>, cancel?: (agentId) => Promise<object> }} [o.onboarding]
 *   a new agent from the page: `create` starts its onboarding job and answers the job's view (`{ agentId, index, owner, status, steps }`),
 *   `get` reads it, `retry` runs it again from the failed step; without it, POST agents answers 501
 * @param {{ issue, revoke, info }} [o.keys]      the agents' tools keys (agent-keys.mjs)
 * @param {{ charge: (req, res, { description, amount, extra }) => Promise<{ paid: boolean, payment? }>, prices: { onboard: string, key: string } }} [o.x402]
 *   paid calls: `charge` answers the 402 itself and resolves `paid: false` when the caller stops; prices in lovelace, "0" = free
 * @param {{ load: () => Array<[string, object]>, save: (entries: Array<[string, object]>) => void }} [o.sessionStore]
 *   where sessions outlive a restart; without it they live in memory
 * @param {{ feeAda: number, feeClaudeAda: number, keyAda: number, minDepositAda: number, minTopUpAda?: number, payTo: string, marketsOff?: string[] }} [o.pricing]
 *   what an order costs: the set-up fee by mind, a tools key, the smallest deposit and top-up, where the fee goes
 * @param {{ build, submit }} [o.payments]   the owner's payment of an order (onboard.mjs orderPayments)
 * @param {{ start: (agentId, usd) => Promise<object>, list: (agentId) => object[], retry?: (agentId) => object, room?: (agentId) => Promise<object> }} [o.withdrawals]
 *   payouts to the owner; `room` is what Strike lets go right now (withdraw.mjs withdrawRoom)
 * @param {{ start: (agentId, lovelace) => Promise<object>, build, submit, list: (agentId) => object[], retry: (agentId) => object }} [o.deposits]
 *   a further deposit into a running agent: a transfer from the owner's wallet, then the agent's deposit at Strike
 * @param {{ info: (agentId) => object|null, rotate: (agentId) => Promise<object> }} [o.strikeKeys]   the agents' Strike API wallets
 */
export function ownerApi({ agents, gateway, onMandate = async () => {}, onboarding = null, keys = null, x402 = null, sessionStore = null, pricing = null, payments = null, withdrawals = null, deposits = null, strikeKeys = null, nameTaken = () => false, log = () => {}, now = Date.now, challengeTtlMs = 5 * 60_000, sessionTtlMs = 12 * 3600_000, random = () => crypto.randomBytes(16).toString("hex") }) {
  const challenges = new Map(); // nonce → { address, message, expires }
  const sessions = new Map(sessionStore?.load() ?? []);   // token → { address, expires }
  const persist = () => { try { sessionStore?.save([...sessions]); } catch (err) { log({ kind: "owner.sessions.save.failed", error: err.message.slice(0, 120) }); } };
  const owned = (address) => agents.filter((a) => a.mandate.owner === address);
  const agentOf = (address, id) => owned(address).find((a) => a.agentId === id) ?? null;
  // an agent still being set up is the owner's too, for its tools key
  const ownsId = (address, id) => Boolean(agentOf(address, id)) || onboarding?.get(id)?.owner === address;
  const priced = (what) => Boolean(x402) && Number(x402.prices?.[what] ?? 0) > 0;
  const lovelace = (ada) => BigInt(Math.round(Number(ada) * 1e6));
  const feeOf = (mind) => lovelace(mind === "claude" ? pricing?.feeClaudeAda ?? 0 : pricing?.feeAda ?? 0);
  const trouble = (err) => ({ status: err.status ?? 500, body: { error: String(err.message ?? err).slice(0, 200) } });
  const notYours = { status: 404, body: { error: "not one of your agents" } };

  /** The signature over `payload` (UTF-8) by the key the address names; a reason when it is not. */
  function problem(signature, payload, address) {
    let v;
    try { v = verifySignData(String(signature?.signature ?? ""), String(signature?.key ?? "")); } catch { return "signature unreadable"; }
    if (!v.ok) return "signature does not verify";
    if (Buffer.from(v.payload).toString("utf8") !== payload) return "signature is over something else";
    let want;
    try { want = addressBytes(address); } catch { return "address unreadable"; }
    const keyHash = Buffer.from(blake2b(Buffer.from(v.publicKeyHex, "hex"), { dkLen: 28 })).toString("hex");
    if (Buffer.from(want.subarray(1, 29)).toString("hex") !== keyHash) return "the key is not the address's payment key";
    if (!v.addressBytes || addressOf(v.addressBytes) !== address) return "the signature names another address";
    return null;
  }

  const sweep = () => { const t = now(); for (const [k, c] of challenges) if (c.expires < t) challenges.delete(k); let gone = 0; for (const [k, s] of sessions) if (s.expires < t) { sessions.delete(k); gone++; } if (gone) persist(); };

  const api = {
    challenge({ address, addressHex }) {
      sweep();
      let text = address;
      if (!text && addressHex) {
        if (!/^(?:[0-9a-f]{2}){29,128}$/i.test(String(addressHex))) return { status: 400, body: { error: "addressHex unreadable" } };
        try { text = addressOf(Buffer.from(String(addressHex), "hex")); } catch (err) { return { status: 400, body: { error: err.message } }; }
      }
      if (typeof text === "string" && text.startsWith("addr1")) return { status: 400, body: { error: "a mainnet address: switch the wallet to Cardano preprod" } };
      try { if (addressBytes(String(text)).length < 29) throw new Error("short"); } catch { return { status: 400, body: { error: "address unreadable" } }; }
      const nonce = random();
      const expires = now() + challengeTtlMs;
      const message = `flint owner ${text} ${nonce} ${new Date(expires).toISOString()}`;
      challenges.set(nonce, { address: text, message, expires });
      return { status: 200, body: { address: text, nonce, message, expiresAt: new Date(expires).toISOString() } };
    },
    session({ nonce, signature }) {
      sweep();
      const c = challenges.get(String(nonce ?? ""));
      if (!c) return { status: 400, body: { error: "no such challenge, or it expired" } };
      const why = problem(signature, c.message, c.address);
      if (why) return { status: 401, body: { error: why } };
      challenges.delete(nonce);
      const token = random() + random();
      const expires = now() + sessionTtlMs;
      sessions.set(token, { address: c.address, expires });
      persist();
      log({ kind: "owner.session", address: c.address, agents: owned(c.address).map((a) => a.agentId) });
      return { status: 200, body: { token, address: c.address, agents: owned(c.address).map((a) => a.agentId), expiresAt: new Date(expires).toISOString() } };
    },
    whoami(s) { return { status: 200, body: { address: s.address, agents: owned(s.address).map((a) => a.agentId) } }; },
    logout(token) { sessions.delete(token); persist(); return { status: 200, body: { ok: true } }; },
    agentsOf(s) { return { status: 200, body: { agents: owned(s.address).map((a) => ({ agentId: a.agentId, mandate: a.mandate, hash: mandateHash(a.mandate), stopped: Boolean(a.stopped), unwinding: Boolean(a.unwinding), toolsKey: keys?.info(a.agentId) ?? null, strikeKey: strikeKeys?.info(a.agentId) ?? null, ...gateway.stateOf(a.agentId) })) } }; },
    async act(s, id, what, body) {
      const a = agentOf(s.address, id);
      if (!a) return notYours;
      if (what === "pause") { gateway.freeze(id, "paused by the owner", { manual: true }); log({ kind: "owner.pause", agent: id }); return { status: 200, body: { ok: true, status: "paused" } }; }
      if (what === "resume") {
        if (a.stopped) return { status: 409, body: { error: "stopped: sign its mandate again to restart it" } };
        gateway.resume(id); log({ kind: "owner.resume", agent: id }); return { status: 200, body: { ok: true, status: "quoting" } };
      }
      if (what === "stop") { const r = await gateway.stop(id, "stopped by the owner"); log({ kind: "owner.stop", agent: id, ...r }); return { status: 200, body: { ok: true, status: "stopped", ...r } }; }
      if (what === "unwind") {
        if (!gateway.unwind) return { status: 501, body: { error: "unwinding is off on this gateway" } };
        const r = await gateway.unwind(id, "unwound by the owner");
        log({ kind: "owner.unwind", agent: id, ...r });
        return { status: 200, body: { ok: true, status: "unwinding", ...r } };
      }
      if (what === "close") { const r = await gateway.close(id, "closed by the owner"); log({ kind: "owner.close", agent: id }); return { status: 200, body: { ok: true, ...r } }; }
      if (what === "mandate") {
        const m = body?.mandate;
        try { assertMandate(m); } catch (err) { return { status: 400, body: { error: err.message } }; }
        if (m.agentId !== id) return { status: 400, body: { error: "mandate names another agent" } };
        if (m.owner !== s.address) return { status: 400, body: { error: "mandate names another owner" } };
        if (Date.parse(m.expiry) <= now()) return { status: 400, body: { error: "mandate already expired" } };
        // a market maker keeps its markets: its wallet holds those markets' coins
        if (a.mandate.strike.markets.length && (m.strike.markets.join() !== a.mandate.strike.markets.join() || m.midnight.pairs.join() !== a.mandate.midnight.pairs.join())) return { status: 400, body: { error: "the markets cannot change; order a new agent for other markets" } };
        const hash = mandateHash(m);
        const why = problem(body?.signature, hash, s.address);
        if (why) return { status: 401, body: { error: why } };
        gateway.setMandate(id, m);
        log({ kind: "owner.mandate", agent: id, mandateHash: hash });
        await onMandate(a, { signature: body.signature.signature, key: body.signature.key, hash });
        return { status: 200, body: { ok: true, hash } };
      }
      return { status: 404, body: { error: "unknown action" } };
    },
    /** Everything about a new agent checked before anything is paid or started: the spec, or `{ error }` to send. */
    check(s, body) {
      if (!onboarding) return { error: { status: 501, body: { error: "new agents from the page are off on this gateway" } } };
      const name = String(body?.name ?? "");
      if (!/^[a-z0-9-]{3,14}$/.test(name)) return { error: { status: 400, body: { error: "name: 3 to 14 lowercase letters, digits or dashes" } } };
      if (agents.some((a) => a.agentId === name) || onboarding.get(name) || nameTaken(name)) return { error: { status: 409, body: { error: `${name} is taken` } } };
      const mind = body?.mind ?? "rules";
      if (mind !== "rules" && mind !== "claude") return { error: { status: 400, body: { error: "mind is rules or claude" } } };
      const pay = body?.pay ?? "wallet";
      if (pay !== "wallet" && pay !== "x402") return { error: { status: 400, body: { error: "pay is wallet or x402" } } };
      if (pay === "x402" && !x402) return { error: { status: 400, body: { error: "paying by x402 is off on this gateway" } } };
      const depositAda = Number(body?.depositAda);
      if (!pricing) return { error: { status: 501, body: { error: "orders are off on this gateway" } } };
      if (!Number.isFinite(depositAda) || depositAda < pricing.minDepositAda) return { error: { status: 400, body: { error: `depositAda: at least ${pricing.minDepositAda} tADA` } } };
      const m = body?.mandate;
      try { assertMandate(m); } catch (err) { return { error: { status: 400, body: { error: err.message } } }; }
      if (m.agentId !== name) return { error: { status: 400, body: { error: "mandate names another agent" } } };
      if (m.owner !== s.address) return { error: { status: 400, body: { error: "mandate names another owner" } } };
      if (Date.parse(m.expiry) <= now()) return { error: { status: 400, body: { error: "mandate already expired" } } };
      try { assertMarkets(m); } catch (err) { return { error: { status: 400, body: { error: err.message } } }; }
      const off = m.strike.markets.find((x) => (pricing.marketsOff ?? []).includes(x));
      if (off) return { error: { status: 400, body: { error: `${off} is not open for new agents on this network yet` } } };
      const hash = mandateHash(m);
      const why = problem(body?.signature, hash, s.address);
      if (why) return { error: { status: 401, body: { error: why } } };
      return { name, mind, pay, depositLovelace: lovelace(depositAda), feeLovelace: feeOf(mind), toolsKey: body?.toolsKey !== false, mandate: m, hash, signature: { signature: body.signature.signature, key: body.signature.key } };
    },
    /** What an order costs, for the page before anything is signed. */
    prices() { return { status: pricing ? 200 : 501, body: pricing ? { ...pricing, payTo: pricing.payTo, x402: Boolean(x402) } : { error: "orders are off on this gateway" } }; },
    /** A new agent: its name, its mind, who funds it, the mandate the session's wallet signed; the onboarding job starts. `payment` is the x402 receipt when it paid. */
    async create(s, body, payment = null) {
      const c = api.check(s, body);
      if (c.error) return c.error;
      let job;
      try { job = await onboarding.create({ agentId: c.name, mind: c.mind, pay: c.pay, depositLovelace: c.depositLovelace, feeLovelace: c.feeLovelace, toolsKey: c.toolsKey, owner: s.address, mandate: c.mandate, signature: c.signature, hash: c.hash, payment }); }
      catch (err) { return trouble(err); }
      log({ kind: "owner.create", agent: c.name, mind: c.mind, pay: c.pay, depositLovelace: String(c.depositLovelace), feeLovelace: String(c.feeLovelace), mandateHash: c.hash, index: job.index, ...(payment ? { txHash: payment.txHash, lovelace: String(payment.amountUnits) } : {}) });
      return { status: 201, body: { agentId: c.name, index: job.index, hash: c.hash, job } };
    },
    /** A tools key for one of the session's agents, shown once; the key before it stops working. `payment` is the x402 receipt when priced. */
    issueKey(s, id, payment = null) {
      if (!keys) return { status: 501, body: { error: "tools keys are off on this gateway" } };
      if (!ownsId(s.address, id)) return notYours;
      const k = keys.issue(id);
      log({ kind: "owner.key", agent: id, prefix: k.prefix, ...(payment ? { txHash: payment.txHash, lovelace: String(payment.amountUnits) } : {}) });
      return { status: 201, body: { agentId: id, key: k.key, prefix: k.prefix, issuedAt: k.issuedAt } };
    },
    revokeKey(s, id) {
      if (!keys) return { status: 501, body: { error: "tools keys are off on this gateway" } };
      if (!ownsId(s.address, id)) return notYours;
      const had = keys.revoke(id);
      log({ kind: "owner.key.revoked", agent: id });
      return { status: 200, body: { ok: true, agentId: id, hadKey: had } };
    },
    /** A fresh Strike API wallet for one of the session's agents: builder connect again, the running agent swapped onto it. */
    async rotateStrikeKey(s, id) {
      if (!strikeKeys?.rotate) return { status: 501, body: { error: "Strike key rotation is off on this gateway" } };
      if (!agentOf(s.address, id)) return notYours;
      try { const r = await strikeKeys.rotate(id); log({ kind: "owner.strike.rotated", agent: id, accountId: r.accountId, publicKey: r.publicKey }); return { status: 200, body: { ok: true, agentId: id, ...r } }; } catch (err) { return trouble(err); }
    },
    /** The owner's one payment of an order (fee and deposit money), built for their wallet and handed back signed. */
    async payment(s, id, what, body) {
      if (!payments) return { status: 501, body: { error: "orders are off on this gateway" } };
      if (!ownsId(s.address, id)) return { status: 404, body: { error: "no order of yours under that name" } };
      try {
        if (what === "pay/build") return { status: 200, body: await payments.build(id, body) };
        if (what === "pay") { const r = await payments.submit(id, body); log({ kind: "owner.paid", agent: id, txHash: r.txHash }); return { status: 200, body: r }; }
      } catch (err) { return trouble(err); }
      return { status: 404, body: { error: "unknown payment" } };
    },
    /** A payout: `usd` off the agent's Strike balance, or "all", on its way to the owner's wallet. */
    async withdraw(s, id, body) {
      if (!withdrawals) return { status: 501, body: { error: "payouts are off on this gateway" } };
      const a = agentOf(s.address, id);
      if (!a) return notYours;
      const usd = body?.usd === "all" ? "all" : Number(body?.usd);
      if (usd !== "all" && !(Number.isFinite(usd) && usd > 0)) return { status: 400, body: { error: "usd: a number above 0, or \"all\"" } };
      try { const job = await withdrawals.start(id, usd); log({ kind: "owner.withdraw", agent: id, usd }); return { status: 201, body: { job } }; } catch (err) { return trouble(err); }
    },
    /** The agent's payouts, newest first, and what Strike lets go right now (`room`, null when Strike did not answer). */
    async withdrawalsOf(s, id) {
      if (!withdrawals) return { status: 501, body: { error: "payouts are off on this gateway" } };
      if (!agentOf(s.address, id)) return notYours;
      const room = withdrawals.room ? await withdrawals.room(id).catch((err) => { log({ kind: "owner.withdraw.room.failed", agent: id, error: err.message.slice(0, 120) }); return null; }) : null;
      return { status: 200, body: { withdrawals: withdrawals.list(id), room } };
    },
    /** The newest payout again from the step that failed. */
    retryWithdrawal(s, id) {
      if (!withdrawals?.retry) return { status: 501, body: { error: "payouts are off on this gateway" } };
      if (!agentOf(s.address, id)) return notYours;
      try { const job = withdrawals.retry(id); log({ kind: "owner.withdraw.retry", agent: id }); return { status: 200, body: { job } }; } catch (err) { return trouble(err); }
    },
    /** A further deposit: `ada` from the owner's wallet to the agent's, which puts it on Strike; the job then waits for the owner's transaction. */
    async deposit(s, id, body) {
      if (!deposits) return { status: 501, body: { error: "deposits are off on this gateway" } };
      if (!agentOf(s.address, id)) return notYours;
      const ada = Number(body?.ada);
      const min = pricing?.minTopUpAda ?? 1;
      if (!Number.isFinite(ada) || ada < min) return { status: 400, body: { error: `ada: at least ${min} tADA` } };
      try { const job = await deposits.start(id, lovelace(ada)); log({ kind: "owner.deposit", agent: id, lovelace: String(lovelace(ada)) }); return { status: 201, body: { job } }; } catch (err) { return trouble(err); }
    },
    /** The deposit's transfer, built for the owner's wallet and handed back signed, as for an order. */
    async depositPayment(s, id, what, body) {
      if (!deposits) return { status: 501, body: { error: "deposits are off on this gateway" } };
      if (!agentOf(s.address, id)) return notYours;
      try {
        if (what === "deposit/build") return { status: 200, body: await deposits.build(id, body) };
        if (what === "deposit/pay") { const r = await deposits.submit(id, body); log({ kind: "owner.deposit.paid", agent: id, txHash: r.txHash }); return { status: 200, body: r }; }
      } catch (err) { return trouble(err); }
      return { status: 404, body: { error: "unknown payment" } };
    },
    depositsOf(s, id) {
      if (!deposits) return { status: 501, body: { error: "deposits are off on this gateway" } };
      if (!agentOf(s.address, id)) return notYours;
      return { status: 200, body: { deposits: deposits.list(id) } };
    },
    retryDeposit(s, id) {
      if (!deposits) return { status: 501, body: { error: "deposits are off on this gateway" } };
      if (!agentOf(s.address, id)) return notYours;
      try { const job = deposits.retry(id); log({ kind: "owner.deposit.retry", agent: id }); return { status: 200, body: { job } }; } catch (err) { return trouble(err); }
    },
    /** The onboarding job of one of the session's agents, started or not yet in the loop; `retry` runs it again, `cancel` takes an unpaid order back. */
    onboarding(s, id, retry = false, cancel = false) {
      if (!onboarding) return { status: 501, body: { error: "new agents from the page are off on this gateway" } };
      const job = onboarding.get(id);
      if (!job || job.owner !== s.address) return { status: 404, body: { error: "no onboarding of yours under that name" } };
      if (cancel) {
        if (!onboarding.cancel) return { status: 501, body: { error: "cancelling orders is off on this gateway" } };
        if (job.steps.find((x) => x.step === "pay")?.status === "done") return { status: 409, body: { error: "the order is paid; it cannot be cancelled" } };
        return Promise.resolve(onboarding.cancel(id)).then((j) => { log({ kind: "owner.onboarding.cancel", agent: id }); return { status: 200, body: { job: j } }; }).catch((err) => ({ status: err.status ?? 500, body: { error: err.message.slice(0, 200) } }));
      }
      if (!retry) return { status: 200, body: { job } };
      return Promise.resolve(onboarding.retry(id)).then((j) => { log({ kind: "owner.onboarding.retry", agent: id }); return { status: 200, body: { job: j } }; }).catch((err) => ({ status: err.status ?? 500, body: { error: err.message.slice(0, 200) } }));
    },
  };

  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" };
  const send = (res, { status, body }) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...CORS }); res.end(JSON.stringify(body)); };
  const readJson = async (req) => { let raw = ""; for await (const c of req) { raw += c; if (raw.length > 65_536) throw new Error("body too large"); } return raw ? JSON.parse(raw) : {}; };
  const sessionOf = (req) => { const m = /^Bearer ([0-9a-f]{32,128})$/.exec(req.headers.authorization ?? ""); const s = m && sessions.get(m[1]); return s && s.expires >= now() ? { ...s, token: m[1] } : null; };

  /** The http handler: true when the request was one of ours. */
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/owner/")) return false;
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return true; }
    let body = {};
    try { if (req.method === "POST" || req.method === "PUT") body = await readJson(req); } catch (err) { send(res, { status: 400, body: { error: err.message } }); return true; }
    const path = url.pathname.slice("/owner/".length);
    try {
      if (path === "challenge" && req.method === "POST") return send(res, api.challenge(body)), true;
      if (path === "prices" && req.method === "GET") return send(res, api.prices()), true;
      if (path === "session" && req.method === "POST") return send(res, api.session(body)), true;
      const s = sessionOf(req);
      if (!s) return send(res, { status: 401, body: { error: "no session" } }), true;
      if (path === "session" && req.method === "GET") return send(res, api.whoami(s)), true;
      if (path === "session" && req.method === "DELETE") return send(res, api.logout(s.token)), true;
      if (path === "agents" && req.method === "GET") return send(res, api.agentsOf(s)), true;
      if (path === "agents" && req.method === "POST") {
        const c = api.check(s, body);
        if (c.error) return send(res, c.error), true;
        let payment = null;
        // x402: the set-up fee paid with the order, checked before anything else so a refused spec costs nothing
        if (c.pay === "x402" && c.feeLovelace > 0n) { const paid = await x402.charge(req, res, { description: `set-up fee for agent ${c.name}`, amount: String(c.feeLovelace), extra: { agent: c.name, what: "onboard" } }); if (!paid.paid) return true; payment = paid.payment; }
        return send(res, await api.create(s, body, payment)), true;
      }
      const k = /^agents\/([a-z0-9-]+)\/key$/.exec(path);
      if (k && req.method === "DELETE") return send(res, api.revokeKey(s, k[1])), true;
      if (k && req.method === "POST") {
        if (!keys || !ownsId(s.address, k[1])) return send(res, api.issueKey(s, k[1])), true;
        let payment = null;
        if (priced("key")) { const paid = await x402.charge(req, res, { description: `a tools key for agent ${k[1]}`, amount: x402.prices.key, extra: { agent: k[1], what: "key" } }); if (!paid.paid) return true; payment = paid.payment; }
        return send(res, api.issueKey(s, k[1], payment)), true;
      }
      const sk = /^agents\/([a-z0-9-]+)\/strike-key\/rotate$/.exec(path);
      if (sk && req.method === "POST") return send(res, await api.rotateStrikeKey(s, sk[1])), true;
      const pm = /^agents\/([a-z0-9-]+)\/(pay\/build|pay)$/.exec(path);
      if (pm && req.method === "POST") return send(res, await api.payment(s, pm[1], pm[2], body)), true;
      const wd = /^agents\/([a-z0-9-]+)\/(withdraw|withdrawals|withdrawals\/retry)$/.exec(path);
      if (wd && wd[2] === "withdraw" && req.method === "POST") return send(res, await api.withdraw(s, wd[1], body)), true;
      if (wd && wd[2] === "withdrawals" && req.method === "GET") return send(res, await api.withdrawalsOf(s, wd[1])), true;
      if (wd && wd[2] === "withdrawals/retry" && req.method === "POST") return send(res, api.retryWithdrawal(s, wd[1])), true;
      const dp = /^agents\/([a-z0-9-]+)\/(deposit|deposit\/build|deposit\/pay|deposits|deposits\/retry)$/.exec(path);
      if (dp && dp[2] === "deposit" && req.method === "POST") return send(res, await api.deposit(s, dp[1], body)), true;
      if (dp && (dp[2] === "deposit/build" || dp[2] === "deposit/pay") && req.method === "POST") return send(res, await api.depositPayment(s, dp[1], dp[2], body)), true;
      if (dp && dp[2] === "deposits" && req.method === "GET") return send(res, api.depositsOf(s, dp[1])), true;
      if (dp && dp[2] === "deposits/retry" && req.method === "POST") return send(res, api.retryDeposit(s, dp[1])), true;
      const o = /^agents\/([a-z0-9-]+)\/onboarding(\/retry|\/cancel)?$/.exec(path);
      if (o && ((!o[2] && req.method === "GET") || (o[2] && req.method === "POST"))) return send(res, await api.onboarding(s, o[1], o[2] === "/retry", o[2] === "/cancel")), true;
      const m = /^agents\/([a-z0-9-]+)\/(pause|resume|stop|unwind|close|mandate)$/.exec(path);
      if (m && ((m[2] === "mandate" && req.method === "PUT") || (m[2] !== "mandate" && req.method === "POST"))) return send(res, await api.act(s, m[1], m[2], body)), true;
      send(res, { status: 404, body: { error: "not found" } });
    } catch (err) {
      log({ kind: "owner.error", error: err.message.slice(0, 200) });
      send(res, { status: 500, body: { error: err.message.slice(0, 200) } });
    }
    return true;
  }

  return { handle, api, sessions };
}
