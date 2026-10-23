/** The small Cardano layer: CBOR round trips, keys and addresses, CIP-8 signData, signing a built transaction, a transfer. */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { addressBytesOf, buildTransfer, buildUnsignedTransfer, cardanoWallet, cborDecode, cborEncode, decodeUtxoHex, signData, signTransaction, txHashOf, utxoHex, verifySignData, withChainFlags, withWitnesses } from "../gateway/cardano.mjs";

const hex = (u8) => Buffer.from(u8).toString("hex");

test("CBOR: known encodings and a round trip that keeps raw bytes", () => {
  assert.equal(hex(cborEncode(0)), "00");
  assert.equal(hex(cborEncode(24)), "1818");
  assert.equal(hex(cborEncode(1000)), "1903e8");
  assert.equal(hex(cborEncode(-8)), "27");
  assert.equal(hex(cborEncode("a")), "6161");
  assert.equal(hex(cborEncode(new Uint8Array([1, 2]))), "420102");
  assert.equal(hex(cborEncode([1, [2, 3]])), "8201820203");
  assert.equal(hex(cborEncode(new Map([[1n, 2n]]))), "a10102");
  assert.equal(hex(cborEncode({ 0: [1], 1: true })), "a2008101" + "01f5");
  assert.equal(hex(cborEncode(5_000_000n)), "1a004c4b40");
  const bytes = cborEncode([new Map([[0n, [[new Uint8Array(32), 1n]]], [2n, 200_000n]]), new Map(), true, null]);
  const d = cborDecode(bytes);
  assert.equal(d.items.length, 4);
  assert.equal(d.items[0].value.get(2n), 200_000n);
  assert.equal(hex(d.items[0].raw), hex(cborEncode(new Map([[0n, [[new Uint8Array(32), 1n]]], [2n, 200_000n]]))), "the body's raw bytes are the body's encoding");
  assert.equal(d.items[2].value, true);
  assert.equal(d.items[3].value, null);
  assert.equal(d.end, bytes.length);
  const indefinite = Buffer.from("9f0102ff", "hex");
  assert.deepEqual(cborDecode(indefinite).value, [1n, 2n]);
});

test("a wallet from a seed is stable, its enterprise address is addr_test1v… with the key hash, and decodes back", () => {
  const w = cardanoWallet("11".repeat(32));
  assert.equal(w.publicKeyHex, cardanoWallet("11".repeat(32)).publicKeyHex);
  assert.match(w.address, /^addr_test1v[0-9a-z]{50,}$/);
  assert.equal(w.addressBytes.length, 29);
  assert.equal(w.addressBytes[0], 0x60);
  assert.equal(hex(w.addressBytes.subarray(1)), w.keyHashHex);
  assert.equal(hex(addressBytesOf(w.address)), hex(w.addressBytes));
  assert.equal(cardanoWallet("11".repeat(32), { network: "mainnet" }).address.slice(0, 5), "addr1");
  assert.throws(() => cardanoWallet("abcd"), /32 bytes/);
});

test("signData gives a COSE_Sign1 with the address in the protected header and a COSE_Key the signature verifies against", () => {
  const w = cardanoWallet("22".repeat(32));
  const message = Buffer.from('Connect to Strike via builder "flint".\nNonce: 0192f0c1', "utf8");
  const s = signData(w, message);
  assert.equal(s.combined, `${s.signature}:${s.key}`);
  const v = verifySignData(s.signature, s.key);
  assert.equal(v.ok, true);
  assert.equal(v.payload.toString("utf8"), message.toString("utf8"));
  assert.equal(hex(v.addressBytes), hex(w.addressBytes));
  assert.equal(v.publicKeyHex, w.publicKeyHex);
  const key = cborDecode(Buffer.from(s.key, "hex")).value;
  assert.deepEqual([key.get(1n), key.get(3n), key.get(-1n)], [1n, -8n, 6n]);
  const other = cardanoWallet("33".repeat(32));
  assert.equal(verifySignData(s.signature, signData(other, message).key).ok, false);
});

