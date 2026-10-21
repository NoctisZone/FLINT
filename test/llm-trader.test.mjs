/**
 * Claude as a trader's mind, against a stand-in client: the request that goes
 * out, the decision that comes back, and when the rules take over. No API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DECISION_SCHEMA, SYSTEM_PROMPT, fileBudget, llmBrain } from "../market/llm-trader.mjs";

const view = { name: "trader-1", goal: "…", holds: { CREDIT: 500, DATA: 100 }, board: [] };
const decision = { action: "take", offerId: "o-1", give: null, giveAmount: null, wantAmount: null, reason: "It sells DATA at 3.1, inside my band." };

function client(answer) {
  const requests = [];
  return {
    requests,
    beta: { messages: { parse: async (params) => { requests.push(params); return typeof answer === "function" ? answer(params) : answer; } } },
  };
}
const memoryBudget = (limit, used = 0) => {
  let n = used;
  return { limit, left: () => limit - n, spend: () => { n += 1; }, used: () => n };
};
const ok = (d = decision, extra = {}) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", parsed_output: d, usage: { input_tokens: 900, output_tokens: 120 }, ...extra });

test("a launch in the answer reaches the market as it was given", async () => {
  const launch = { token: "DUSK", supply: 1000, base: 2, max: 8, pitch: "the night owls' token" };
  const brain = llmBrain({ client: client(ok({ ...decision, launch })), model: "claude-sonnet-5-5", effort: "low", budget: memoryBudget(5), journal: () => {} });
  const d = await brain.decide(view);
  assert.deepEqual(d.launch, launch);
  assert.equal((await llmBrain({ client: client(ok()), model: "claude-sonnet-5-5", effort: "low", budget: memoryBudget(5), journal: () => {} }).decide(view)).launch, null);
});

test("one request per decision: the model, effort, the schema and server-side fallbacks; no thinking or tool settings", async () => {
  const c = client(ok());
  const lines = [];
  const brain = llmBrain({ client: c, model: "claude-sonnet-5-5", effort: "medium", budget: memoryBudget(5), journal: (l) => lines.push(l) });
  const d = await brain.decide(view);
  assert.equal(c.requests.length, 1);
  const r = c.requests[0];
  assert.equal(r.model, "claude-sonnet-5-5");
  assert.deepEqual(r.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(r.fallbacks, "default");
  assert.equal(r.output_config.effort, "medium");
  assert.equal(r.output_config.format.type, "json_schema");
  assert.deepEqual(r.output_config.format.schema.required, DECISION_SCHEMA.required);
  assert.equal(Object.keys(r.output_config.format.schema.properties)[0], "reason", "the reason is written before the action");
  assert.equal(r.system, SYSTEM_PROMPT);
  assert.deepEqual(JSON.parse(r.messages[0].content), view);
  for (const k of ["thinking", "tool_choice", "tools", "temperature"]) assert.ok(!(k in r), `no ${k}`);
  assert.equal(d.action, "take");
  assert.equal(d.offerId, "o-1");
  assert.equal(lines.length, 0, "the journal line is written when the market settles the decision");
  d.settle({ result: "filled", offerId: "o-1" });
  assert.equal(lines.length, 1);
  assert.match(lines[0].promptHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(lines[0].outcome, { result: "filled", offerId: "o-1" });
  assert.deepEqual(lines[0].usage, { input: 900, output: 120 });
  assert.equal(lines[0].trader, "trader-1");
});

test("a stray closing brace at the end of the sentence is dropped", async () => {
  const brain = llmBrain({ client: client(ok({ ...decision, reason: "It gets me the CREDIT I need.}" })), model: "m", effort: "low", budget: memoryBudget(5), journal: () => {} });
  assert.equal((await brain.decide(view)).reason, "It gets me the CREDIT I need.");
  const br = llmBrain({ client: client(ok({ ...decision, reason: "Inside my band.</br>" })), model: "m", effort: "low", budget: memoryBudget(5), journal: () => {} });
  assert.equal((await br.decide(view)).reason, "Inside my band.");
  const kept = llmBrain({ client: client(ok({ ...decision, reason: "Terms {100 DATA}" })), model: "m", effort: "low", budget: memoryBudget(5), journal: () => {} });
  assert.equal((await kept.decide(view)).reason, "Terms {100 DATA}");
});

test("the same view gives the same prompt hash", async () => {
  const hashes = [];
  const brain = llmBrain({ client: client(ok()), model: "m", effort: "low", budget: memoryBudget(5), journal: (l) => hashes.push(l.promptHash) });
  (await brain.decide(view)).settle({});
  (await brain.decide(view)).settle({});
  (await brain.decide({ ...view, holds: { CREDIT: 1, DATA: 1 } })).settle({});
  assert.equal(hashes[0], hashes[1]);
  assert.notEqual(hashes[0], hashes[2]);
});

test("a spent budget asks nothing and hands the round to the rules", async () => {
  const c = client(ok());
  const lines = [];
  const brain = llmBrain({ client: c, model: "m", effort: "low", budget: memoryBudget(2, 2), journal: (l) => lines.push(l) });
  const d = await brain.decide(view);
  assert.match(d.fallback, /daily budget of 2 decisions is spent/);
  assert.equal(c.requests.length, 0);
  assert.equal(lines[0].fallback, d.fallback);
});

test("no answer, a declined request or something that is not a decision: the rules run the trader, the budget counts the request", async () => {
  const cases = [
    [() => { throw new Error("529 overloaded"); }, /Claude did not answer: 529 overloaded/],
    [ok(null, { stop_reason: "refusal" }), /declined/],
    [ok(null, { stop_reason: "max_tokens" }), /not a decision \(max_tokens\)/],
    [ok({ ...decision, action: "sell" }), /not a decision/],
  ];
  for (const [answer, re] of cases) {
    const budget = memoryBudget(5);
    const lines = [];
    const d = await llmBrain({ client: client(answer), model: "m", effort: "low", budget, journal: (l) => lines.push(l) }).decide(view);
    assert.match(d.fallback, re);
    assert.equal(budget.used(), 1);
    assert.equal(lines.length, 1);
  }
});

test("the budget is per trader per day and survives a restart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "otc-llm-")), "budget.json");
  let t = Date.parse("2026-10-03T10:00:00Z");
  const b = fileBudget({ limit: 2, file, now: () => t });
  b.spend("trader-1");
  b.spend("trader-1");
  assert.equal(b.left("trader-1"), 0);
  assert.equal(b.left("trader-2"), 2);
  assert.equal(fileBudget({ limit: 2, file, now: () => t }).left("trader-1"), 0, "read back from the file");
  t = Date.parse("2026-10-04T00:00:01Z");
  assert.equal(b.left("trader-1"), 2, "a new day");
});

test("a Haiku request carries no server-side fallback", async () => {
  const c = client(ok(decision, { model: "claude-haiku-5-5" }));
  const brain = llmBrain({ client: c, model: "claude-haiku-5-5", effort: "medium", budget: memoryBudget(5), journal: () => {} });
  await brain.decide(view);
  const r = c.requests[0];
  assert.equal(r.model, "claude-haiku-5-5");
  assert.equal(r.betas, undefined);
  assert.equal(r.fallbacks, undefined);
  assert.equal(r.output_config.effort, "medium");
});
