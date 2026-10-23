/**
 * The little Cardano an agent needs on preprod: a key and an enterprise
 * address of its own, CIP-8 signData for Strike's builder connect, signing a
 * transaction someone else built (Strike's deposit), a plain ADA transfer,
 * and reading UTxOs and submitting through Koios. Ed25519 comes from Node's
 * crypto; hashes from @noble/hashes, bech32 from @scure/base.
 *
 * The CBOR here is the small subset these transactions use. Decoding keeps
 * every item's raw bytes, so a transaction body is signed exactly as built.
 */
import crypto from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "@scure/base";

export const KOIOS_PREPROD = "https://preprod.koios.rest/api/v1";
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

// ---- CBOR -------------------------------------------------------------------

const head = (major, n) => {
  n = BigInt(n);
  if (n < 24n) return [Number(major << 5) | Number(n)];
  if (n < 256n) return [(major << 5) | 24, Number(n)];
  if (n < 65536n) return [(major << 5) | 25, Number(n >> 8n), Number(n & 255n)];
  if (n < 4294967296n) return [(major << 5) | 26, ...[24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 255n))];
  return [(major << 5) | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 255n))];
};

/** JS → CBOR bytes: integers and bigints, Uint8Array as bytes, strings as text, arrays, Maps or plain objects as maps, booleans, null. */
export function cborEncode(v) {
  const out = [];
  const put = (x) => {
    if (x === null || x === undefined) return out.push(0xf6);
    if (x === true) return out.push(0xf5);
    if (x === false) return out.push(0xf4);
    if (typeof x === "number" || typeof x === "bigint") { const n = BigInt(x); return out.push(...(n >= 0n ? head(0, n) : head(1, -1n - n))); }
    if (x instanceof Uint8Array) { out.push(...head(2, x.length)); return out.push(...x); }
    if (typeof x === "string") { const b = Buffer.from(x, "utf8"); out.push(...head(3, b.length)); return out.push(...b); }
    if (Array.isArray(x)) { out.push(...head(4, x.length)); for (const e of x) put(e); return; }
    if (x instanceof Map) { out.push(...head(5, x.size)); for (const [k, e] of x) { put(k); put(e); } return; }
    if (x && typeof x === "object" && x.tag !== undefined && "value" in x) { out.push(...head(6, x.tag)); return put(x.value); }
    if (x && typeof x === "object") { const keys = Object.keys(x); out.push(...head(5, keys.length)); for (const k of keys) { put(/^-?\d+$/.test(k) ? BigInt(k) : k); put(x[k]); } return; }
    throw new Error(`cannot encode ${typeof x}`);
  };
  put(v);
  return Uint8Array.from(out);
}

/**
 * CBOR bytes → { value, raw } with `raw` the exact bytes of the item; arrays
 * and maps carry their items' raws too (`items` / `entries`). Integers come
 * back as bigint, maps as Map (keys bigint or string).
 */
export function cborDecode(bytes, offset = 0) {
  const b = bytes;
  let i = offset;
  const arg = (info) => {
    if (info < 24) return BigInt(info);
    if (info === 24) return BigInt(b[i++]);
    if (info === 25) { const v = (BigInt(b[i]) << 8n) | BigInt(b[i + 1]); i += 2; return v; }
    if (info === 26) { let v = 0n; for (let k = 0; k < 4; k++) v = (v << 8n) | BigInt(b[i++]); return v; }
    if (info === 27) { let v = 0n; for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(b[i++]); return v; }
    if (info === 31) return null;
    throw new Error(`cbor: bad additional info ${info}`);
  };
  const item = () => {
    const start = i;
    const major = b[i] >> 5;
    const info = b[i] & 31;
    i += 1;
    const n = arg(info);
    let value, items, entries;
    switch (major) {
      case 0: value = n; break;
      case 1: value = -1n - n; break;
      case 2: case 3: {
        if (n === null) { const parts = []; while (b[i] !== 0xff) parts.push(item().value); i += 1; value = major === 2 ? Buffer.concat(parts.map((p) => Buffer.from(p))) : parts.join(""); break; }
        const s = b.subarray(i, i + Number(n)); i += Number(n);
        value = major === 2 ? Uint8Array.from(s) : Buffer.from(s).toString("utf8");
        break;
      }
      case 4: { items = []; if (n === null) { while (b[i] !== 0xff) items.push(item()); i += 1; } else for (let k = 0n; k < n; k++) items.push(item()); value = items.map((x) => x.value); break; }
      case 5: { entries = []; value = new Map(); const one = () => { const k = item(); const v = item(); entries.push([k, v]); value.set(k.value, v.value); }; if (n === null) { while (b[i] !== 0xff) one(); i += 1; } else for (let k = 0n; k < n; k++) one(); break; }
      case 6: { const inner = item(); value = { tag: n, value: inner.value }; break; }
      case 7: value = info === 20 ? false : info === 21 ? true : info === 22 ? null : n; break;
      default: throw new Error(`cbor: major ${major}`);
    }
    return { value, raw: b.subarray(start, i), ...(items ? { items } : {}), ...(entries ? { entries } : {}) };
  };
  const out = item();
  out.end = i;
  return out;
}

