/** The agents' MCP tools over an in-memory transport against a stand-in port. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toolServer } from "../gateway/tools.mjs";

function port() {
  const calls = [];
  return {
    calls,
    mandate: async () => ({ agentId: "mm-x", room: { netDeltaUsd: 120 } }),
    market: async () => ({ mark: 84000, funding: 0.0000125, board: [] }),
    account: async () => ({ frozen: false, netDeltaUsd: 0 }),
    preview: async (a) => (a.sizeBtc > 0.01 ? { ok: false, refused: { rule: "midnight.maxQuoteUsd", limit: 150, attempted: 840 } } : { ok: true }),
    postQuote: async (q, why) => { calls.push(["post", q, why]); return q.price > 90000 ? { refused: { rule: "midnight.maxSpreadBps", limit: 100, attempted: 714 } } : { quoteId: "q1", ...q }; },
    takeQuote: async (id, why) => { calls.push(["take", id, why]); return { landed: true, txHash: "ab".repeat(32) }; },
    placeOrder: async (o, why) => { calls.push(["order", o, why]); return { status: "pending" }; },
    hedge: async () => ({ placed: false }),
    cancelAll: async () => ({ strike: 0, quotes: 2 }),
    closePosition: async (why) => { calls.push(["close", why]); return { status: "pending" }; },
  };
}

async function connect(p) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = toolServer(p);
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const parse = (r) => JSON.parse(r.content[0].text);

test("ten tools, no owner tools; reads answer the port; writes carry the reason; a refusal comes back as data", async () => {
  const p = port();
  const { client, close } = await connect(p);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["cancel_all", "close_position", "get_account", "get_mandate", "get_market", "hedge", "place_order", "post_quote", "preview_action", "take_quote"]);
  assert.ok(!names.some((n) => /kill|resume|set_mandate/.test(n)));
  assert.equal(parse(await client.callTool({ name: "get_mandate", arguments: {} })).agentId, "mm-x");
  assert.equal(parse(await client.callTool({ name: "get_market", arguments: {} })).mark, 84000);
  assert.deepEqual(parse(await client.callTool({ name: "preview_action", arguments: { venue: "midnight", kind: "quote", side: "ask", sizeBtc: 0.02, price: 84200 } })).refused.rule, "midnight.maxQuoteUsd");
  const q = parse(await client.callTool({ name: "post_quote", arguments: { side: "ask", sizeBtc: 0.001, price: 84200, ttlSec: 120, reason: "25 bps over the mark, inside the band." } }));
  assert.equal(q.quoteId, "q1");
  assert.deepEqual(p.calls[0], ["post", { side: "ask", sizeBtc: 0.001, price: 84200, ttlSec: 120 }, "25 bps over the mark, inside the band."]);
  assert.equal(parse(await client.callTool({ name: "post_quote", arguments: { side: "ask", sizeBtc: 0.001, price: 95000, reason: "greedy ask" } })).refused.rule, "midnight.maxSpreadBps");
  assert.equal(parse(await client.callTool({ name: "take_quote", arguments: { quoteId: "0454e277-bdd1", reason: "16 bps off the mark." } })).landed, true);
  assert.equal(parse(await client.callTool({ name: "close_position", arguments: { reason: "done for today" } })).status, "pending");
  assert.deepEqual(p.calls.at(-1), ["close", "done for today"]);
  const bad = await client.callTool({ name: "post_quote", arguments: { side: "ask", sizeBtc: 0.001, price: 84200 } });
  assert.equal(bad.isError, true, "a missing reason is a schema error");
  await close();
});
