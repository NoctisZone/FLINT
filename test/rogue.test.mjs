/** The rogue agent: every attempt refused, at least five distinct rules across both venues. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseState, liveAttempts, runRogue } from "../agents/rogue.mjs";
import { check } from "../gateway/checks.mjs";
import { profiles } from "../agents/profiles.mjs";

test("the rogue is refused every time, for at least five different rules on both venues", () => {
  const rogue = profiles({ owner: "o", expiry: "2026-10-23T15:00:00Z" }).rogue;
  const { results, rules, allRefused } = runRogue(rogue, 83_700);
  assert.ok(allRefused, results.filter((r) => !r.refused).map((r) => r.label).join(", ") || "all refused");
  assert.ok(rules.length >= 5, rules.join(", "));
  assert.ok(rules.some((r) => r.startsWith("strike.")) && rules.some((r) => r.startsWith("midnight.")) && rules.some((r) => r.startsWith("risk.")));
  for (const r of results) assert.ok(r.refused.limit !== undefined && r.refused.attempted !== undefined && r.refused.message, r.label);
});

test("the live attempts are refused on the action alone, whatever state the gateway is in", () => {
  const rogue = profiles({ owner: "o", expiry: "2026-10-23T15:00:00Z" }).rogue;
  const mark = 80_000;
  for (const t of liveAttempts(rogue, mark)) {
    for (const state of [baseState(rogue, mark), { ...baseState(rogue, mark), frozen: true }, { ...baseState(rogue, mark), midnightInventoryBtc: 0.0005, strikePositionBtc: -0.0004, openQuotes: 1, actionsLastMinute: 3 }]) {
      const r = check(t.action, state);
      assert.ok(r, `${t.label} passed in state ${JSON.stringify(state)}`);
    }
  }
  assert.ok(liveAttempts(rogue, mark).length >= 6);
});
