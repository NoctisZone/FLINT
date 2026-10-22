/** The agents' tools keys: issued once, hashed on disk, checked as a bearer token, revoked. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentKeys } from "../gateway/agent-keys.mjs";

test("an agent without a key is open; with one, only its bearer token opens it; a new key retires the old; revoke opens it again", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flint-keys-")), "keys.json");
  let n = 0;
  const k = agentKeys(file, { now: () => Date.parse("2026-10-22T16:00:00Z"), random: () => (++n).toString(16).padStart(48, "0") });
  assert.equal(k.authorize("nova-7", undefined), true);
  assert.equal(k.info("nova-7"), null);
  const a = k.issue("nova-7");
  assert.deepEqual([a.key, a.prefix, a.issuedAt], [`flint_${"0".repeat(47)}1`, "flint_000000", "2026-10-22T16:00:00.000Z"]);
  assert.equal(k.has("nova-7"), true);
  assert.deepEqual(k.info("nova-7"), { prefix: "flint_000000", issuedAt: "2026-10-22T16:00:00.000Z" });
  assert.equal(k.authorize("nova-7", `Bearer ${a.key}`), true);
  assert.equal(k.authorize("nova-7", "Bearer flint_nope"), false);
  assert.equal(k.authorize("nova-7", undefined), false);
  assert.ok(!fs.readFileSync(file, "utf8").includes(a.key), "the key itself is not on disk");
  const b = k.issue("nova-7");
  assert.deepEqual([k.authorize("nova-7", `Bearer ${a.key}`), k.authorize("nova-7", `Bearer ${b.key}`)], [false, true]);
  assert.equal(k.authorize("mm-rule", undefined), true, "another agent stays open");
  assert.equal(k.revoke("nova-7"), true);
  assert.equal(k.revoke("nova-7"), false);
  assert.equal(k.authorize("nova-7", undefined), true);
});
