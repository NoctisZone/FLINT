/**
 * The board calls of the chain client against a stand-in server: the URL of a
 * function call, the key a call carries, and the error text of either server.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bare, board, ng, ngFunction } from "../market/chain.mjs";

const cfg = { nightgateUrl: "https://gw.example", nightgateKey: "oda_market" };
const C = "c".repeat(64);
const D = "d".repeat(64);
const OFFER = "11111111-2222-4333-8444-555555555555";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function server(answer = () => ({ status: 200, body: { value: [] } })) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET", auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const a = answer(String(url), init);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  return requests;
}

test("listing names every parameter of the function, null for the ones not used", async () => {
  const requests = server();
  assert.deepEqual(await board.list(cfg, { givesType: C, wantsType: D }), []);
  assert.equal(requests[0].url, `https://gw.example/api/v1/nightgate/listSwapOffers(givesType='${C}',wantsType='${D}',tag=null,limit=null,status=null,since=null,mine=null)`);
  assert.equal(requests[0].auth, "Bearer oda_market");
});

test("status, since, mine and a tag go in as their OData literals", async () => {
  const requests = server();
  await board.list(cfg, { tag: "otc demo's", limit: 20, status: "all", since: "2026-10-03T09:41:37.122Z", mine: true }, { key: "oda_trader" });
  // a quote inside a string literal is doubled, the rest is percent-encoded
  assert.equal(requests[0].url, "https://gw.example/api/v1/nightgate/listSwapOffers(givesType=null,wantsType=null,tag='otc%20demo''s',limit=20,status='all',since=2026-10-03T09:41:37.122Z,mine=true)");
  assert.equal(requests[0].auth, "Bearer oda_trader");
});

test("one offer is read by its id, a bare UUID", async () => {
  const requests = server(() => ({ status: 200, body: { offerId: OFFER, status: "filled" } }));
  assert.equal((await board.get(cfg, OFFER)).status, "filled");
  assert.equal(requests[0].url, `https://gw.example/api/v1/nightgate/getSwapOffer(offerId=${OFFER})`);
});

test("a value that is not a plain literal never goes into a function call bare", () => {
  assert.throws(() => bare("x') or (1=1"), /not a bare OData literal/);
});

test("posting and retiring carry the trader's key; tags travel as a JSON array in a string", async () => {
  const requests = server(() => ({ status: 200, body: { offerId: OFFER, status: "open" } }));
  await board.post(cfg, { offer: "swapoffer1xyz", tags: ["otc-demo", "trader-0"], expiresAt: "2026-01-01T00:05:00.000Z" }, { key: "oda_trader" });
  await board.retire(cfg, OFFER, { key: "oda_trader" });
  assert.deepEqual(requests.map((r) => [r.method, r.url, r.auth, r.body]), [
    ["POST", "https://gw.example/api/v1/nightgate/postSwapOffer", "Bearer oda_trader", { offer: "swapoffer1xyz", expiresAt: "2026-01-01T00:05:00.000Z", tags: '["otc-demo","trader-0"]' }],
    ["POST", "https://gw.example/api/v1/nightgate/retireSwapOffer", "Bearer oda_trader", { offerId: OFFER }],
  ]);
});

test("the error says what the server said: the product's shape and the gateway's", async () => {
  server(() => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "postSwapOffer is not in the grant" } } }));
  await assert.rejects(ng(cfg, "postSwapOffer", {}), (e) => e.message === "postSwapOffer is not in the grant" && e.status === 403 && e.code === "FORBIDDEN");
  server(() => ({ status: 402, body: { error: "the key has no units left", unitsLeft: 0 } }));
  await assert.rejects(ng(cfg, "postSwapOffer", {}), (e) => e.message === "the key has no units left" && e.status === 402);
  await assert.rejects(ngFunction(cfg, "getSwapOffer", { offerId: bare(OFFER) }), /the key has no units left/);
});