// ---- keys and addresses ----------------------------------------------------------

const keyFromSeed = (seedHex) => {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("a Cardano key seed is 32 bytes");
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const publicKey = Uint8Array.from(crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32));
  return { key, publicKey, keyHash: blake2b(publicKey, { dkLen: 28 }) };
};

/**
 * An Ed25519 payment key from a 32-byte seed and its preprod address: an
 * enterprise address (payment key only), or with `stakeSeedHex` a base
 * address that also names a stake key, as wallet apps make them. Spending
 * and signData need only the payment key either way.
 */
export function cardanoWallet(seedHex, { network = "preprod", stakeSeedHex } = {}) {
  const { key, publicKey, keyHash } = keyFromSeed(seedHex);
  const networkId = network === "mainnet" ? 1 : 0;
  const stake = stakeSeedHex ? keyFromSeed(stakeSeedHex) : null;
  const addressBytes = stake ? Uint8Array.from([0x00 | networkId, ...keyHash, ...stake.keyHash]) : Uint8Array.from([0x60 | networkId, ...keyHash]);
  const address = bech32.encode(networkId === 1 ? "addr" : "addr_test", bech32.toWords(addressBytes), 200);
  return {
    key, publicKey, publicKeyHex: Buffer.from(publicKey).toString("hex"), keyHashHex: Buffer.from(keyHash).toString("hex"), addressBytes, address, network,
    stakeKeyHashHex: stake ? Buffer.from(stake.keyHash).toString("hex") : null,
    sign: (bytes) => Uint8Array.from(crypto.sign(null, Buffer.from(bytes), key)),
  };
}

export function addressBytesOf(address) {
  const { words } = bech32.decode(address, 200);
  return Uint8Array.from(bech32.fromWords(words));
}

// ---- CIP-8 signData -----------------------------------------------------------------

/**
 * What a CIP-30 wallet's signData returns for `payload` (the message bytes):
 * COSE_Sign1 with the address in the protected header, and the COSE_Key of
 * the signing key. Strike takes them as "<coseSign1Hex>:<coseKeyHex>".
 */
export function signData(wallet, payload) {
  const protectedHeader = cborEncode(new Map([[1n, -8n], ["address", wallet.addressBytes]]));
  const sigStructure = cborEncode(["Signature1", protectedHeader, new Uint8Array(0), payload]);
  const signature = wallet.sign(sigStructure);
  const coseSign1 = cborEncode([protectedHeader, new Map([["hashed", false]]), payload, signature]);
  const coseKey = cborEncode(new Map([[1n, 1n], [3n, -8n], [-1n, 6n], [-2n, wallet.publicKey]]));
  return { signature: Buffer.from(coseSign1).toString("hex"), key: Buffer.from(coseKey).toString("hex"), combined: `${Buffer.from(coseSign1).toString("hex")}:${Buffer.from(coseKey).toString("hex")}` };
}

/** Check a signData result against a public key: the address header, the payload and the Ed25519 signature. */
export function verifySignData(coseSign1Hex, coseKeyHex) {
  const s = cborDecode(Buffer.from(coseSign1Hex, "hex"));
  const [protectedHeader, , payload, signature] = s.value;
  const key = cborDecode(Buffer.from(coseKeyHex, "hex")).value;
  const publicKey = key.get(-2n);
  const sigStructure = cborEncode(["Signature1", protectedHeader, new Uint8Array(0), payload]);
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey)]), format: "der", type: "spki" });
  const ok = crypto.verify(null, Buffer.from(sigStructure), pub, Buffer.from(signature));
  const header = cborDecode(protectedHeader).value;
  return { ok, payload: Buffer.from(payload), addressBytes: header.get("address"), publicKeyHex: Buffer.from(publicKey).toString("hex") };
}

