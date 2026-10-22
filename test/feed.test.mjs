/** The feed state and its routes over a real socket. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedServer, feedState } from "../gateway/feed.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("routes answer the state, lists newest first with `since`, unknown routes 404", async () => {
  const s = feedState({ runStart: "2026-10-22T10:00:00Z" });
  s.setMark(84_000);
  s.agent("mm-rule", { name: "MM rule-based", type: "mm", status: "quoting" });
  s.agent("mm-rule", { equityUsd: 100.5 });
  s.quoteOpen({ quoteId: "q1", side: "ask", pair: "tBTC/tUSD", price: 84_200, sizeBtc: 0.0007, expiresAt: "2026-10-22T10:05:00Z" });
  s.fill({ ts: "2026-10-22T10:01:00Z", quoteId: "q1", agentId: "mm-rule" });
  s.fill({ ts: "2026-10-22T10:02:00Z", quoteId: "q2", agentId: "mm-rule" });
  s.refusal({ ts: "2026-10-22T10:01:30Z", agentId: "rogue", rule: "midnight.maxSpreadBps", limit: 100, attempted: 450 });
  const server = await feedServer(s, { port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  assert.deepEqual((await get("/feed/agents")).body, { agents: [{ agentId: "mm-rule", name: "MM rule-based", type: "mm", status: "quoting", equityUsd: 100.5 }] });
  assert.equal((await get("/feed/quotes")).body.quotes.length, 1);
  assert.deepEqual((await get("/feed/fills")).body.fills.map((f) => f.quoteId), ["q2", "q1"]);
  assert.deepEqual((await get("/feed/fills?since=2026-10-22T10:01:00Z")).body.fills.map((f) => f.quoteId), ["q2"]);
  assert.equal((await get("/feed/refusals")).body.refusals[0].rule, "midnight.maxSpreadBps");
  const meta = (await get("/feed/meta")).body;
  assert.equal(meta.strikeMark, 84_000);
  assert.ok(meta.serverTime);
  assert.equal((await get("/feed/nope")).status, 404);
  assert.equal((await get("/other")).status, 404);
  assert.deepEqual((await get("/feed/capital")).body, { deposits: [], asOf: null });
  s.capital({ deposits: [{ usd: 1 }], asOf: "x" });
  assert.equal((await get("/feed/capital")).body.deposits.length, 1);
  s.quoteGone("q1");
  assert.equal((await get("/feed/quotes")).body.quotes.length, 0);
  server.close();
});

test("a Midnight fill learns its hedge later; a Strike fill entry or an unknown quote is left alone", () => {
  const s = feedState();
  s.fill({ ts: "2026-10-22T10:01:00Z", quoteId: "q1", agentId: "mm-rule", midnight: { side: "sell", sizeBtc: 0.001, price: 84_200 } });
  s.fill({ ts: "2026-10-22T10:01:03Z", agentId: "mm-rule", strikeFill: { side: "BUY", size: "0.001", price: "84000", clientOrderId: "mm-rule-hedge-1" } });
  s.fillHedged("q1", { how: "market", clientOrderIds: ["mm-rule-hedge-1"], price: 84_000, latencySec: 3.1 });
  s.fillHedged("q9", { how: "netted" });
  const fills = s.get("fills").fills;
  assert.deepEqual(fills.map((f) => f.hedge?.how ?? null), [null, "market"]);
  assert.equal(fills[1].hedge.latencySec, 3.1);
});

test("with a static folder the server hands out the page at / and its files, never anything outside the folder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-arena-"));
  fs.writeFileSync(path.join(dir, "flint.html"), "<!doctype html><title>Flint</title>");
  fs.mkdirSync(path.join(dir, "logos"));
  fs.writeFileSync(path.join(dir, "logos", "x.svg"), "<svg/>");
  const s = feedState();
  const server = await feedServer(s, { port: 0, staticDir: dir });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + "/");
  assert.deepEqual([page.status, page.headers.get("content-type"), await page.text()], [200, "text/html; charset=utf-8", "<!doctype html><title>Flint</title>"]);
  const logo = await fetch(base + "/logos/x.svg");
  assert.deepEqual([logo.status, logo.headers.get("content-type")], [200, "image/svg+xml"]);
  assert.equal((await fetch(base + "/feed/meta")).status, 200, "the feed still answers");
  assert.equal((await fetch(base + "/logos/../../etc/passwd")).status, 404);
  assert.equal((await fetch(base + "/nothing.css")).status, 404);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("setMarks keeps every market's mark and history; BTC-USD also fills strikeMark and marks for older readers", () => {
  const s = feedState({ runStart: "2026-10-22T10:00:00Z" });
  s.setMarks({ "BTC-USD": { mark: 84_000, funding: 0.00001 }, "ADA-USD": { mark: 0.41, funding: null }, "SOL-USD": { mark: 0 } });
  s.setMarks({ "BTC-USD": { mark: 84_010 }, "ADA-USD": { mark: 0.42 } });
  const m = s.get("meta");
  assert.equal(m.strikeMark, 84_010);
  assert.deepEqual(m.marks.map((x) => x.p), [84_000, 84_010]);
  assert.deepEqual(Object.keys(m.markets), ["BTC-USD", "ADA-USD"], "a market without a mark is not listed");
  assert.deepEqual([m.markets["ADA-USD"].mark, m.markets["ADA-USD"].marks.map((x) => x.p), m.markets["BTC-USD"].funding], [0.42, [0.41, 0.42], null]);
});
