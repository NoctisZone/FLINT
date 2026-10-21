/**
 * The Strike client against a stand-in server: the signed message, the
 * headers, what a query or a body does to the signature, the clock offset,
 * the builder fee header, the sub-account selector and the error text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { StrikeError, TESTNET, keypair, signRequest, signedMessage, strikeClient } from "../gateway/strike.mjs";

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SEED = "11".repeat(32);

function server(answer = () => ({ status: 200, body: {} })) {
  const requests = [];
  const fetch = async (url, init) => {
    const r = { url: String(url), method: init.method, headers: init.headers, body: init.body };
    requests.push(r);
    const a = answer(r);
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  return { requests, fetch };
}

/** Verify a request's auth headers the way the server does. */
function verify(r, publicKeyHex) {
  const h = r.headers;
  const path = r.url.replace(/^https?:\/\/[^/]+/, "");
  const message = signedMessage({ method: r.method, path, timestamp: h["X-API-Wallet-Timestamp"], nonce: h["X-API-Wallet-Nonce"], body: r.body });
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
  return crypto.verify(null, Buffer.from(message, "utf8"), pub, Buffer.from(h["X-API-Wallet-Signature"], "hex"));
}

test("a keypair from a seed is stable, a new one differs, the public key is 64 hex chars", () => {
  const a = keypair(SEED);
  assert.equal(a.publicKeyHex, keypair(SEED).publicKeyHex);
  assert.match(a.publicKeyHex, /^[0-9a-f]{64}$/);
  assert.notEqual(keypair().publicKeyHex, a.publicKeyHex);
  assert.throws(() => keypair("abcd"), /32 bytes/);
});

test("the signed message: method, path with query, timestamp, nonce, body hash; an empty body hashes as sha256 of nothing", () => {
  assert.equal(signedMessage({ method: "get", path: "/v2/openOrders?symbol=BTC-USD", timestamp: 1700000000, nonce: "n" }), `GET:/v2/openOrders?symbol=BTC-USD:1700000000:n:${EMPTY_HASH}`);
  const body = '{"symbol":"BTC-USD"}';
  assert.equal(signedMessage({ method: "POST", path: "/v2/order", timestamp: 1, nonce: "n", body }).split(":").at(-1), crypto.createHash("sha256").update(body).digest("hex"));
});

test("signRequest gives the four headers and a signature the public key verifies", () => {
  const w = keypair(SEED);
  const h = signRequest({ method: "GET", path: "/v2/account", timestamp: 1700000000, nonce: "0123456789abcdef" }, w);
  assert.deepEqual(Object.keys(h).sort(), ["X-API-Wallet-Nonce", "X-API-Wallet-Public-Key", "X-API-Wallet-Signature", "X-API-Wallet-Timestamp"]);
  assert.equal(h["X-API-Wallet-Public-Key"], w.publicKeyHex);
  assert.equal(h["X-API-Wallet-Signature"].length, 128);
  assert.ok(verify({ url: "https://x/v2/account", method: "GET", headers: h }, w.publicKeyHex));
});

test("a signed GET carries the query in the signed path, the timestamp a second behind the synced clock, a fresh nonce each time", async () => {
  const { requests, fetch } = server((r) => (r.url.endsWith("/v2/time") ? { status: 200, body: { serverTime: 2_000_000_000_000 } } : { status: 200, body: { orders: [] } }));
  let t = 1_000_000_000_000;
  const c = strikeClient({ privateKeyHex: SEED, fetch, now: () => t });
  await c.syncClock();
  await c.openOrders("BTC-USD");
  await c.openOrders("BTC-USD");
  const [, a, b] = requests;
  assert.equal(a.url, `${TESTNET}/v2/openOrders?symbol=BTC-USD`);
  assert.equal(a.method, "GET");
  assert.equal(a.body, undefined);
  assert.equal(a.headers["X-API-Wallet-Timestamp"], String(Math.floor((2_000_000_000_000 - 1000) / 1000)), "server time minus one second, in seconds");
  assert.notEqual(a.headers["X-API-Wallet-Nonce"], b.headers["X-API-Wallet-Nonce"]);
  assert.ok(verify(a, c.publicKeyHex) && verify(b, c.publicKeyHex));
  assert.equal(a.headers["User-Agent"], "flint/0.1");
  assert.equal(a.headers["X-Builder-Fee-Bps"], undefined);
});