// ---- transactions -------------------------------------------------------------------

export const txHashOf = (bodyRaw) => Buffer.from(blake2b(bodyRaw, { dkLen: 32 })).toString("hex");

/**
 * Sign a transaction built elsewhere with one key: the body bytes stay as
 * they are, a vkey witness joins the witness set. Returns the signed CBOR
 * (hex) and the transaction hash.
 */
export function signTransaction(txCborHex, wallet) {
  const tx = cborDecode(Buffer.from(txCborHex, "hex"));
  if (!tx.items || tx.items.length < 2) throw new Error("not a transaction: expected [body, witnesses, ...]");
  const [body, witnesses, isValid, aux] = tx.items;
  const hash = blake2b(body.raw, { dkLen: 32 });
  const witness = [wallet.publicKey, wallet.sign(hash)];
  const set = witnesses.value instanceof Map ? new Map(witnesses.value) : new Map();
  set.set(0n, [...(set.get(0n) ?? []), witness]);
  const parts = [Uint8Array.from(head(4, tx.items.length)), body.raw, cborEncode(set)];
  if (isValid) parts.push(isValid.raw);
  if (aux) parts.push(aux.raw);
  return { cborHex: Buffer.concat(parts.map((p) => Buffer.from(p))).toString("hex"), txHash: Buffer.from(hash).toString("hex") };
}

/**
 * A signed transaction from an unsigned one and the witness set a CIP-30
 * wallet returns from `signTx`: the wallet's vkey witnesses join the set.
 */
export function withWitnesses(txCborHex, witnessSetHex) {
  const tx = cborDecode(Buffer.from(txCborHex, "hex"));
  if (!tx.items || tx.items.length < 2) throw new Error("not a transaction: expected [body, witnesses, ...]");
  const [body, witnesses, isValid, aux] = tx.items;
  const added = cborDecode(Buffer.from(witnessSetHex, "hex")).value;
  if (!(added instanceof Map)) throw new Error("not a witness set");
  const set = witnesses.value instanceof Map ? new Map(witnesses.value) : new Map();
  for (const [k, v] of added) set.set(k, k === 0n ? [...(set.get(0n) ?? []), ...v] : v);
  const parts = [Uint8Array.from(head(4, tx.items.length)), body.raw, cborEncode(set)];
  if (isValid) parts.push(isValid.raw);
  if (aux) parts.push(aux.raw);
  return { cborHex: Buffer.concat(parts.map((p) => Buffer.from(p))).toString("hex"), txHash: Buffer.from(blake2b(body.raw, { dkLen: 32 })).toString("hex") };
}

const hexOf = (b) => Buffer.from(b).toString("hex");
/** A multi-asset map (policy → name → quantity) as a list of { policy, name, quantity }, hex and string. */
const assetList = (ma) => { const out = []; if (ma instanceof Map) for (const [policy, names] of ma) for (const [name, quantity] of names) out.push({ policy: hexOf(policy), name: hexOf(name), quantity: String(quantity) }); return out; };

/**
 * A CIP-30 `TransactionUnspentOutput` (hex) as Koios shapes it: `assets` lists
 * the tokens on it, `script` says a reference script or datum sits on it.
 */
export function decodeUtxoHex(hex) {
  const [[hash, index], out] = cborDecode(Buffer.from(hex, "hex")).value;
  // a Babbage output is a map {0 address, 1 amount, 2 datum, 3 script}; the older shape is [address, amount, datum hash?]
  const address = out instanceof Map ? out.get(0n) : out[0];
  const amount = out instanceof Map ? out.get(1n) : out[1];
  const script = out instanceof Map ? out.has(2n) || out.has(3n) : out.length > 2;
  const coin = Array.isArray(amount) ? amount[0] : amount;
  return { tx_hash: hexOf(hash), tx_index: Number(index), value: String(coin), address: bech32.encode((address[0] & 0x0f) === 1 ? "addr" : "addr_test", bech32.toWords(Uint8Array.from(address)), 200), assets: Array.isArray(amount) ? assetList(amount[1]) : [], script };
}

