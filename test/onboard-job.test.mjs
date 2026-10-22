/** The onboarding job: steps in order, details and data kept, a failure stops it, a retry goes on from there, a restart is a failure to retry. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { onboardJob, STEPS } from "../gateway/onboard-job.mjs";

const T0 = Date.parse("2026-10-22T15:00:00Z");

test("every step runs once in order, its detail lands on the view, data stays off it, the view says which step is current", async () => {
  const ran = [];
  const saves = [];
  const steps = Object.fromEntries(STEPS.map((s) => [s, async (ctx) => { ran.push(s); if (s === "mint") ctx.set("mints", 8); if (s === "quote") ctx.note("waiting"); return `${s} done`; }]));
  let t = T0;
  const j = onboardJob({ agentId: "nova-7", index: 5, owner: "addr_test1owner", mind: "rules", steps, save: (job) => saves.push(job.status), now: () => (t += 1000) });
  assert.deepEqual([j.view().status, j.view().current, j.view().steps.length], ["pending", "wallet", 6]);
  const done = await j.run();
  assert.deepEqual(ran, STEPS);
  assert.deepEqual([done.status, done.error], ["done", null]);
  const v = j.view();
  assert.deepEqual(v.steps.map((s) => [s.step, s.status, s.detail]), STEPS.map((s) => [s, "done", `${s} done`]));
  assert.equal(v.current, null);
  assert.equal("data" in v, false, "the view carries no step data");
  assert.equal(j.job.data.mints, 8);
  assert.ok(saves.length > 6, "saved after every change");
  assert.equal(await j.run(), done, "a done job runs no more");
  assert.throws(() => j.retry(), /nothing to retry/);
});

test("a failing step stops the job; the retry runs from that step with the data of the first try; two runs at once are one", async () => {
  let fail = true;
  const ran = [];
  const steps = Object.fromEntries(STEPS.map((s) => [s, async (ctx) => { ran.push(s); if (s === "strike" && fail) { ctx.set("depositTx", "ab".repeat(32)); throw new Error("not credited yet"); } if (s === "strike") return `credited after ${ctx.data.depositTx.slice(0, 4)}`; }]));
  const j = onboardJob({ agentId: "nova-7", index: 5, owner: "o", mind: "claude", steps, now: () => T0 });
  const p1 = j.run();
  assert.equal(j.running, true);
  assert.equal(j.run(), p1, "the run in flight is the one");
  const r = await p1;
  assert.deepEqual([r.status, r.error], ["failed", "strike: not credited yet"]);
  assert.deepEqual(j.view().steps.map((s) => s.status), ["done", "done", "failed", "pending", "pending", "pending"]);
  assert.equal(j.view().current, "strike");
  fail = false;
  const r2 = await j.retry();
  assert.equal(r2.status, "done");
  assert.deepEqual(ran, ["wallet", "mint", "strike", "strike", "open", "register", "quote"]);
  assert.equal(j.view().steps[2].detail, "credited after abab");
});

test("a job read back from disk after a restart: the step that was running is failed and the retry goes on from it", async () => {
  const saved = { agentId: "nova-7", index: 5, owner: "o", mind: "rules", status: "running", startedAt: "x", updatedAt: "x", error: null, data: { mints: 3 }, steps: STEPS.map((step, i) => ({ step, status: i < 1 ? "done" : i === 1 ? "running" : "pending", detail: null, at: null })) };
  const ran = [];
  const steps = Object.fromEntries(STEPS.map((s) => [s, async (ctx) => { ran.push([s, ctx.data.mints]); }]));
  const j = onboardJob({ steps, saved, now: () => T0 });
  assert.deepEqual([j.view().status, j.view().error, j.view().steps[1].status, j.view().steps[1].detail], ["failed", "the gateway restarted", "failed", "the gateway restarted during this step"]);
  await j.retry();
  assert.deepEqual(ran.map((x) => x[0]), ["mint", "strike", "open", "register", "quote"]);
  assert.equal(ran[0][1], 3, "the coins minted before the restart are known");
});