test("signing a built transaction keeps the body bytes and adds one vkey witness; the hash is blake2b-256 of the body", () => {
  const w = cardanoWallet("44".repeat(32));
  const body = new Map([[0n, [[new Uint8Array(32).fill(7), 0n]]], [1n, [[w.addressBytes, 1_000_000n]]], [2n, 170_000n]]);
  const unsigned = Buffer.concat([Buffer.from([0x84]), Buffer.from(cborEncode(body)), Buffer.from(cborEncode(new Map())), Buffer.from([0xf5, 0xf6])]).toString("hex");
  const signed = signTransaction(unsigned, w);
  const d = cborDecode(Buffer.from(signed.cborHex, "hex"));
  assert.equal(hex(d.items[0].raw), hex(cborEncode(body)));
  const witnesses = d.items[1].value.get(0n);
  assert.equal(witnesses.length, 1);
  assert.equal(hex(witnesses[0][0]), w.publicKeyHex);
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(w.publicKey)]), format: "der", type: "spki" });
  assert.ok(crypto.verify(null, Buffer.from(signed.txHash, "hex"), pub, Buffer.from(witnesses[0][1])));
  assert.equal(signed.txHash, txHashOf(cborEncode(body)));
  assert.equal(d.items[2].value, true);
  assert.equal(d.items[3].value, null);
});

test("a transfer picks the largest UTxOs, pays the fee its size asks, sends the change back; too little ADA is refused", () => {
  const w = cardanoWallet("55".repeat(32));
  const to = cardanoWallet("66".repeat(32)).address;
  const utxos = [{ tx_hash: "aa".repeat(32), tx_index: 0, value: "3000000" }, { tx_hash: "bb".repeat(32), tx_index: 1, value: "9000000" }];
  const t = buildTransfer({ wallet: w, utxos, to, lovelace: 8_000_000n });
  assert.equal(t.inputs, 2, "the 9 ADA output alone leaves 0.8 ADA of change, under the smallest output: the 3 ADA one joins");
  const body = cborDecode(Buffer.from(t.cborHex, "hex")).items[0].value;
  // the fee covers the signed transaction's bytes at 44 lovelace each plus 155381, no more than a few hundred lovelace over
  const bytes = t.cborHex.length / 2;
  assert.ok(t.fee >= 155_381n + 44n * BigInt(bytes) && t.fee < 155_381n + 44n * BigInt(bytes) + 1_000n, `fee ${t.fee} for ${bytes} bytes`);
  assert.equal(t.change, 12_000_000n - 8_000_000n - t.fee);
  assert.equal(body.get(0n).length, 2);
  assert.equal(hex(body.get(0n)[0][0]), "bb".repeat(32));
  assert.deepEqual(body.get(1n).map((o) => [hex(o[0]), o[1]]), [[hex(addressBytesOf(to)), 8_000_000n], [hex(w.addressBytes), t.change]]);
  assert.equal(body.get(2n), t.fee);
  // only the 9 ADA output: the 0.8 ADA of change cannot stand alone and goes into the fee
  const t1 = buildTransfer({ wallet: w, utxos: [utxos[1]], to, lovelace: 8_000_000n });
  const body1 = cborDecode(Buffer.from(t1.cborHex, "hex")).items[0].value;
  assert.deepEqual([t1.inputs, t1.change, body1.get(1n).length, body1.get(2n)], [1, 0n, 1, 1_000_000n]);
  const t2 = buildTransfer({ wallet: w, utxos, to, lovelace: 7_000_000n });
  assert.deepEqual([t2.inputs, t2.change], [1, 2_000_000n - t2.fee], "change at or over the smallest output stands by itself");
  const t3 = buildTransfer({ wallet: w, utxos, to, lovelace: 7_000_000n, feeLovelace: 200_000n });
  assert.deepEqual([t3.fee, t3.change], [200_000n, 1_800_000n], "a given fee is taken as it is");
  assert.throws(() => buildTransfer({ wallet: w, utxos, to, lovelace: 12_000_000n }), /not enough ADA: 12 spendable on the wallet, 12\.\d+ needed/);
  const u = utxoHex(utxos[0], w.addressBytes);
  assert.deepEqual(cborDecode(Buffer.from(u, "hex")).value[0][1], 0n);
});

