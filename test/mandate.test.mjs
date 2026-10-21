/** Mandate shape, canonical hash and the owner's signature. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { keypair } from "../gateway/strike.mjs";
import { canonical, mandateHash, mandateProblems, signAsOwner, verifyOwnerSignature } from "../gateway/mandate.mjs";
import { profiles } from "../agents/profiles.mjs";

const P = profiles({ owner: "addr_test1owner", expiry: "2026-10-23T15:00:00Z" });

test("the five profiles are well formed; missing or wrong fields are named", () => {
  for (const m of Object.values(P)) assert.deepEqual(mandateProblems(m), [], m.agentId);
  const broken = { ...P["mm-rule"], strike: { ...P["mm-rule"].strike, maxLeverage: 0 }, risk: { ...P["mm-rule"].risk, hedgeWithinSec: "30" }, expiry: "soon" };
  assert.deepEqual(mandateProblems(broken), ["strike.maxLeverage", "risk.hedgeWithinSec", "expiry"]);
  assert.deepEqual(mandateProblems({ ...P.rogue, midnight: { ...P.rogue.midnight, minSpreadBps: 200 } }), ["midnight.minSpreadBps > maxSpreadBps"]);
  assert.deepEqual(mandateProblems(null), ["not an object"]);
});

test("canonical JSON sorts keys at every level, so the hash does not depend on key order", () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  const m = P["mm-rule"];
  const shuffled = JSON.parse(JSON.stringify(m, Object.keys(m).reverse().concat(Object.keys(m.strike), Object.keys(m.midnight), Object.keys(m.risk))));
  assert.equal(mandateHash(shuffled), mandateHash(m));
  assert.notEqual(mandateHash({ ...m, risk: { ...m.risk, maxNetDeltaUsd: m.risk.maxNetDeltaUsd + 1 } }), mandateHash(m));
  assert.match(mandateHash(m), /^[0-9a-f]{64}$/);
});

test("the owner signs the hash; a changed hash or another key does not verify", () => {
  const owner = keypair("33".repeat(32));
  const hash = mandateHash(P["mm-rule"]);
  const sig = signAsOwner(hash, owner);
  assert.ok(verifyOwnerSignature(hash, sig));
  assert.equal(verifyOwnerSignature(mandateHash(P["mm-claude"]), sig), false);
  assert.equal(verifyOwnerSignature(hash, { ...sig, key: keypair("44".repeat(32)).publicKeyHex }), false);
  assert.equal(verifyOwnerSignature(hash, { key: "zz", signature: "zz" }), false);
});
