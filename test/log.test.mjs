/** The hash-linked decision log: append, verify, detect a changed line, continue after a restart. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decisionLog, verifyLog } from "../gateway/log.mjs";

test("entries chain by hash; a changed line breaks the chain at that line; a reopened log continues it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-log-"));
  const file = path.join(dir, "decisions.jsonl");
  let n = 0;
  const log = decisionLog(file, { now: () => `t${++n}` });
  const a = log.append({ kind: "fill", id: 1 });
  const b = log.append({ kind: "hedge.placed", id: 1 });
  assert.equal(a.seq, 1);
  assert.equal(a.prev, "0".repeat(64));
  assert.equal(b.prev, a.hash);
  assert.deepEqual(verifyLog(file), { ok: true, entries: 2, brokenAt: null });

  const again = decisionLog(file, { now: () => "t9" });
  assert.deepEqual(again.head, { seq: 2, hash: b.hash });
  const c = again.append({ kind: "refusal" });
  assert.equal(c.seq, 3);
  assert.equal(c.prev, b.hash);
  assert.deepEqual(verifyLog(file), { ok: true, entries: 3, brokenAt: null });

  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines[1] = lines[1].replace('"hedge.placed"', '"hedge.filled"');
  fs.writeFileSync(file, lines.join("\n"));
  assert.deepEqual(verifyLog(file), { ok: false, entries: 2, brokenAt: 2 });
});

test("an entry cannot bring its own seq, ts or prev: the log's own values win", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-log-"));
  const file = path.join(dir, "decisions.jsonl");
  const log = decisionLog(file, { now: () => "t1" });
  const e = log.append({ kind: "fill", seq: 99, ts: "yesterday", prev: "ff".repeat(32) });
  assert.deepEqual([e.seq, e.ts, e.prev], [1, "t1", "0".repeat(64)]);
  assert.deepEqual(verifyLog(file), { ok: true, entries: 1, brokenAt: null });
  assert.throws(() => log.append({ kind: "owner.create", hash: "ab".repeat(32) }), /carries a hash field/, "an entry's own hash would break the chain");
  assert.deepEqual(verifyLog(file), { ok: true, entries: 1, brokenAt: null });
});

test("verifyLog from a later entry: anchored on that entry, intact from there even when the file is broken before it", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flint-log-")), "d.jsonl");
  const L = decisionLog(file);
  for (let i = 0; i < 5; i++) L.append({ kind: "x", i });
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  // the second entry is damaged
  lines[1] = lines[1].replace('"i":1', '"i":99');
  fs.writeFileSync(file, lines.join("\n") + "\n");
  assert.equal(verifyLog(file).ok, false);
  assert.equal(verifyLog(file).brokenAt, 2);
  const fromThird = verifyLog(file, { fromSeq: 3 });
  assert.deepEqual(fromThird, { ok: true, entries: 3, brokenAt: null });
  const fromSecond = verifyLog(file, { fromSeq: 2 });
  assert.deepEqual([fromSecond.ok, fromSecond.brokenAt], [false, 2]);
});
