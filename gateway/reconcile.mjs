/**
 * The reconciler: Strike's own fill history against the gateway's log of
 * Midnight fills and hedges, and both against the mandate. It answers the
 * four badge claims with numbers and lists every violation it finds.
 *
 * Pure: it takes the log entries (gateway/log.mjs), Strike's fills
 * (`GET /v2/history/fill`) and the mandate, and returns a report.
 */

/**
 * @param {object} o
 * @param {object[]} o.entries        decision log entries, oldest first
 * @param {object[]} o.strikeFills    Strike fills: { client_order_id | clientOrderId, symbol, side, size, price, time | at }
 * @param {object} o.mandate
 * @param {number} [o.toleranceBtc]   size rounding between venues
 * @param {number} [o.startDeltaBtc]  net delta the agent carried into this run
 */
export function reconcile({ entries, strikeFills, mandate, toleranceBtc = 1e-8, startDeltaBtc = 0 }) {
  const violations = [];
  const say = (rule, detail) => violations.push({ rule, ...detail });

  const fills = entries.filter((e) => e.kind === "fill");
  const placed = new Map(entries.filter((e) => e.kind === "hedge.placed").map((e) => [e.clientOrderId, e]));
  // a fill is hedged by a Strike fill or by a later Midnight fill of the other side (netting)
  const hedged = entries.filter((e) => e.kind === "hedge.filled" || e.kind === "hedge.netted");
  const refusals = entries.filter((e) => e.kind === "refusal");

  // every Strike fill belongs to a hedge the gateway placed, on an allowed market, hedging the right size
  const strikeByOrder = new Map();
  for (const f of strikeFills) {
    const id = f.client_order_id ?? f.clientOrderId;
    const list = strikeByOrder.get(id) ?? [];
    list.push(f);
    strikeByOrder.set(id, list);
    if (!placed.has(id)) say("unknown-strike-fill", { clientOrderId: id, symbol: f.symbol, size: f.size });
    if (!mandate.strike.markets.includes(f.symbol)) say("strike.markets", { clientOrderId: id, symbol: f.symbol });
  }
  for (const [id, h] of placed) {
    const got = (strikeByOrder.get(id) ?? []).reduce((s, f) => s + Number(f.size), 0);
    if (got > h.sizeBtc + toleranceBtc) say("over-hedged", { clientOrderId: id, placed: h.sizeBtc, filled: got });
    const side = (strikeByOrder.get(id) ?? []).find((f) => String(f.side).toLowerCase() !== h.side);
    if (side) say("hedge-side", { clientOrderId: id, expected: h.side, got: side.side });
  }

  // every Midnight fill has a hedge that filled within the deadline
  const latencies = [];
  for (const f of fills) {
    const h = hedged.find((x) => x.fillId === f.id);
    if (!h) { say("unhedged-fill", { fillId: f.id, sizeBtc: f.sizeBtc, side: f.side }); continue; }
    latencies.push(h.latencyMs);
    if (h.latencyMs > mandate.risk.hedgeWithinSec * 1000) say("risk.hedgeWithinSec", { fillId: f.id, latencyMs: h.latencyMs, limitMs: mandate.risk.hedgeWithinSec * 1000 });
    if (f.pair && !mandate.midnight.pairs.includes(f.pair)) say("midnight.pairs", { fillId: f.id, pair: f.pair });
  }

  // net delta over time: Midnight fills move it, Strike fills move it back, in log order; netting moves nothing
  let delta = startDeltaBtc;
  let maxDeltaUsd = 0;
  let lastMark = 0;
  for (const e of entries) {
    if (e.mark) lastMark = e.mark;
    if (e.kind === "fill") delta += e.side === "buy" ? e.sizeBtc : -e.sizeBtc;
    else if (e.kind === "hedge.filled") delta += e.side === "buy" ? (e.sizeBtc ?? 0) : -(e.sizeBtc ?? 0);
    else continue;
    if (lastMark) maxDeltaUsd = Math.max(maxDeltaUsd, Math.abs(delta) * lastMark);
  }
  if (maxDeltaUsd > mandate.risk.maxNetDeltaUsd + 1e-6) say("risk.maxNetDeltaUsd", { maxDeltaUsd, limit: mandate.risk.maxNetDeltaUsd });

  // the gateway's own refusals must all name a rule (a refused action never ran)
  for (const r of refusals) if (!r.rule) say("refusal-without-rule", { seq: r.seq });

  return {
    ok: violations.length === 0,
    violations,
    counts: { midnightFills: fills.length, hedgesPlaced: placed.size, hedgesFilled: hedged.length, strikeFills: strikeFills.length, refusals: refusals.length },
    maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
    maxDeltaUsd,
    /** The four badge claims as non-negative numbers for prove_field_predicates_batch. */
    claims: {
      violations: violations.length,
      maxNetDeltaUsd: Math.round(maxDeltaUsd * 100) / 100,
      maxFillToHedgeSec: Math.ceil((latencies.length ? Math.max(...latencies) : 0) / 1000),
      venuesOutsideMandate: violations.filter((v) => v.rule === "strike.markets" || v.rule === "midnight.pairs").length,
    },
  };
}