// the fee is linear in the transaction's size; an output carries ADA per byte of its own size
const FEE_FIXED = 155_381n, FEE_PER_BYTE = 44n, LOVELACE_PER_UTXO_BYTE = 4_310n, WITNESS_BYTES = 102;
// the smallest plain output Conway accepts is about 1 ADA on a base address; a change under this stays with the fee
export const MIN_OUTPUT_LOVELACE = 1_200_000n;
const coinOf = (u) => BigInt(u.value);
const hasTokens = (u) => Boolean(u.assets?.length);
const adaOf = (n) => String(Number(n) / 1e6);
/** The tokens on the picked coins as one multi-asset map for the change output. */
const tokensOf = (picked) => {
  const by = {};
  for (const u of picked) for (const a of u.assets ?? []) { by[a.policy] ??= {}; by[a.policy][a.name] = (by[a.policy][a.name] ?? 0n) + BigInt(a.quantity); }
  return new Map(Object.entries(by).map(([p, names]) => [Uint8Array.from(Buffer.from(p, "hex")), new Map(Object.entries(names).map(([n, q]) => [Uint8Array.from(Buffer.from(n, "hex")), q]))]));
};

/**
 * A plain ADA transfer from `from` as unsigned CBOR: one output (`to`,
 * `lovelace`) or several (`outputs: [{ to, lovelace }]`), the fee from the
 * transaction's size (or `feeLovelace` when given) and the change back to
 * `from`; no TTL, no metadata. `utxos` as Koios returns them, with `assets`
 * and `script`: a coin with a reference script or datum stays out, since
 * spending it raises the fee by the script's size; tokens on a spent coin come
 * back in the change. Signed by the sender's wallet or by a CIP-30 `signTx`.
 */
export function buildUnsignedTransfer({ from, utxos, to, lovelace, outputs: given, feeLovelace = null, witnesses = 1 }) {
  const fromBytes = typeof from === "string" ? addressBytesOf(from) : from;
  const outs = (given ?? [{ to, lovelace }]).map((o) => [addressBytesOf(o.to), BigInt(o.lovelace)]);
  const want = outs.reduce((s, o) => s + o[1], 0n);
  const spendable = utxos.filter((u) => !u.script);
  // plain coins first, largest first; coins with tokens only when the plain ones do not reach
  const rest = [...spendable].sort((a, b) => Number(hasTokens(a)) - Number(hasTokens(b)) || (coinOf(b) > coinOf(a) ? 1 : -1));
  const total = spendable.reduce((s, u) => s + coinOf(u), 0n);
  const onScripts = utxos.filter((u) => u.script).reduce((s, u) => s + coinOf(u), 0n);
  const short = (need) => Object.assign(new Error(`not enough ADA: ${adaOf(total)} spendable on the wallet, ${adaOf(need)} needed${onScripts > 0n ? ` (${adaOf(onScripts)} more sits on coins that carry a script or datum and stay out)` : ""}`), { spendable: total, needed: need, onScripts });
  const picked = [];
  let sum = 0n;
  let fee = feeLovelace ?? FEE_FIXED;
  for (;;) {
    while (sum < want + fee && rest.length) { const u = rest.shift(); picked.push(u); sum += coinOf(u); }
    if (sum < want + fee) throw short(want + fee);
    const tokens = tokensOf(picked);
    let change = sum - want - fee;
    const changeOut = tokens.size ? [fromBytes, [change, tokens]] : [fromBytes, change];
    const minChange = tokens.size ? LOVELACE_PER_UTXO_BYTE * BigInt(160 + cborEncode(changeOut).length) : MIN_OUTPUT_LOVELACE;
    // change under what an output must carry: another coin makes it bigger; plain change that small may go into the fee
    if (change > 0n && change < minChange && rest.length) { const u = rest.shift(); picked.push(u); sum += coinOf(u); continue; }
    if (tokens.size && change < minChange) throw short(want + fee + minChange);
    const outputs = [...outs];
    if (tokens.size || change >= minChange) outputs.push(changeOut); else { fee += change; change = 0n; }
    const bodyRaw = cborEncode(new Map([[0n, picked.map((u) => [Buffer.from(u.tx_hash, "hex"), BigInt(u.tx_index)])], [1n, outputs], [2n, fee]]));
    const least = feeLovelace ?? FEE_FIXED + FEE_PER_BYTE * BigInt(bodyRaw.length + 8 + witnesses * WITNESS_BYTES);
    if (fee < least) { fee = least; continue; }
    const cborHex = Buffer.concat([Buffer.from([0x84]), Buffer.from(bodyRaw), Buffer.from(cborEncode(new Map())), Buffer.from([0xf5, 0xf6])]).toString("hex");
    return { cborHex, txHash: txHashOf(bodyRaw), inputs: picked.length, change, fee };
  }
}