test("a base address names the stake key too: 57 bytes, header 0x00, addr_test1q…; signData still carries it", () => {
  const w = cardanoWallet("11".repeat(32), { stakeSeedHex: "12".repeat(32) });
  assert.match(w.address, /^addr_test1q[0-9a-z]{90,}$/);
  assert.equal(w.addressBytes.length, 57);
  assert.equal(w.addressBytes[0], 0x00);
  assert.equal(hex(w.addressBytes.subarray(1, 29)), w.keyHashHex);
  assert.equal(hex(w.addressBytes.subarray(29)), w.stakeKeyHashHex);
  assert.equal(w.publicKeyHex, cardanoWallet("11".repeat(32)).publicKeyHex, "the payment key is the same key");
  const s = signData(w, Buffer.from("hello"));
  const v = verifySignData(s.signature, s.key);
  assert.equal(v.ok, true);
  assert.equal(v.addressBytes.length, 57);
});

test("a witness set from a wallet joins an unsigned transaction; a CIP-30 UTxO decodes back to Koios shape", () => {
  const w = cardanoWallet("55".repeat(32), { stakeSeedHex: "66".repeat(32) });
  const utxos = [{ tx_hash: "ab".repeat(32), tx_index: 0, value: "30000000" }];
  const u = buildUnsignedTransfer({ from: w.address, utxos, to: cardanoWallet("77".repeat(32)).address, lovelace: 5_000_000n });
  const signed = signTransaction(u.cborHex, w);
  // what signTx returns: the witness set alone
  const witnessSetHex = Buffer.from(cborDecode(Buffer.from(signed.cborHex, "hex")).items[1].raw).toString("hex");
  const merged = withWitnesses(u.cborHex, witnessSetHex);
  assert.deepEqual([merged.cborHex, merged.txHash], [signed.cborHex, u.txHash], "merging the wallet's witnesses gives the same signed transaction");
  assert.throws(() => withWitnesses(u.cborHex, "80"), /not a witness set/);
  const hex = utxoHex({ tx_hash: "ab".repeat(32), tx_index: 3, value: "1234567" }, w.addressBytes);
  assert.deepEqual(decodeUtxoHex(hex), { tx_hash: "ab".repeat(32), tx_index: 3, value: "1234567", address: w.address, assets: [], script: false });
  const policy = Buffer.from("cd".repeat(28), "hex"), name = Buffer.from("JINX");
  const withAssets = Buffer.from(cborEncode([[Buffer.from("ab".repeat(32), "hex"), 0n], [w.addressBytes, [2_000_000n, new Map([[policy, new Map([[name, 80_000n]])]])]]])).toString("hex");
  assert.deepEqual([decodeUtxoHex(withAssets).value, decodeUtxoHex(withAssets).assets], ["2000000", [{ policy: "cd".repeat(28), name: Buffer.from("JINX").toString("hex"), quantity: "80000" }]]);
  // a Babbage output as a map, with a reference script on it
  const withScript = Buffer.from(cborEncode([[Buffer.from("ab".repeat(32), "hex"), 1n], new Map([[0n, w.addressBytes], [1n, 73_000_000n], [3n, { tag: 24n, value: Buffer.from("8203...", "utf8") }]])])).toString("hex");
  assert.deepEqual([decodeUtxoHex(withScript).value, decodeUtxoHex(withScript).assets, decodeUtxoHex(withScript).script], ["73000000", [], true]);
});

