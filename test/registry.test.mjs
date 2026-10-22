/** The registry of agents made from the page and their signed mandate files. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registry, loadSignedMandate, orderIndexes, saveSignedMandate } from "../gateway/registry.mjs";
import { cardanoWallet, signData } from "../gateway/cardano.mjs";
import { mandateHash } from "../gateway/mandate.mjs";
import { profiles } from "../agents/profiles.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "flint-reg-"));
const owner = cardanoWallet("11".repeat(32), { stakeSeedHex: "22".repeat(32) });
const sign = (w, text) => { const s = signData(w, Buffer.from(text, "utf8")); return { signature: s.signature, key: s.key }; };

test("the registry: empty at first, the next index comes after the built-ins and every entry, an id or index twice is refused", () => {
  const dir = tmp();
  const r = registry(path.join(dir, "agents.json"));
  assert.deepEqual(r.list(), []);
  assert.equal(r.nextIndex([0, 1, 2, 3, 4]), 5);
  const e = r.add({ agentId: "nova-7", index: 5, mind: "rules", side: null, owner: owner.address, mandateFile: "data/mandates/nova-7.json", createdAt: "2026-10-22T15:00:00Z", strike: { accountId: "acc-9" } });
  assert.equal(e.agentId, "nova-7");
  assert.deepEqual(r.list().map((x) => [x.agentId, x.index]), [["nova-7", 5]]);
  assert.equal(r.get("nova-7").strike.accountId, "acc-9");
  assert.equal(r.get("ghost"), null);
  assert.equal(r.nextIndex([0, 1, 2, 3, 4]), 6);
  assert.equal(r.nextIndex([]), 6, "a registered index is never handed out again");
  assert.throws(() => r.add({ agentId: "nova-7", index: 7 }), /already registered/);
  assert.throws(() => r.add({ agentId: "other", index: 5 }), /index 5 is taken/);
});

test("saved orders reserve their wallet index, finished or failed, so the next order never inherits a wallet", () => {
  const dir = tmp();
  assert.deepEqual(orderIndexes(path.join(dir, "none")), [], "no orders yet");
  const jobs = path.join(dir, "onboard");
  fs.mkdirSync(jobs);
  fs.writeFileSync(path.join(jobs, "nova-63.json"), JSON.stringify({ agentId: "nova-63", index: 7, status: "failed" }));
  fs.writeFileSync(path.join(jobs, "nova-7.json"), JSON.stringify({ agentId: "nova-7", index: 6, status: "done" }));
  fs.writeFileSync(path.join(jobs, "broken.json"), "{not json");
  fs.writeFileSync(path.join(jobs, "notes.txt"), "7");
  assert.deepEqual(orderIndexes(jobs).sort(), [6, 7]);
  const r = registry(path.join(dir, "agents.json"));
  r.add({ agentId: "nova-7", index: 6 });
  assert.equal(r.nextIndex([0, 1, 2, 3, 4, ...orderIndexes(jobs)]), 8, "nova-63 never registered, its wallet 7 stays reserved");
});

test("a signed mandate file loads when signature, owner and expiry hold, and says why when not", () => {
  const dir = tmp();
  const m = { ...profiles({ owner: owner.address, expiry: "2026-10-30T00:00:00Z" })["mm-rule"], agentId: "nova-7" };
  const hash = mandateHash(m);
  const file = saveSignedMandate("nova-7", { mandate: m, signature: sign(owner, hash), hash }, dir);
  assert.equal(file, path.join(dir, "nova-7.json"));
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([saved.hash, Object.keys(saved.signature).sort(), typeof saved.signedAt], [hash, ["key", "signature"], "string"]);
  const t = () => Date.parse("2026-10-22T12:00:00Z");
  assert.deepEqual(loadSignedMandate("nova-7", { owner: owner.address, dir, now: t }), { file, mandate: m, ok: true, why: null });
  assert.equal(loadSignedMandate("nova-7", { owner: "addr_test1other", dir, now: t }).why, "mandate names another owner");
  assert.equal(loadSignedMandate("nova-7", { owner: owner.address, dir, now: () => Date.parse("2026-11-01T00:00:00Z") }).why, "mandate expired");
  assert.equal(loadSignedMandate("ghost", { dir }), null);
  saveSignedMandate("nova-7", { mandate: { ...m, risk: { ...m.risk, maxNetDeltaUsd: 1 } }, signature: sign(owner, hash), hash }, dir);
  assert.equal(loadSignedMandate("nova-7", { owner: owner.address, dir, now: t }).why, "signature does not hold", "a mandate changed after signing");
  fs.writeFileSync(file, "{not json");
  assert.equal(loadSignedMandate("nova-7", { dir }).ok, false);
});
