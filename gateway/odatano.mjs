/**
 * Cardano through the ODATANO gateway with an `oda_` key that has the
 * odatano product: UTxOs of an address, a simple ADA transaction built
 * server-side, a signed transaction submitted, a transaction looked up. The
 * same shape as the Koios client in cardano.mjs, so either serves the
 * onboarding; the gateway is the one that meters every call on the key.
 */
export const ODATANO_PREPROD = "https://api.preprod.odatano.dev";

export function odatano({ baseUrl = ODATANO_PREPROD, key, network = "preprod", fetch = globalThis.fetch } = {}) {
  if (!key) throw new Error("ODATANO needs an oda_ key with odatano access");
  const headers = { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": "flint/0.1" };
  async function get(path) {
    const res = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`ODATANO ${res.status} on ${path.split("?")[0]}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
  async function action(service, name, body) {
    const path = `/odata/v4/${service}/${name}`;
    const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
    if (!res.ok) throw new Error(`ODATANO ${res.status} on ${path}: ${json.error?.message ?? json.error ?? text.slice(0, 200)}`);
    return json;
  }
  return {
    kind: "odatano",
    /** Unspent ADA-only outputs of an address, in the Koios shape: [{ tx_hash, tx_index, value }]. */
    async utxos(address) {
      const { value = [] } = await get(`/odata/v4/cardano/LedgerUTxOs?$filter=address eq '${address}' and spentTxHash eq null`);
      return value.filter((u) => !(u.assets?.length) && !(u.multiAsset)).map((u) => ({ tx_hash: u.txHash, tx_index: Number(u.outputIndex), value: String(u.lovelace ?? u.value ?? u.amount ?? 0) }));
    },
    async balance(address) {
      return (await this.utxos(address)).reduce((s, u) => s + BigInt(u.value), 0n);
    },
    /** An ADA transfer built by ODATANO: the unsigned CBOR to sign with cardano.mjs signTransaction. */
    async buildTransfer({ from, to, lovelace }) {
      const built = await action("cardano-transaction", "BuildSimpleAdaTransaction", { senderAddress: from, recipientAddress: to, lovelaceAmount: String(lovelace) });
      if (!built.unsignedTxCbor) throw new Error(`BuildSimpleAdaTransaction answered no unsignedTxCbor: ${JSON.stringify(built).slice(0, 200)}`);
      return { unsignedTxCbor: built.unsignedTxCbor, fee: built.fee ?? null, buildId: built.ID ?? built.id ?? null };
    },
    /** Submit a signed transaction; resolves to its hash. */
    async submit(signedTxCbor) {
      const r = await action("cardano-transaction", "SubmitSignedTransaction", { signedTxCbor, network });
      if (r.hasErrors || r.errorMessage) throw new Error(`submit failed: ${r.errorCode ?? ""} ${r.errorMessage ?? ""}`.trim());
      return r.txHash;
    },
    /** A transaction as the backend sees it, or null when unknown. */
    async txInfo(hashes) {
      const out = [];
      for (const hash of hashes) {
        let r;
        // a transaction the backends do not know yet is a 404, not an empty answer
        try { r = await action("cardano-backend", "GetTransaction", { hash }); } catch (err) { if (/ODATANO 404/.test(err.message)) continue; throw err; }
        const v = typeof r.value === "string" ? JSON.parse(r.value || "{}") : r.value ?? r;
        if (v && Object.keys(v).length) out.push({ tx_hash: hash, block_height: v.block_height ?? v.blockHeight ?? v.block?.height ?? null, tx_timestamp: v.block_time ?? v.blockTime ?? null, raw: v });
      }
      return out;
    },
  };
}