test("a transfer leaves coins with scripts out, spends token coins last and sends their tokens back in the change", () => {
  const w = cardanoWallet("55".repeat(32), { stakeSeedHex: "56".repeat(32) });
  const to = cardanoWallet("66".repeat(32)).address;
  const tok = { policy: "cd".repeat(28), name: Buffer.from("JINX").toString("hex"), quantity: "80000" };
  const utxos = [
    { tx_hash: "aa".repeat(32), tx_index: 0, value: "73000000", assets: [], script: true },
    { tx_hash: "ab".repeat(32), tx_index: 0, value: "271000000", assets: [], script: false },
    { tx_hash: "ac".repeat(32), tx_index: 0, value: "1763000000", assets: [tok], script: false },
    { tx_hash: "ad".repeat(32), tx_index: 0, value: "6000000", assets: [], script: false },
  ];
  // 200 ADA: the plain 271 ADA coin alone
  const t = buildUnsignedTransfer({ from: w.address, utxos, to, lovelace: 200_000_000n });
  assert.deepEqual([t.inputs, cborDecode(Buffer.from(t.cborHex, "hex")).value[0].get(1n).length], [1, 2]);
  // 545 ADA: the plain coins do not reach, the token coin joins and its tokens ride in the change
  const t2 = buildUnsignedTransfer({ from: w.address, utxos, to, lovelace: 545_000_000n, witnesses: 2 });
  const body = cborDecode(Buffer.from(t2.cborHex, "hex")).value[0];
  assert.equal(t2.inputs, 3, "271 + 6 + 1763; the script coin stays out");
  const change = body.get(1n).at(-1);
  assert.equal(hex(change[0]), hex(w.addressBytes));
  assert.equal(change[1][0], 2_040_000_000n - 545_000_000n - t2.fee);
  const ma = change[1][1];
  assert.deepEqual([...ma.entries()].map(([p, names]) => [hex(p), [...names.entries()].map(([n, q]) => [Buffer.from(n).toString(), q])]), [["cd".repeat(28), [["JINX", 80_000n]]]]);
  assert.ok(t2.fee > 155_381n + 44n * BigInt(t2.cborHex.length / 2 + 102), "two witnesses are paid for");
  // more than the spendable coins hold: the message names what is spendable and what sits on scripts
  let err; try { buildUnsignedTransfer({ from: w.address, utxos, to, lovelace: 2_045_000_000n }); } catch (e) { err = e; }
  assert.match(err.message, /not enough ADA: 2040 spendable on the wallet, 2045\.\d+ needed \(73 more sits on coins that carry a script or datum and stay out\)/);
  assert.deepEqual([err.spendable, err.onScripts], [2_040_000_000n, 73_000_000n]);
  // the wallet's hex said nothing of the script; the chain's view of the coin does
  const blind = utxos.map((u) => ({ ...u, script: false, assets: [] }));
  const flagged = withChainFlags(blind, utxos);
  assert.deepEqual(flagged.map((u) => [u.script, u.assets.length]), [[true, 0], [false, 0], [false, 1], [false, 0]]);
  assert.equal(buildUnsignedTransfer({ from: w.address, utxos: flagged, to, lovelace: 545_000_000n }).inputs, 3);
  // the change of a token coin must carry its minimum ADA: a spend that leaves less is refused
  assert.throws(() => buildUnsignedTransfer({ from: w.address, utxos: [utxos[2]], to, lovelace: 1_762_500_000n }), /not enough ADA/);
});

test("an unsigned transfer with several outputs: fee, two outputs, the change last; too little is refused", () => {
  const w = cardanoWallet("55".repeat(32));
  const a = cardanoWallet("77".repeat(32)).address, b = cardanoWallet("88".repeat(32)).address;
  const utxos = [{ tx_hash: "ab".repeat(32), tx_index: 0, value: "10000000" }, { tx_hash: "ac".repeat(32), tx_index: 2, value: "30000000" }];
  const u = buildUnsignedTransfer({ from: w.address, utxos, outputs: [{ to: a, lovelace: 5_000_000n }, { to: b, lovelace: 20_000_000n }] });
  const body = cborDecode(Buffer.from(u.cborHex, "hex")).value[0];
  assert.deepEqual(body.get(1n).map((o) => o[1]), [5_000_000n, 20_000_000n, 30_000_000n - 25_000_000n - u.fee]);
  assert.deepEqual([u.inputs, u.change], [1, 5_000_000n - u.fee], "the largest UTxO alone covers it");
  assert.throws(() => buildUnsignedTransfer({ from: w.address, utxos, outputs: [{ to: a, lovelace: 45_000_000n }] }), /not enough ADA/);
});
