/**
 * An agent onboards itself to Strike without anyone at a screen: builder
 * connect turns its Cardano wallet's signature into a Strike account and an
 * API wallet, then an ADA deposit from that wallet funds the account through
 * Strike's own quote, build-tx and confirm calls. All that a person does once
 * is register the builder code.
 *
 * Chain-free through `fetch` and `koios`; the tests hand in stand-ins.
 */
import { keypair, USER_AGENT } from "./strike.mjs";
import { signData, signTransaction, utxoHex } from "./cardano.mjs";

const post = async (fetch, url, body) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`Strike ${res.status} on ${new URL(url).pathname}: ${json.error ?? text.slice(0, 200)}`);
  return json;
};

/**
 * Builder connect for one wallet: a fresh API wallet, the challenge signed
 * with the Cardano key, the account made or found by Strike.
 * @returns {{ accountId, apiWalletPrivateKeyHex, apiWalletPublicKeyHex, builderCode, feeShareBps, address, referral }}
 */
export async function builderConnect({ baseUrl, code, feeShareBps = 10, wallet, apiWalletSeedHex, fetch = globalThis.fetch }) {
  const api = keypair(apiWalletSeedHex);
  const challenge = await post(fetch, `${baseUrl}/auth/builder/request-signature`, { address: wallet.address, chain: "cardano", code, fee_share_bps: feeShareBps, public_key: api.publicKeyHex });
  if (!challenge.nonce || !challenge.message_to_sign) throw new Error("Strike's challenge lacks nonce or message_to_sign");
  // the wallet signs the exact message, as a CIP-30 wallet would over its hex payload
  const signed = signData(wallet, Buffer.from(challenge.message_to_sign, "utf8"));
  const done = await post(fetch, `${baseUrl}/auth/builder/verify-signature`, { nonce: challenge.nonce, wallet_signature: signed.combined });
  if (done.api_wallet_public_key && done.api_wallet_public_key !== api.publicKeyHex) throw new Error("Strike registered a different API wallet key");
  return { accountId: done.account_id, apiWalletPrivateKeyHex: api.privateKeyHex, apiWalletPublicKeyHex: api.publicKeyHex, builderCode: done.builder_code ?? code, feeShareBps: done.fee_share_bps ?? feeShareBps, address: wallet.address, referral: done.referral ?? null, message: challenge.message_to_sign };
}

/**
 * Deposit ADA from the agent's wallet into its Strike account: quote,
 * Strike builds the transaction for our UTxOs, we sign and submit it, then
 * tell Strike the hash. Resolves once Strike has the submission; the credit
 * follows after the confirmations the quote names.
 */
export async function depositAda({ strike, wallet, koios, lovelace, log = () => {} }) {
  const utxos = await koios.utxos(wallet.address);
  const have = utxos.reduce((s, u) => s + BigInt(u.value), 0n);
  if (have < BigInt(lovelace) + 500_000n) throw new Error(`wallet holds ${Number(have) / 1e6} ADA, ${Number(lovelace) / 1e6} plus fees needed`);
  const q = await strike.depositQuote({ blockchain: "cardano", asset_symbol: "ADA", asset_amount: String(lovelace) });
  log({ kind: "deposit.quote", requestId: q.request_id, usd: q.quote?.usd_value, confirmations: q.confirmations_required ?? q.quote?.confirmations, depositAddress: q.deposit_address });
  const built = await strike.depositBuildTx({ request_id: q.request_id, user_address: wallet.address, utxos: utxos.map((u) => utxoHex(u, wallet.addressBytes)) });
  if (built.format !== "cardano_cbor" || !built.unsigned_tx) throw new Error(`unexpected build-tx answer: ${JSON.stringify(built).slice(0, 200)}`);
  const signed = signTransaction(built.unsigned_tx, wallet);
  const submitted = await koios.submit(signed.cborHex);
  const txHash = /^[0-9a-f]{64}$/.test(submitted) ? submitted : signed.txHash;
  log({ kind: "deposit.submitted", requestId: q.request_id, txHash });
  const confirmed = await strike.depositConfirm({ request_id: q.request_id, tx_hash: txHash });
  log({ kind: "deposit.confirmed", requestId: q.request_id, txHash, status: confirmed.status });
  return { requestId: q.request_id, txHash, usd: q.quote?.usd_value ?? null, status: confirmed.status ?? null, lovelace: String(lovelace) };
}