test("an order signs the exact body bytes, carries the builder fee and the sub-account, and drops unset fields", async () => {
  const { requests, fetch } = server(() => ({ status: 201, body: { status: "pending", client_order_id: "c1" } }));
  const c = strikeClient({ privateKeyHex: SEED, builderFeeBps: 5, subAccountId: "sub-1", fetch });
  const r = await c.placeOrder({ symbol: "BTC-USD", side: "buy", size: 0.001, price: 60000, clientOrderId: "c1", reduceOnly: true });
  assert.equal(r.status, "pending");
  const [q] = requests;
  assert.deepEqual(JSON.parse(q.body), { symbol: "BTC-USD", side: "buy", type: "limit", size: "0.001", price: "60000", reduce_only: true, client_order_id: "c1", sub_account_id: "sub-1" });
  assert.equal(q.headers["X-Builder-Fee-Bps"], "5");
  assert.equal(q.headers["Content-Type"], "application/json");
  assert.ok(verify(q, c.publicKeyHex));
  await c.positions();
  assert.equal(requests[1].url, `${TESTNET}/v2/positions?sub_account_id=sub-1`);
  assert.equal(requests[1].headers["X-Builder-Fee-Bps"], undefined, "the fee header is only for orders");
});

test("a market order sends no price; cancel is a DELETE with a signed JSON body", async () => {
  const { requests, fetch } = server(() => ({ status: 200, body: {} }));
  const c = strikeClient({ privateKeyHex: SEED, fetch });
  await c.placeOrder({ symbol: "BTC-USD", side: "sell", type: "market", size: "0.002", slippage: 0.01 });
  assert.deepEqual(JSON.parse(requests[0].body), { symbol: "BTC-USD", side: "sell", type: "market", size: "0.002", slippage: "0.01" });
  await c.cancel({ symbol: "BTC-USD", orderId: 42 });
  await c.cancelAll();
  assert.equal(requests[1].method, "DELETE");
  assert.deepEqual(JSON.parse(requests[1].body), { symbol: "BTC-USD", order_id: 42 });
  assert.equal(requests[2].body, "{}", "cancel-all needs a body, an empty object for every symbol");
  assert.ok(verify(requests[1], c.publicKeyHex) && verify(requests[2], c.publicKeyHex));
});

test("market data goes to the /price prefix without auth; a signed call without a key refuses up front", async () => {
  const { requests, fetch } = server(() => ({ status: 200, body: { e: "markPriceUpdate", p: "83698" } }));
  const c = strikeClient({ fetch });
  assert.equal((await c.markPrice("BTC-USD")).p, "83698");
  assert.equal(requests[0].url, `${TESTNET}/price/v2/markPrice?symbol=BTC-USD`);
  assert.equal(requests[0].headers["X-API-Wallet-Public-Key"], undefined);
  await assert.rejects(c.account(), /needs the API wallet key/);
});

test("an error answer becomes a StrikeError with status, text and code", async () => {
  const { fetch } = server((r) => (r.url.includes("markPrice") ? { status: 400, body: { code: "INVALID_SYMBOL", msg: "no mark price data available for symbol" } } : { status: 401, body: { error: "signature expired or invalid timestamp" } }));
  const c = strikeClient({ privateKeyHex: SEED, fetch });
  await assert.rejects(c.markPrice("NOPE"), (e) => e instanceof StrikeError && e.status === 400 && e.code === "INVALID_SYMBOL" && /no mark price/.test(e.message));
  await assert.rejects(c.account(), (e) => e.status === 401 && e.text === "signature expired or invalid timestamp" && e.code === null);
});
