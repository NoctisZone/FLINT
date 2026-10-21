/** Builder connect and the ADA deposit against stand-ins: the signed challenge, the saved keys, the signed and submitted deposit. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { builderConnect, depositAda } from "../gateway/strike-connect.mjs";
import { cardanoWallet, cborDecode, cborEncode, verifySignData } from "../gateway/cardano.mjs";
import { keypair } from "../gateway/strike.mjs";

const hex = (u8) => Buffer.from(u8).toString("hex");

test("builder connect: the challenge is signed by the agent's Cardano key with its address, the account and API wallet come back", async () => {
  const wallet = cardanoWallet("77".repeat(32));
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push([new URL(url).pathname, body]);
    if (url.endsWith("/auth/builder/request-signature")) {
      return new Response(JSON.stringify({ nonce: "0192-nonce", message_to_sign: `Connect to Strike via builder "${body.code}".\nWallet: ${body.address}\nAPI Key: ${body.public_key}\nNonce: 0192-nonce`, message: "x" }), { status: 200 });
    }
    const [sig, key] = body.wallet_signature.split(":");
    const v = verifySignData(sig, key);
    assert.equal(v.ok, true);
    assert.equal(hex(v.addressBytes), hex(wallet.addressBytes));
    assert.match(v.payload.toString("utf8"), /^Connect to Strike via builder "flint"\./);
    return new Response(JSON.stringify({ account_id: "acc-1", builder_code: "flint", fee_share_bps: 10, api_wallet_id: 5, api_wallet_public_key: calls[0][1].public_key, referral: { status: "not_requested" } }), { status: 200 });
  };
  const r = await builderConnect({ baseUrl: "https://api.example", code: "flint", feeShareBps: 10, wallet, apiWalletSeedHex: "88".repeat(32), fetch });
  assert.deepEqual([r.accountId, r.builderCode, r.feeShareBps, r.address], ["acc-1", "flint", 10, wallet.address]);
  assert.equal(r.apiWalletPublicKeyHex, keypair("88".repeat(32)).publicKeyHex);
  assert.deepEqual(calls[0][1], { address: wallet.address, chain: "cardano", code: "flint", fee_share_bps: 10, public_key: r.apiWalletPublicKeyHex });
  assert.equal(calls[1][1].nonce, "0192-nonce");
});

test("builder connect surfaces Strike's error text", async () => {
  const fetch = async () => new Response(JSON.stringify({ error: "builder code not found" }), { status: 404 });
  await assert.rejects(builderConnect({ baseUrl: "https://api.example", code: "nope", wallet: cardanoWallet("77".repeat(32)), apiWalletSeedHex: "88".repeat(32), fetch }), /Strike 404 on \/auth\/builder\/request-signature: builder code not found/);
});

test("deposit: quote, build-tx with our UTxOs as CIP-30 hex, sign, submit, confirm", async () => {
  const wallet = cardanoWallet("99".repeat(32));
  const utxos = [{ tx_hash: "ab".repeat(32), tx_index: 0, value: "20000000" }];
  const calls = [];
  const body = new Map([[0n, [[Buffer.from("ab".repeat(32), "hex"), 0n]]], [1n, [[new Uint8Array(29), 10_000_000n], [wallet.addressBytes, 9_800_000n]]], [2n, 200_000n]]);
  const unsigned = Buffer.concat([Buffer.from([0x84]), Buffer.from(cborEncode(body)), Buffer.from(cborEncode(new Map())), Buffer.from([0xf5, 0xf6])]).toString("hex");
  const strike = {
    depositQuote: async (b) => { calls.push(["quote", b]); return { request_id: "req-1", quote: { usd_value: "2.27", confirmations: 12 }, deposit_address: "addr_test1w…", confirmations_required: 12 }; },
    depositBuildTx: async (b) => { calls.push(["build", b]); return { blockchain: "cardano", unsigned_tx: unsigned, format: "cardano_cbor" }; },
    depositConfirm: async (b) => { calls.push(["confirm", b]); return { request_id: b.request_id, status: "pending" }; },
  };
  let submitted = null;
  const koios = { utxos: async () => utxos, submit: async (cbor) => { submitted = cbor; return "cd".repeat(32); } };
  const log = [];
  const r = await depositAda({ strike, wallet, koios, lovelace: 10_000_000n, log: (e) => log.push(e) });
  assert.deepEqual(calls[0], ["quote", { blockchain: "cardano", asset_symbol: "ADA", asset_amount: "10000000" }]);
  assert.equal(calls[1][1].user_address, wallet.address);
  assert.equal(calls[1][1].utxos.length, 1);
  assert.deepEqual(cborDecode(Buffer.from(calls[1][1].utxos[0], "hex")).value[1][1], 20_000_000n);
  const signed = cborDecode(Buffer.from(submitted, "hex"));
  assert.equal(hex(signed.items[1].value.get(0n)[0][0]), wallet.publicKeyHex, "our witness is on the submitted transaction");
  assert.deepEqual(calls[2], ["confirm", { request_id: "req-1", tx_hash: "cd".repeat(32) }]);
  assert.deepEqual([r.requestId, r.txHash, r.usd, r.status], ["req-1", "cd".repeat(32), "2.27", "pending"]);
  assert.deepEqual(log.map((e) => e.kind), ["deposit.quote", "deposit.submitted", "deposit.confirmed"]);
  await assert.rejects(depositAda({ strike, wallet, koios, lovelace: 50_000_000n }), /wallet holds 20 ADA/);
});
