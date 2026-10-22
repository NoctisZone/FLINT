/** The owner API: a session from a wallet signature over the challenge, then pause, stop, close and a newly signed mandate for the owner's agents only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ownerApi, addressOf } from "../gateway/owner.mjs";
import { cardanoWallet, signData } from "../gateway/cardano.mjs";
import { mandateHash } from "../gateway/mandate.mjs";
import { profiles } from "../agents/profiles.mjs";

const owner = cardanoWallet("11".repeat(32), { stakeSeedHex: "22".repeat(32) });
const stranger = cardanoWallet("33".repeat(32));
const T0 = Date.parse("2026-10-22T12:00:00Z");

function world() {
  const P = profiles({ owner: owner.address, expiry: "2026-10-30T00:00:00Z" });
  const other = profiles({ owner: stranger.address, expiry: "2026-10-30T00:00:00Z" })["mm-claude"];
  const agents = [{ agentId: "mm-rule", mandate: P["mm-rule"] }, { agentId: "mm-claude", mandate: other }];
  const calls = [];
  const gateway = {
    freeze: (id, reason, opts) => calls.push(["freeze", id, reason, opts]),
    resume: (id) => calls.push(["resume", id]),
    stop: async (id) => { calls.push(["stop", id]); agents.find((a) => a.agentId === id).stopped = true; return { quotes: 2, strike: 1 }; },
    close: async (id) => { calls.push(["close", id]); return { closed: 0.001 }; },
    setMandate: (id, m) => { calls.push(["mandate", id, mandateHash(m)]); const a = agents.find((x) => x.agentId === id); a.mandate = m; a.stopped = false; },
    stateOf: () => ({ frozen: false }),
  };
  const anchored = [];
  let t = T0;
  const o = ownerApi({ agents, gateway, onMandate: async (a, sig) => { anchored.push([a.agentId, sig.hash]); }, now: () => t, random: (() => { let n = 0; return () => (++n).toString(16).padStart(32, "0"); })() });
  return { agents, calls, anchored, o, tick: (ms) => { t += ms; } };
}

const sign = (w, text) => { const s = signData(w, Buffer.from(text, "utf8")); return { signature: s.signature, key: s.key }; };

test("a challenge is answered by signData over its message; the session lists the agents that name this owner", async () => {
  const { o } = world();
  const c = o.api.challenge({ addressHex: Buffer.from(owner.addressBytes).toString("hex") });
  assert.equal(c.status, 200);
  assert.equal(c.body.address, owner.address, "the hex address comes back as text");
  assert.match(c.body.message, new RegExp(`^flint owner ${owner.address} [0-9a-f]{32} 2026-10-22T12:05:00.000Z$`));
  const bad = o.api.session({ nonce: c.body.nonce, signature: sign(stranger, c.body.message) });
  assert.deepEqual([bad.status, bad.body.error], [401, "the key is not the address's payment key"]);
  const wrong = o.api.session({ nonce: c.body.nonce, signature: sign(owner, "something else") });
  assert.equal(wrong.body.error, "signature is over something else");
  const s = o.api.session({ nonce: c.body.nonce, signature: sign(owner, c.body.message) });
  assert.deepEqual([s.status, s.body.address, s.body.agents], [200, owner.address, ["mm-rule"]]);
  assert.equal(o.api.session({ nonce: c.body.nonce, signature: sign(owner, c.body.message) }).status, 400, "a challenge answers once");
  assert.equal(addressOf(owner.addressBytes), owner.address);
});

test("a challenge expires; an unreadable address is refused", () => {
  const { o, tick } = world();
  const c = o.api.challenge({ address: owner.address });
  tick(6 * 60_000);
  assert.equal(o.api.session({ nonce: c.body.nonce, signature: sign(owner, c.body.message) }).status, 400);
  assert.equal(o.api.challenge({ address: "addr_test1nonsense" }).status, 400);
  assert.equal(o.api.challenge({ addressHex: "zz" }).status, 400);
});

test("over http: pause, resume, stop, close and a signed mandate for the owner's agent; another owner's agent is not found; no session is 401", async () => {
  const { o, calls, anchored, agents } = world();
  const server = http.createServer((req, res) => { o.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/owner/`;
  const call = async (path, method, body, token) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  const c = await call("challenge", "POST", { address: owner.address });
  const s = await call("session", "POST", { nonce: c.body.nonce, signature: sign(owner, c.body.message) });
  const token = s.body.token;
  assert.equal((await call("session", "GET", null, token)).body.address, owner.address);
  assert.equal((await call("agents", "GET")).status, 401);
  assert.equal((await call("agents/mm-rule/pause", "POST", {}, token)).body.status, "paused");
  assert.deepEqual(calls.at(-1), ["freeze", "mm-rule", "paused by the owner", { manual: true }]);
  assert.equal((await call("agents/mm-rule/resume", "POST", {}, token)).body.status, "quoting");
  assert.equal((await call("agents/mm-claude/pause", "POST", {}, token)).status, 404, "not this owner's agent");
  assert.equal((await call("agents/mm-rule/close", "POST", {}, token)).body.closed, 0.001);
  const st = await call("agents/mm-rule/stop", "POST", {}, token);
  assert.deepEqual([st.body.status, st.body.quotes], ["stopped", 2]);
  assert.equal((await call("agents/mm-rule/resume", "POST", {}, token)).status, 409, "a stopped agent needs a new mandate");
  const m = { ...agents[0].mandate, risk: { ...agents[0].mandate.risk, maxNetDeltaUsd: 99 } };
  const hash = mandateHash(m);
  assert.equal((await call("agents/mm-rule/mandate", "PUT", { mandate: m, signature: sign(owner, "not the hash") }, token)).status, 401);
  assert.equal((await call("agents/mm-rule/mandate", "PUT", { mandate: { ...m, owner: stranger.address }, signature: sign(owner, hash) }, token)).status, 400);
  const ok = await call("agents/mm-rule/mandate", "PUT", { mandate: m, signature: sign(owner, hash) }, token);
  assert.deepEqual([ok.status, ok.body.hash], [200, hash]);
  assert.deepEqual(calls.at(-1), ["mandate", "mm-rule", hash]);
  assert.deepEqual(anchored, [["mm-rule", hash]]);
  assert.equal(agents[0].mandate.risk.maxNetDeltaUsd, 99);
  assert.equal((await call("agents", "GET", null, token)).body.agents[0].stopped, false);
  assert.equal((await call("session", "DELETE", null, token)).body.ok, true);
  assert.equal((await call("agents", "GET", null, token)).status, 401);
  const pre = await fetch(base + "agents", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  server.close();
});
