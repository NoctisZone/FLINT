/**
 * Where the hedging money comes from, traceable by anyone: Strike's own
 * deposit record, and the Cardano transactions behind it read from a public
 * preprod indexer. Three hops per deposit: the owner's transaction into
 * Strike's intake address, Strike's move into its vault, the vault's
 * settlement. Fees and funding since then come from the same history.
 *
 * Chain-free: `history()` is Strike's transaction history, `txInfo(hashes)`
 * the indexer's answer; the tests hand both in.
 */
import crypto from "node:crypto";

export const KOIOS_PREPROD = "https://preprod.koios.rest/api/v1";

/** Koios `tx_info` for a few hashes, inputs and metadata included. */
export async function koiosTxInfo(hashes, { baseUrl = KOIOS_PREPROD, fetch = globalThis.fetch } = {}) {
  if (!hashes.length) return [];
  const res = await fetch(`${baseUrl}/tx_info`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": "flint/0.1" }, body: JSON.stringify({ _tx_hashes: hashes, _inputs: true, _metadata: true }), signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`koios ${res.status}`);
  return res.json();
}

const short = (addr) => (addr ? `${addr.slice(0, 14)}…${addr.slice(-6)}` : null);
const memoOf = (t) => { const m = t.metadata?.["674"]?.msg; return Array.isArray(m) ? m.join(" | ") : null; };
const hop = (t, label) => t ? {
  label, txHash: t.tx_hash, block: t.block_height, time: new Date(t.tx_timestamp * 1000).toISOString(),
  inputs: (t.inputs ?? []).map((i) => ({ address: short(i.payment_addr?.bech32), lovelace: Number(i.value), from: `${i.tx_hash?.slice(0, 8)}#${i.tx_index}` })),
  outputs: (t.outputs ?? []).map((o) => ({ address: short(o.payment_addr?.bech32), lovelace: Number(o.value), datum: !!(o.inline_datum || o.datum_hash) })),
  memo: memoOf(t),
} : null;

/**
 * @param {object} o
 * @param {() => Promise<{transactions: object[]}>} o.history   Strike `/v2/history/transaction`
 * @param {(hashes: string[]) => Promise<object[]>} o.txInfo    indexer tx_info
 * @param {() => Promise<number>} [o.balance]                   Strike wallet balance in USD
 */
export async function capitalTrail({ history, txInfo, balance }) {
  const { transactions = [] } = await history();
  const deposits = transactions.filter((t) => t.type === "deposit");
  const wanted = new Set();
  for (const d of deposits) {
    const intake = d.tx_hash?.split("#")[0];
    if (intake) wanted.add(intake);
    if (d.settlement_tx_hash) wanted.add(d.settlement_tx_hash);
  }
  let txs = wanted.size ? await txInfo([...wanted]) : [];
  const byHash = new Map(txs.map((t) => [t.tx_hash, t]));
  // the owner's own transaction is the input of Strike's intake move
  const owners = new Set();
  for (const d of deposits) {
    const move = byHash.get(d.tx_hash?.split("#")[0]);
    for (const i of move?.inputs ?? []) if (i.tx_hash) owners.add(i.tx_hash);
  }
  const more = [...owners].filter((h) => !byHash.has(h));
  if (more.length) for (const t of await txInfo(more)) byHash.set(t.tx_hash, t);

  const trail = deposits.map((d) => {
    const move = byHash.get(d.tx_hash?.split("#")[0]) ?? null;
    const ownerHash = move?.inputs?.[0]?.tx_hash ?? null;
    const lovelace = Number(d.asset_amount ?? 0);
    const usd = Number(d.amount);
    return {
      requestId: d.request_id, status: d.status, chain: d.blockchain, asset: d.asset_symbol, lovelace, usd,
      usdPerAda: lovelace ? Math.round(usd / (lovelace / 1e6) * 1e6) / 1e6 : null,
      settledAt: new Date(d.timestamp).toISOString(), ownerAddress: d.blockchain_address ?? null,
      hops: [hop(byHash.get(ownerHash), "owner → Strike intake"), hop(move, "Strike intake → vault"), hop(byHash.get(d.settlement_tx_hash), "vault settlement")].filter(Boolean),
    };
  });
  const sum = (type) => transactions.filter((t) => t.type === type).reduce((s, t) => s + Number(t.amount), 0);
  const out = {
    balanceUsd: balance ? await balance() : null,
    depositedUsd: Math.round(trail.reduce((s, d) => s + d.usd, 0) * 1e6) / 1e6,
    feesUsd: Math.round(sum("fee") * 1e6) / 1e6, fundingUsd: Math.round(sum("funding") * 1e6) / 1e6,
    deposits: trail, asOf: new Date().toISOString(),
  };
  // what an attestation binds: the deposits and their chain hops, nothing that moves every second
  out.trailHash = crypto.createHash("sha256").update(JSON.stringify(trail.map((d) => ({ requestId: d.requestId, lovelace: d.lovelace, usd: d.usd, hops: d.hops.map((h) => h.txHash) })))).digest("hex");
  return out;
}
