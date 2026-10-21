/** Claude as a maker's mind against a stand-in client: the decision, the fallbacks, the budget. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAKER_PROMPT, claudeMaker } from "../agents/claude-maker.mjs";
import { makerDecision } from "../agents/rule-maker.mjs";
import { profiles } from "../agents/profiles.mjs";

const view = { agentId: "mm-claude", mark: 84_000, funding: 0.0000125, books: {}, openQuotes: [], mandate: { minSpreadBps: 10, maxSpreadBps: 150, maxQuoteUsd: 150 } };
const client = (answer) => { const requests = []; return { requests, beta: { messages: { parse: async (p) => { requests.push(p); return typeof answer === "function" ? answer(p) : answer; } } } }; };
const budget = (limit, used = 0) => { let n = used; return { limit, left: () => limit - n, spend: () => { n += 1; } }; };
const ok = (d) => ({ model: "claude-haiku-5-5", stop_reason: "end_turn", parsed_output: d, usage: { input_tokens: 700, output_tokens: 60 } });

test("one request per decision with the schema and the system prompt; the answer is spread, size, pause and reason", async () => {
  const c = client(ok({ reason: "Quiet tape, 40 bps keeps fills coming.", pause: false, spreadBps: 40.4, sizeUsd: 120 }));
  const lines = [];
  const m = claudeMaker({ client: c, budget: budget(5), journal: (l) => lines.push(l) });
  const d = await m.decide(view);
  assert.deepEqual(d, { pause: false, spreadBps: 40, sizeUsd: 120, reason: "Quiet tape, 40 bps keeps fills coming." });
  assert.equal(c.requests[0].system, MAKER_PROMPT);
  assert.equal(c.requests[0].model, "claude-haiku-5-5");
  assert.equal(c.requests[0].betas, undefined, "Haiku: no server-side fallback");
  assert.ok(c.requests[0].output_config.format);
  assert.equal(lines[0].decision.spreadBps, 40);
  assert.equal(lines[0].usage.input, 700);
});

test("a spent budget, an error and a refusal each hand the round to the rules", async () => {
  const m1 = claudeMaker({ client: client(ok({})), budget: budget(2, 2) });
  assert.match((await m1.decide(view)).fallback, /budget of 2/);
  const m2 = claudeMaker({ client: client(() => { throw new Error("overloaded"); }), budget: budget(5) });
  assert.match((await m2.decide(view)).fallback, /did not answer: overloaded/);
  const m3 = claudeMaker({ client: client({ stop_reason: "refusal" }), budget: budget(5) });
  assert.match((await m3.decide(view)).fallback, /declined/);
});

test("the rule maker takes Claude's spread, size and pause as options, still inside the mandate", () => {
  const P = profiles({ owner: "o", expiry: "2026-10-23T15:00:00Z" });
  const v = { mandate: P["mm-claude"], mark: 80_000, holdings: { btc: 0.01, usd: 800, spendable: { btc: 0.004, usd: 320 } }, openQuotes: [], frozen: false, now: 0 };
  const d = makerDecision(v, { spreadBps: 40, sizeUsd: 120 });
  assert.deepEqual(d.quotes.map((q) => [q.side, q.price, q.sizeBtc]), [["ask", 80_160, 0.0015], ["bid", 79_840, 0.0015]]);
  assert.equal(makerDecision(v, { spreadBps: 40, sizeUsd: 999 }).quotes[0].sizeBtc, 0.00187, "size capped by the mandate");
  const p = makerDecision({ ...v, openQuotes: [{ quoteId: "a", side: "ask", price: 80_160, sizeBtc: 0.001 }] }, { pause: true });
  assert.deepEqual([p.retire, p.quotes], [["a"], []]);
});
