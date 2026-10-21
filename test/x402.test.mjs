/** The x402 round trip against a stand-in facilitator: the 402, the envelope, settle outcomes, the receipt. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { charge, normalizeEnvelope, requirement, requirementsBody } from "../gateway/x402.mjs";

const X = { facilitatorUrl: "https://fac.example/v1", facilitatorKey: "fkey", payTo: "addr_test1vqpayto", network: "cardano:preprod", asset: "lovelace" };
const envelope = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

/** A stand-in x402 v2 facilitator (/verify, /settle) steered by the envelope's `mock` field. */
function facilitator() {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.authorization, body });
    const env = body.paymentPayload;
    const accept = body.paymentRequirements;
    const json = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (url.endsWith("/verify")) {
      if (env.mock?.reject) return json({ isValid: false, invalidReason: env.mock.reject });
      if (env.network !== accept.network) return json({ isValid: false, invalidReason: "network_mismatch" });
      return json({ isValid: true, payer: "addr_test1vqbuyer" });
    }
    if (env.mock?.pending) return json({ success: false, errorReason: "transaction not yet confirmed", transaction: "ab".repeat(32) });
    return json({ success: true, transaction: "cd".repeat(32), network: accept.network, payer: "addr_test1vqbuyer" });
  };
  return { calls, fetch };
}

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("requirement and body carry the resource at the top; a v2 envelope gets scheme and network lifted", () => {
  const a = requirement("https://g/mcp/mm-rule", "one post_quote", "1000000", X, { tool: "post_quote" });
  assert.deepEqual([a.scheme, a.network, a.asset, a.amount, a.payTo, a.maxTimeoutSeconds, a.extra], ["exact", "cardano:preprod", "lovelace", "1000000", "addr_test1vqpayto", 600, { tool: "post_quote" }]);
  const b = requirementsBody([a], "PAYMENT-SIGNATURE header is required");
  assert.deepEqual([b.x402Version, b.error, b.resource.url, b.accepts.length], [2, "PAYMENT-SIGNATURE header is required", "https://g/mcp/mm-rule", 1]);
  const lifted = JSON.parse(Buffer.from(normalizeEnvelope(envelope({ x402Version: 2, accepted: { scheme: "exact", network: "cardano:preprod" }, payload: {} })), "base64").toString("utf8"));
  assert.deepEqual([lifted.scheme, lifted.network], ["exact", "cardano:preprod"]);
  assert.equal(normalizeEnvelope("not base64 json"), "not base64 json");
});

test("no payment: 402 with the header and body; a paid call runs and carries the receipt; rejected and pending answer 402 again", async () => {
  const fac = facilitator();
  const paid = [];
  const { base, close } = await serve(async (req, res) => {
    const r = await charge(req, res, { url: `${base}/mcp/mm-rule`, description: "one post_quote", amount: "1000000", x: X, fetch: fac.fetch, onPaid: (p) => paid.push(p) });
    if (!r.paid) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, payer: r.payment.payerAddr }));
  });
  const r1 = await fetch(`${base}/mcp/mm-rule`, { method: "POST" });
  assert.equal(r1.status, 402);
  const req = JSON.parse(Buffer.from(r1.headers.get("payment-required"), "base64").toString("utf8"));
  assert.equal(req.accepts[0].amount, "1000000");
  assert.match((await r1.json()).note, /not refunded/);

  const pay = (mock) => envelope({ x402Version: 2, scheme: "exact", network: "cardano:preprod", payload: { nonce: `${"ef".repeat(32)}#0` }, ...(mock ? { mock } : {}) });
  const r2 = await fetch(`${base}/mcp/mm-rule`, { method: "POST", headers: { "payment-signature": pay() } });
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { ok: true, payer: "addr_test1vqbuyer" });
  assert.ok(r2.headers.get("payment-response"));
  assert.equal(fac.calls[0].auth, "Bearer fkey");
  assert.ok(fac.calls[0].url.endsWith("/verify") && fac.calls[1].url.endsWith("/settle"));
  assert.equal(fac.calls[0].body.paymentRequirements.payTo, "addr_test1vqpayto");
  assert.equal(fac.calls[0].body.x402Version, 2);
  assert.equal(paid.length, 1);

  const r3 = await fetch(`${base}/mcp/mm-rule`, { method: "POST", headers: { "payment-signature": pay({ reject: "insufficient_amount" }) } });
  assert.equal(r3.status, 402);
  assert.match((await r3.json()).error, /rejected \(insufficient_amount\)/);
  const r4 = await fetch(`${base}/mcp/mm-rule`, { method: "POST", headers: { "payment-signature": pay({ pending: true }) } });
  assert.equal(r4.status, 402);
  assert.equal((await r4.json()).pending, true);
  close();
});

test("a facilitator that is down answers 503 to the caller", async () => {
  const { base, close } = await serve(async (req, res) => { await charge(req, res, { url: base, description: "x", amount: "1", x: X, fetch: async () => { throw new Error("ECONNREFUSED"); } }); });
  const r = await fetch(base, { method: "POST", headers: { "payment-signature": envelope({ x402Version: 2, scheme: "exact", network: "cardano:preprod", payload: { nonce: "a#0" } }) } });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /unreachable/);
  close();
});