/**
 * A plain ADA transfer from `wallet` to `to`, signed by it, the change back to
 * the wallet; no TTL, no metadata. `utxos` as Koios returns them.
 */
export function buildTransfer({ wallet, utxos, to, lovelace, feeLovelace = null }) {
  const u = buildUnsignedTransfer({ from: wallet.addressBytes, utxos, to, lovelace, feeLovelace });
  return { ...signTransaction(u.cborHex, wallet), inputs: u.inputs, change: u.change, fee: u.fee };
}

/** The wallet's coins with what the chain knows of them: a script or tokens the wallet's hex left out. Matched by tx hash and index. */
export function withChainFlags(utxos, chain) {
  const m = new Map(chain.map((u) => [`${u.tx_hash}#${u.tx_index}`, u]));
  return utxos.map((u) => { const c = m.get(`${u.tx_hash}#${u.tx_index}`); return c ? { ...u, script: Boolean(u.script || c.script), assets: u.assets?.length ? u.assets : c.assets ?? [] } : u; });
}

/** What a transfer can spend of these coins: plain and token coins; what sits on coins with a script or datum stays out. */
export function spendableOf(utxos) {
  const sum = (l) => l.reduce((s, u) => s + BigInt(u.value), 0n);
  const scripts = utxos.filter((u) => u.script), tokens = utxos.filter((u) => !u.script && u.assets?.length);
  return { totalLovelace: sum(utxos), spendableLovelace: sum(utxos.filter((u) => !u.script)), onScriptsLovelace: sum(scripts), coins: utxos.length, withScripts: scripts.length, withTokens: tokens.length };
}

/** CIP-30 `TransactionUnspentOutput` hex of an ADA-only UTxO, what Strike's build-tx takes. */
export function utxoHex(u, addressBytes) {
  return Buffer.from(cborEncode([[Buffer.from(u.tx_hash, "hex"), BigInt(u.tx_index)], [addressBytes, BigInt(u.value)]])).toString("hex");
}

// ---- Koios ------------------------------------------------------------------------------

export function koios({ baseUrl = KOIOS_PREPROD, fetch = globalThis.fetch } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json", "user-agent": "flint/0.1" };
  return {
    /** UTxOs of an address: [{ tx_hash, tx_index, value, assets, script }] (value in lovelace, as a string; tokens and scripts as decodeUtxoHex gives them). */
    async utxos(address) {
      const res = await fetch(`${baseUrl}/address_utxos`, { method: "POST", headers, body: JSON.stringify({ _addresses: [address], _extended: true }), signal: AbortSignal.timeout(25_000) });
      if (!res.ok) throw new Error(`koios ${res.status}`);
      return (await res.json()).map((u) => ({ tx_hash: u.tx_hash, tx_index: u.tx_index, value: String(u.value), assets: (u.asset_list ?? []).map((a) => ({ policy: a.policy_id, name: a.asset_name ?? "", quantity: String(a.quantity) })), script: Boolean(u.reference_script || u.inline_datum || u.datum_hash) }));
    },
    /** The ADA a transfer can spend: every coin without a script or datum. */
    async balance(address) {
      return (await this.utxos(address)).filter((u) => !u.script).reduce((s, u) => s + BigInt(u.value), 0n);
    },
    /** Submit a signed transaction; resolves to its hash. */
    async submit(cborHex) {
      const res = await fetch(`${baseUrl}/submittx`, { method: "POST", headers: { "content-type": "application/cbor", accept: "application/json", "user-agent": "flint/0.1" }, body: Buffer.from(cborHex, "hex"), signal: AbortSignal.timeout(25_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`koios submit ${res.status}: ${text.slice(0, 300)}`);
      return text.replace(/"/g, "").trim();
    },
    async txInfo(hashes) {
      const res = await fetch(`${baseUrl}/tx_info`, { method: "POST", headers, body: JSON.stringify({ _tx_hashes: hashes }), signal: AbortSignal.timeout(25_000) });
      if (!res.ok) throw new Error(`koios ${res.status}`);
      return res.json();
    },
  };
}
