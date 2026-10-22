/**
 * The owner's side of the gateway: a wallet session from a CIP-30 signData
 * over a challenge, then pause, resume, stop, close and a newly signed
 * mandate for the agents whose mandate names that owner. Mounted on the
 * feed server under /owner/. No key of any kind passes through here.
 */
import crypto from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "@scure/base";
import { verifySignData } from "./cardano.mjs";
import { assertMandate, mandateHash } from "./mandate.mjs";

/** A Cardano address as text from its bytes; the network nibble picks the prefix. */
export const addressOf = (bytes) => bech32.encode((bytes[0] & 0x0f) === 1 ? "addr" : "addr_test", bech32.toWords(Uint8Array.from(bytes)), 200);

const addressBytes = (text) => Uint8Array.from(bech32.fromWords(bech32.decode(text, 200).words));

/**
 * @param {object} o
 * @param {Array<{agentId, mandate}>} o.agents
 * @param {{freeze, resume, stop, close, setMandate, stateOf}} o.gateway
 * @param {(agent, signature) => Promise<void>} [o.onMandate]   after a mandate is swapped in: persist, anchor
 */
export function ownerApi({ agents, gateway, onMandate = async () => {}, log = () => {}, now = Date.now, challengeTtlMs = 5 * 60_000, sessionTtlMs = 12 * 3600_000, random = () => crypto.randomBytes(16).toString("hex") }) {
  const challenges = new Map(); // nonce → { address, message, expires }
  const sessions = new Map();   // token → { address, expires }
  const owned = (address) => agents.filter((a) => a.mandate.owner === address);
  const agentOf = (address, id) => owned(address).find((a) => a.agentId === id) ?? null;

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

  const sweep = () => { const t = now(); for (const [k, c] of challenges) if (c.expires < t) challenges.delete(k); for (const [k, s] of sessions) if (s.expires < t) sessions.delete(k); };

  const api = {
    challenge({ address, addressHex }) {
      sweep();
      let text = address;
      if (!text && addressHex) {
        if (!/^(?:[0-9a-f]{2}){29,128}$/i.test(String(addressHex))) return { status: 400, body: { error: "addressHex unreadable" } };
        text = addressOf(Buffer.from(String(addressHex), "hex"));
      }
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
      log({ kind: "owner.session", address: c.address, agents: owned(c.address).map((a) => a.agentId) });
      return { status: 200, body: { token, address: c.address, agents: owned(c.address).map((a) => a.agentId), expiresAt: new Date(expires).toISOString() } };
    },
    whoami(s) { return { status: 200, body: { address: s.address, agents: owned(s.address).map((a) => a.agentId) } }; },
    logout(token) { sessions.delete(token); return { status: 200, body: { ok: true } }; },
    agentsOf(s) { return { status: 200, body: { agents: owned(s.address).map((a) => ({ agentId: a.agentId, mandate: a.mandate, hash: mandateHash(a.mandate), stopped: Boolean(a.stopped), ...gateway.stateOf(a.agentId) })) } }; },
    async act(s, id, what, body) {
      const a = agentOf(s.address, id);
      if (!a) return { status: 404, body: { error: "not one of your agents" } };
      if (what === "pause") { gateway.freeze(id, "paused by the owner", { manual: true }); log({ kind: "owner.pause", agent: id }); return { status: 200, body: { ok: true, status: "paused" } }; }
      if (what === "resume") {
        if (a.stopped) return { status: 409, body: { error: "stopped: sign its mandate again to restart it" } };
        gateway.resume(id); log({ kind: "owner.resume", agent: id }); return { status: 200, body: { ok: true, status: "quoting" } };
      }
      if (what === "stop") { const r = await gateway.stop(id, "stopped by the owner"); log({ kind: "owner.stop", agent: id, ...r }); return { status: 200, body: { ok: true, status: "stopped", ...r } }; }
      if (what === "close") { const r = await gateway.close(id, "closed by the owner"); log({ kind: "owner.close", agent: id }); return { status: 200, body: { ok: true, ...r } }; }
      if (what === "mandate") {
        const m = body?.mandate;
        try { assertMandate(m); } catch (err) { return { status: 400, body: { error: err.message } }; }
        if (m.agentId !== id) return { status: 400, body: { error: "mandate names another agent" } };
        if (m.owner !== s.address) return { status: 400, body: { error: "mandate names another owner" } };
        if (Date.parse(m.expiry) <= now()) return { status: 400, body: { error: "mandate already expired" } };
        const hash = mandateHash(m);
        const why = problem(body?.signature, hash, s.address);
        if (why) return { status: 401, body: { error: why } };
        gateway.setMandate(id, m);
        log({ kind: "owner.mandate", agent: id, hash });
        await onMandate(a, { signature: body.signature.signature, key: body.signature.key, hash });
        return { status: 200, body: { ok: true, hash } };
      }
      return { status: 404, body: { error: "unknown action" } };
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
      if (path === "session" && req.method === "POST") return send(res, api.session(body)), true;
      const s = sessionOf(req);
      if (!s) return send(res, { status: 401, body: { error: "no session" } }), true;
      if (path === "session" && req.method === "GET") return send(res, api.whoami(s)), true;
      if (path === "session" && req.method === "DELETE") return send(res, api.logout(s.token)), true;
      if (path === "agents" && req.method === "GET") return send(res, api.agentsOf(s)), true;
      const m = /^agents\/([a-z0-9-]+)\/(pause|resume|stop|close|mandate)$/.exec(path);
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
