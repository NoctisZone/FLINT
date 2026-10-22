/** The small Cardano layer: CBOR round trips, keys and addresses, CIP-8 signData, signing a built transaction, a transfer. */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { addressBytesOf, buildTransfer, buildUnsignedTransfer, cardanoWallet, cborDecode, cborEncode, decodeUtxoHex, signData, signTransaction, txHashOf, utxoHex, verifySignData, withWitnesses } from "../gateway/cardano.mjs";

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

test("a transfer picks the largest UTxOs, pays a fixed fee, sends the change back; too little ADA is refused", () => {
  const w = cardanoWallet("55".repeat(32));
  const to = cardanoWallet("66".repeat(32)).address;
  const utxos = [{ tx_hash: "aa".repeat(32), tx_index: 0, value: "3000000" }, { tx_hash: "bb".repeat(32), tx_index: 1, value: "9000000" }];
  const t = buildTransfer({ wallet: w, utxos, to, lovelace: 8_000_000n });
  assert.equal(t.inputs, 1, "the 9 ADA output alone covers 8 ADA plus the fee");
  assert.equal(t.change, 800_000n);
  const body = cborDecode(Buffer.from(t.cborHex, "hex")).items[0].value;
  assert.equal(body.get(0n).length, 1);
  assert.equal(hex(body.get(0n)[0][0]), "bb".repeat(32));
  assert.deepEqual(body.get(1n).map((o) => [hex(o[0]), o[1]]), [[hex(addressBytesOf(to)), 8_000_000n], [hex(w.addressBytes), 800_000n]]);
  assert.equal(body.get(2n), 200_000n);
  assert.throws(() => buildTransfer({ wallet: w, utxos, to, lovelace: 12_000_000n }), /not enough ADA/);
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
  assert.deepEqual(decodeUtxoHex(hex), { tx_hash: "ab".repeat(32), tx_index: 3, value: "1234567", address: w.address, assets: false });
  const withAssets = Buffer.from(cborEncode([[Buffer.from("ab".repeat(32), "hex"), 0n], [w.addressBytes, [2_000_000n, new Map()]]])).toString("hex");
  assert.deepEqual([decodeUtxoHex(withAssets).value, decodeUtxoHex(withAssets).assets], ["2000000", true]);
});

test("an unsigned transfer with several outputs: fee, two outputs, the change last; too little is refused", () => {
  const w = cardanoWallet("55".repeat(32));
  const a = cardanoWallet("77".repeat(32)).address, b = cardanoWallet("88".repeat(32)).address;
  const utxos = [{ tx_hash: "ab".repeat(32), tx_index: 0, value: "10000000" }, { tx_hash: "ac".repeat(32), tx_index: 2, value: "30000000" }];
  const u = buildUnsignedTransfer({ from: w.address, utxos, outputs: [{ to: a, lovelace: 5_000_000n }, { to: b, lovelace: 20_000_000n }] });
  const body = cborDecode(Buffer.from(u.cborHex, "hex")).value[0];
  assert.deepEqual(body.get(1n).map((o) => o[1]), [5_000_000n, 20_000_000n, 30_000_000n - 25_000_000n - 200_000n]);
  assert.deepEqual([u.inputs, u.change], [1, 4_800_000n], "the largest UTxO alone covers it");
  assert.throws(() => buildUnsignedTransfer({ from: w.address, utxos, outputs: [{ to: a, lovelace: 45_000_000n }] }), /not enough ADA/);
});
