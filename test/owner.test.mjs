/** The owner API: a session from a wallet signature over the challenge, then pause, stop, close and a newly signed mandate for the owner's agents only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ownerApi, addressOf } from "../gateway/owner.mjs";
import { agentKeys } from "../gateway/agent-keys.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const PRICING = { feeAda: 20, feeClaudeAda: 40, keyAda: 0, minDepositAda: 500, payTo: cardanoWallet("44".repeat(32)).address };


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
  assert.equal((await call("agents", "POST", {}, token)).status, 501, "no onboarding wired: a new agent is not on offer");
  assert.equal((await call("session", "DELETE", null, token)).body.ok, true);
  assert.equal((await call("agents", "GET", null, token)).status, 401);
  const pre = await fetch(base + "agents", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  server.close();
});

test("a new agent: name, mind and a signed mandate start its onboarding job; the job is read and retried by its owner only", async () => {
  const { o: base_, calls, agents } = world();
  const jobs = new Map();
  const made = [];
  const onboarding = {
    create: async (spec) => { made.push(spec); const job = { agentId: spec.agentId, index: 5, owner: spec.owner, mind: spec.mind, status: "running", steps: [{ step: "wallet", status: "running" }] }; jobs.set(spec.agentId, job); return job; },
    get: (id) => jobs.get(id) ?? null,
    retry: async (id) => { const j = jobs.get(id); if (j.status !== "failed") throw Object.assign(new Error("nothing to retry"), { status: 409 }); j.status = "running"; return j; },
  };
  const o = ownerApi({ agents, gateway: { stateOf: () => ({}) }, onboarding, pricing: PRICING, now: () => T0, random: base_.api ? (() => { let n = 0; return () => (++n).toString(16).padStart(32, "0"); })() : undefined });
  const c = o.api.challenge({ address: owner.address });
  const s = o.api.session({ nonce: c.body.nonce, signature: sign(owner, c.body.message) });
  const S = { address: owner.address, token: s.body.token };
  const m = { ...agents[0].mandate, agentId: "nova-7", owner: owner.address };
  const hash = mandateHash(m);
  const D = { depositAda: 850 };
  assert.equal((await o.api.create(S, { name: "NOVA-7", mind: "rules", mandate: m, signature: sign(owner, hash), ...D })).body.error, "name: 3 to 14 lowercase letters, digits or dashes");
  assert.equal((await o.api.create(S, { name: "nova-7", mind: "rules", mandate: m, signature: sign(owner, hash), depositAda: 100 })).body.error, "depositAda: at least 500 tADA");
  assert.equal((await o.api.create(S, { name: "nova-7", mind: "rules", mandate: m, signature: sign(owner, hash), ...D, pay: "cash" })).body.error, "pay is wallet or x402");
  assert.equal((await o.api.create(S, { name: "nova-7", mind: "rules", mandate: m, signature: sign(owner, hash), ...D, pay: "x402" })).body.error, "paying by x402 is off on this gateway");
  assert.deepEqual(o.api.prices().body, { ...PRICING, x402: false });
  assert.equal((await o.api.create(S, { name: "mm-rule", mind: "rules", mandate: m, signature: sign(owner, hash), ...D })).status, 409, "a built-in's name");
  assert.equal((await o.api.create(S, { name: "nova-7", mind: "gpt", mandate: m, signature: sign(owner, hash), ...D })).body.error, "mind is rules or claude");
  assert.equal((await o.api.create(S, { name: "nova-7", mind: "rules", mandate: { ...m, agentId: "nova-8" }, signature: sign(owner, hash), ...D })).body.error, "mandate names another agent");
  assert.equal((await o.api.create(S, { name: "nova-7", mind: "rules", mandate: { ...m, owner: stranger.address }, signature: sign(owner, hash), ...D })).body.error, "mandate names another owner");
  assert.equal((await o.api.create(S, { name: "nova-7", mind: "rules", mandate: { ...m, risk: {} }, signature: sign(owner, hash), ...D })).status, 400, "a mandate missing fields");
  assert.equal((await o.api.create(S, { name: "nova-7", mind: "rules", mandate: m, signature: sign(stranger, hash), ...D })).status, 401);
  assert.equal((await o.api.create(S, { name: "nova-7", mind: "rules", mandate: m, signature: sign(owner, "not the hash"), ...D })).body.error, "signature is over something else");
  assert.deepEqual(made, [], "nothing started before every check passed");
  const r = await o.api.create(S, { name: "nova-7", mind: "claude", mandate: m, signature: sign(owner, hash), depositAda: 850, toolsKey: false });
  assert.deepEqual([r.status, r.body.agentId, r.body.index, r.body.hash, r.body.job.status], [201, "nova-7", 5, hash, "running"]);
  assert.deepEqual([made[0].agentId, made[0].mind, made[0].owner, made[0].hash, Object.keys(made[0].signature).sort(), made[0].pay, made[0].depositLovelace, made[0].feeLovelace, made[0].toolsKey], ["nova-7", "claude", owner.address, hash, ["key", "signature"], "wallet", 850_000_000n, 40_000_000n, false]);
  assert.equal((await o.api.create(S, { name: "nova-7", mind: "rules", mandate: m, signature: sign(owner, hash), ...D })).status, 409, "the name is taken by the job");
  assert.deepEqual((await o.api.onboarding(S, "nova-7")).body.job.steps[0], { step: "wallet", status: "running" });
  assert.equal((await o.api.onboarding({ address: stranger.address }, "nova-7")).status, 404, "another wallet's job is not found");
  assert.equal((await o.api.onboarding(S, "nova-7", true)).status, 409, "running: nothing to retry");
  jobs.get("nova-7").status = "failed";
  assert.equal((await o.api.onboarding(S, "nova-7", true)).body.job.status, "running");
  // over http
  const server = http.createServer((req, res) => { o.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/owner/`;
  const call = async (path, method, body) => { const r = await fetch(url + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${S.token}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  assert.equal((await call("agents/nova-7/onboarding", "GET")).body.job.agentId, "nova-7");
  jobs.get("nova-7").status = "failed";
  assert.equal((await call("agents/nova-7/onboarding/retry", "POST", {})).body.job.status, "running");
  assert.equal((await call("agents/nova-7/onboarding", "POST", {})).status, 404);
  const m2 = { ...m, agentId: "zed" };
  assert.equal((await call("agents", "POST", { name: "zed", mind: "rules", mandate: m2, signature: sign(owner, mandateHash(m2)), depositAda: 500 })).status, 201);
  assert.equal(calls.length, 0, "no gateway call for a new agent: the job does that");
  server.close();
});

test("paying by x402: a refused spec costs nothing, an unpaid call gets the 402, a paid one starts the job with the receipt; a tools key is issued, priced or free, and revoked", async () => {
  const { agents } = world();
  const jobs = new Map();
  const made = [];
  const onboarding = { create: async (spec) => { made.push(spec); const job = { agentId: spec.agentId, index: 6, owner: spec.owner, status: "running", steps: [] }; jobs.set(spec.agentId, job); return job; }, get: (id) => jobs.get(id) ?? null, retry: async () => {} };
  const keys = agentKeys(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flint-ok-")), "keys.json"));
  const charges = [];
  let pays = false;
  const x402 = { prices: { key: "5000000" }, charge: async (req, res, o) => { charges.push(o); if (!pays) { res.writeHead(402, { "content-type": "application/json" }); res.end(JSON.stringify({ x402Version: 2, accepts: [{ amount: o.amount, payTo: "addr_test1treasury" }] })); return { paid: false }; } return { paid: true, payment: { txHash: "ab".repeat(32), amountUnits: o.amount, payerAddr: "addr_test1buyer" } }; } };
  const o = ownerApi({ agents, gateway: { stateOf: () => ({}) }, onboarding, keys, x402, pricing: PRICING, now: () => T0 });
  const server = http.createServer((req, res) => { o.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/owner/`;
  const raw = async (path, method, body, token) => { const r = await fetch(url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    const c = await raw("challenge", "POST", { address: owner.address });
    const token = (await raw("session", "POST", { nonce: c.body.nonce, signature: sign(owner, c.body.message) })).body.token;
    const m = { ...agents[0].mandate, agentId: "zed-9", owner: owner.address };
    const hash = mandateHash(m);
    assert.equal((await raw("agents", "POST", { name: "zed-9", mind: "rules", pay: "x402", depositAda: 500, mandate: m, signature: sign(owner, "wrong") }, token)).status, 401);
    assert.deepEqual(charges, [], "nothing charged for a refused spec");
    const unpaid = await raw("agents", "POST", { name: "zed-9", mind: "rules", pay: "x402", depositAda: 500, mandate: m, signature: sign(owner, hash) }, token);
    assert.deepEqual([unpaid.status, unpaid.body.accepts[0].amount, charges.length, made.length], [402, "20000000", 1, 0], "the set-up fee is what x402 charges");
    assert.match(charges[0].description, /zed-9/);
    pays = true;
    const paid = await raw("agents", "POST", { name: "zed-9", mind: "rules", pay: "x402", depositAda: 500, mandate: m, signature: sign(owner, hash) }, token);
    assert.deepEqual([paid.status, paid.body.index, made[0].pay, made[0].payment.txHash, made[0].payment.payerAddr], [201, 6, "x402", "ab".repeat(32), "addr_test1buyer"]);
    const free = ownerApi({ agents, gateway: { stateOf: () => ({}) }, onboarding, keys, x402: { ...x402, prices: { key: "0" } }, pricing: PRICING, now: () => T0 });
    const S = { address: owner.address };
    assert.deepEqual(o.api.prices().body.x402, true);
    // tools keys: for an agent in the loop and for one still being set up; priced here
    pays = false;
    assert.equal((await raw("agents/mm-rule/key", "POST", {}, token)).status, 402);
    pays = true;
    const k1 = await raw("agents/mm-rule/key", "POST", {}, token);
    assert.deepEqual([k1.status, k1.body.agentId, k1.body.key.startsWith("flint_"), k1.body.prefix.length], [201, "mm-rule", true, 12]);
    assert.equal(keys.authorize("mm-rule", `Bearer ${k1.body.key}`), true);
    const k2 = await raw("agents/zed-9/key", "POST", {}, token);
    assert.equal(k2.status, 201, "the agent being set up is the owner's too");
    assert.equal((await raw("agents/mm-claude/key", "POST", {}, token)).status, 404, "another owner's agent");
    assert.equal((await raw("agents", "GET", null, token)).body.agents[0].toolsKey.prefix, k1.body.prefix);
    assert.equal(charges.filter((x) => x.extra?.what === "key").length, 3, "each key call is charged once");
    assert.deepEqual((await raw("agents/mm-rule/key", "DELETE", null, token)).body, { ok: true, agentId: "mm-rule", hadKey: true });
    assert.equal(keys.authorize("mm-rule", undefined), true, "revoked: open again");
    assert.equal(free.api.issueKey(S, "mm-rule").status, 201, "free keys need no payment");
  } finally { server.close(); }
});

test("sessions outlive a restart through the store: a token from before still opens, logout and expiry are written back", () => {
  let saved = [];
  const store = { load: () => saved, save: (entries) => { saved = entries; } };
  const { agents } = world();
  let t = T0;
  const o = ownerApi({ agents, gateway: { stateOf: () => ({}) }, sessionStore: store, now: () => t, random: (() => { let n = 0; return () => (++n).toString(16).padStart(32, "0"); })() });
  const c = o.api.challenge({ address: owner.address });
  const token = o.api.session({ nonce: c.body.nonce, signature: sign(owner, c.body.message) }).body.token;
  assert.deepEqual(saved.map(([k, v]) => [k === token, v.address]), [[true, owner.address]]);
  const again = ownerApi({ agents, gateway: { stateOf: () => ({}) }, sessionStore: store, now: () => t });
  assert.ok(again.sessions.get(token), "the restarted API knows the token");
  again.api.logout(token);
  assert.deepEqual(saved, []);
  const c2 = o.api.challenge({ address: owner.address });
  o.api.session({ nonce: c2.body.nonce, signature: sign(owner, c2.body.message) });
  t += 13 * 3600_000;
  o.api.challenge({ address: owner.address });
  assert.deepEqual(saved, [], "an expired session is swept from the store too");
});

test("the owner's payments and payouts: fee and deposit built and submitted through the API for the owner's order only; a payout started and listed for the owner's agent only", async () => {
  const { agents } = world();
  const jobs = new Map([["zed-9", { agentId: "zed-9", owner: owner.address, status: "running", steps: [] }]]);
  const onboarding = { create: async () => {}, get: (id) => jobs.get(id) ?? null, retry: async () => {} };
  const seen = [];
  const payments = {
    build: async (id, b) => { seen.push(["build", id, b]); return { unsignedTxCbor: "84a0", total: "525000000", outputs: [] }; },
    submit: async (id, b) => { seen.push(["submit", id, b]); if (!b.signedTxCbor && !b.witnessSetHex) throw Object.assign(new Error("send signedTxCbor, or unsignedTxCbor with witnessSetHex"), { status: 400 }); return { txHash: "cd".repeat(32) }; },
  };
  const payouts = [];
  const withdrawals = { start: async (id, usd) => { payouts.push([id, usd]); return { kind: "withdraw", agentId: id, status: "running", usd }; }, list: (id) => payouts.filter((p) => p[0] === id).map(([agentId, usd]) => ({ agentId, usd, status: "done" })) };
  const o = ownerApi({ agents, gateway: { stateOf: () => ({}) }, onboarding, pricing: PRICING, payments, withdrawals, now: () => T0 });
  const S = { address: owner.address };
  assert.deepEqual((await o.api.payment(S, "zed-9", "pay/build", {})).body, { unsignedTxCbor: "84a0", total: "525000000", outputs: [] });
  assert.equal((await o.api.payment(S, "zed-9", "pay", {})).status, 400);
  assert.equal((await o.api.payment(S, "zed-9", "pay", { signedTxCbor: "84a0" })).body.txHash, "cd".repeat(32));
  assert.equal((await o.api.payment(S, "zed-9", "pay", { unsignedTxCbor: "84a0", witnessSetHex: "a0" })).body.txHash, "cd".repeat(32));
  assert.equal((await o.api.payment({ address: stranger.address }, "zed-9", "pay/build", {})).status, 404, "another wallet's order");
  assert.equal((await o.api.payment(S, "ghost", "pay/build", {})).status, 404);
  assert.equal((await o.api.payment(S, "zed-9", "fee/build", {})).status, 404, "no such payment");
  assert.deepEqual(seen.map((x) => x[0]), ["build", "submit", "submit", "submit"]);
  assert.deepEqual((await o.api.withdraw(S, "mm-rule", { usd: 50 })).body.job.usd, 50);
  assert.deepEqual((await o.api.withdraw(S, "mm-rule", { usd: "all" })).body.job.usd, "all");
  assert.equal((await o.api.withdraw(S, "mm-rule", { usd: -1 })).status, 400);
  assert.equal((await o.api.withdraw(S, "mm-claude", { usd: 5 })).status, 404, "another owner's agent");
  assert.equal((await o.api.withdrawalsOf(S, "mm-rule")).body.withdrawals.length, 2);
  assert.equal((await o.api.withdrawalsOf(S, "zed-9")).status, 404, "a payout needs an agent in the loop");
  assert.equal((await o.api.withdrawalsOf(S, "mm-rule")).body.room, null, "no room reader wired: null");
  assert.equal(o.api.retryWithdrawal(S, "mm-rule").status, 501, "no retry wired");
  // over http
  const server = http.createServer((req, res) => { o.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/owner/`;
  try {
    const c = await (await fetch(url + "challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: owner.address }) })).json();
    const sess = await (await fetch(url + "session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: c.nonce, signature: sign(owner, c.message) }) })).json();
    const call = async (path, method, body) => { const r = await fetch(url + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${sess.token}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
    assert.equal((await fetch(url + "prices")).status, 200, "prices need no session");
    assert.equal((await call("agents/zed-9/pay/build", "POST", {})).body.total, "525000000");
    assert.equal((await call("agents/zed-9/pay", "POST", { signedTxCbor: "84a1" })).body.txHash, "cd".repeat(32));
    assert.equal((await call("agents/mm-rule/withdraw", "POST", { usd: 10 })).status, 201);
    assert.equal((await call("agents/mm-rule/withdrawals", "GET")).body.withdrawals.length, 3);
  } finally { server.close(); }
});

test("payout retry and room, further deposits, unwind and a rotated Strike key: for the owner's agents only, over the API and over http", async () => {
  const { agents, calls } = world();
  const retried = [];
  const withdrawals = {
    start: async () => ({}), list: () => [{ status: "failed", usd: 55 }],
    retry: (id) => { retried.push(id); if (id === "mm-rule" && retried.length > 1) throw Object.assign(new Error("job is running, nothing to retry"), { status: 409 }); return { status: "running", usd: 55 }; },
    room: async (id) => (id === "mm-rule" ? { availableUsd: 150.25, limitUsd: 20.82, nowUsd: 20.82, hour: { limitAda: 100, usedAda: 0, remainingAda: 100 } } : null),
  };
  const started = [];
  const seen = [];
  const deposits = {
    start: async (id, lovelace) => { started.push([id, lovelace]); return { kind: "deposit", agentId: id, status: "running", toAgentLovelace: String(lovelace + 5_000_000n) }; },
    build: async (id, b) => { seen.push(["build", id, b]); return { unsignedTxCbor: "84a0", total: "105000000", outputs: [] }; },
    submit: async (id, b) => { seen.push(["submit", id, b]); return { txHash: "cd".repeat(32) }; },
    list: (id) => started.filter((x) => x[0] === id).map(([agentId, lovelace]) => ({ agentId, lovelace: String(lovelace), status: "done" })),
    retry: (id) => ({ agentId: id, status: "running" }),
  };
  const rotated = [];
  const strikeKeys = { info: (id) => (id === "mm-rule" ? { accountId: "acc-1", publicKey: "ab".repeat(32), connectedAt: "2026-10-22T10:00:00Z" } : null), rotate: async (id) => { rotated.push(id); return { accountId: "acc-1", publicKey: "cd".repeat(32), connectedAt: "2026-10-22T12:00:00Z", sameAccount: true }; } };
  const unwound = [];
  const gateway = { stateOf: () => ({ frozen: false }), stop: async () => ({}), unwind: async (id, reason) => { unwound.push([id, reason]); agents.find((a) => a.agentId === id).unwinding = true; return { inventoryBtc: 0.00147, strikePositionBtc: -0.00147, inventoryUsd: 117.6 }; } };
  const o = ownerApi({ agents, gateway, withdrawals, deposits, strikeKeys, pricing: { ...PRICING, minTopUpAda: 50 }, now: () => T0 });
  const S = { address: owner.address };
  // payouts: the room beside the list, the retry
  const w = await o.api.withdrawalsOf(S, "mm-rule");
  assert.deepEqual([w.body.withdrawals.length, w.body.room.nowUsd, w.body.room.hour.limitAda], [1, 20.82, 100]);
  assert.deepEqual(o.api.retryWithdrawal(S, "mm-rule"), { status: 200, body: { job: { status: "running", usd: 55 } } });
  assert.equal(o.api.retryWithdrawal(S, "mm-rule").status, 409, "the job's own refusal passes through");
  assert.equal(o.api.retryWithdrawal(S, "mm-claude").status, 404, "another owner's agent");
  assert.deepEqual(retried, ["mm-rule", "mm-rule"]);
  // deposits: at least the minimum, the owner's agent, then built and paid as an order
  assert.equal((await o.api.deposit(S, "mm-rule", { ada: 10 })).body.error, "ada: at least 50 tADA");
  assert.equal((await o.api.deposit(S, "mm-rule", { ada: "lots" })).status, 400);
  assert.equal((await o.api.deposit(S, "mm-claude", { ada: 100 })).status, 404);
  const d = await o.api.deposit(S, "mm-rule", { ada: 100 });
  assert.deepEqual([d.status, d.body.job.kind, d.body.job.toAgentLovelace, started], [201, "deposit", "105000000", [["mm-rule", 100_000_000n]]]);
  assert.equal((await o.api.depositPayment(S, "mm-rule", "deposit/build", { utxos: ["82"] })).body.total, "105000000");
  assert.equal((await o.api.depositPayment(S, "mm-rule", "deposit/pay", { signedTxCbor: "84a1" })).body.txHash, "cd".repeat(32));
  assert.equal((await o.api.depositPayment(S, "mm-claude", "deposit/build", {})).status, 404);
  assert.equal((await o.api.depositPayment(S, "mm-rule", "deposit/x", {})).status, 404);
  assert.deepEqual(seen.map((x) => x[0]), ["build", "submit"]);
  assert.equal(o.api.depositsOf(S, "mm-rule").body.deposits.length, 1);
  assert.equal(o.api.retryDeposit(S, "mm-rule").body.job.status, "running");
  // unwind and the Strike key
  const u = await o.api.act(S, "mm-rule", "unwind", {});
  assert.deepEqual([u.status, u.body.status, u.body.inventoryUsd, unwound], [200, "unwinding", 117.6, [["mm-rule", "unwound by the owner"]]]);
  assert.equal((await o.api.act(S, "mm-claude", "unwind", {})).status, 404);
  assert.deepEqual([o.api.agentsOf(S).body.agents[0].unwinding, o.api.agentsOf(S).body.agents[0].strikeKey.publicKey], [true, "ab".repeat(32)]);
  const k = await o.api.rotateStrikeKey(S, "mm-rule");
  assert.deepEqual([k.status, k.body.publicKey, k.body.sameAccount, rotated], [200, "cd".repeat(32), true, ["mm-rule"]]);
  assert.equal((await o.api.rotateStrikeKey(S, "mm-claude")).status, 404);
  const bare = ownerApi({ agents, gateway: { stateOf: () => ({}) }, now: () => T0 });
  assert.deepEqual([(await bare.api.act(S, "mm-rule", "unwind", {})).status, (await bare.api.rotateStrikeKey(S, "mm-rule")).status, (await bare.api.deposit(S, "mm-rule", { ada: 100 })).status], [501, 501, 501], "not wired: not on offer");
  assert.equal(calls.length, 0);
  // over http
  const server = http.createServer((req, res) => { o.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/owner/`;
  try {
    const c = await (await fetch(url + "challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: owner.address }) })).json();
    const sess = await (await fetch(url + "session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: c.nonce, signature: sign(owner, c.message) }) })).json();
    const call = async (path, method, body) => { const r = await fetch(url + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${sess.token}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
    assert.equal((await call("agents/mm-rule/withdrawals", "GET")).body.room.limitUsd, 20.82);
    assert.equal((await call("agents/mm-rule/withdrawals/retry", "POST", {})).status, 409);
    assert.equal((await call("agents/mm-rule/deposit", "POST", { ada: 60 })).status, 201);
    assert.equal((await call("agents/mm-rule/deposit/build", "POST", {})).body.total, "105000000");
    assert.equal((await call("agents/mm-rule/deposit/pay", "POST", { signedTxCbor: "84a1" })).body.txHash, "cd".repeat(32));
    assert.equal((await call("agents/mm-rule/deposits", "GET")).body.deposits.length, 2);
    assert.equal((await call("agents/mm-rule/deposits/retry", "POST", {})).body.job.status, "running");
    assert.equal((await call("agents/mm-rule/unwind", "POST", {})).body.status, "unwinding");
    assert.equal((await call("agents/mm-rule/strike-key/rotate", "POST", {})).body.publicKey, "cd".repeat(32));
    assert.equal((await call("agents/mm-rule/strike-key/rotate", "GET")).status, 404);
  } finally { server.close(); }
});
