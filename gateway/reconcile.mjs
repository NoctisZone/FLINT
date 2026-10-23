/**
 * The reconciler: Strike's own fill history against the gateway's log of
 * Midnight fills and hedges, and both against the mandate. It answers the
 * four badge claims with numbers and lists every violation it finds.
 *
 * Pure: it takes the log entries (gateway/log.mjs), Strike's fills
 * (`GET /v2/history/fill`) and the mandate, and returns a report. An agent
 * on several markets is walked market by market: the delta limit holds on
 * each, so the claim is the largest market's.
 */
import { marketOfPair } from "./markets.mjs";

/**
 * @param {object} o
 * @param {object[]} o.entries        decision log entries, oldest first
 * @param {object[]} o.strikeFills    Strike fills: { client_order_id | clientOrderId, symbol, side, size, price, time | at }
 * @param {object} o.mandate
 * @param {number} [o.toleranceBtc]   size rounding between venues
 * @param {number|Record<string, number>} [o.startDeltaBtc]  net delta the agent carried into this run, one number for its first market or one per symbol
 * @param {number} [o.now]            ms; a fill still inside its hedge deadline, with an order placed, is pending rather than unhedged
 */
export function reconcile({ entries, strikeFills, mandate, toleranceBtc = 1e-8, startDeltaBtc = 0, now = Date.now() }) {
  const violations = [];
  const say = (rule, detail) => violations.push({ rule, ...detail });
  const first = mandate.strike.markets[0] ?? marketOfPair(mandate.midnight.pairs[0])?.symbol ?? "BTC-USD";
  const symbolOfPair = (pair) => (pair && marketOfPair(pair)?.symbol) || first;
  const start = typeof startDeltaBtc === "object" && startDeltaBtc ? startDeltaBtc : { [first]: startDeltaBtc };

  const fills = entries.filter((e) => e.kind === "fill");
  // every Strike order the gateway sent: a market hedge, a resting limit, and the closes and tool orders it logged as decisions
  const placed = new Map();
  for (const e of entries) {
    if (e.kind === "hedge.placed" || e.kind === "hedge.resting") placed.set(e.clientOrderId, { side: e.side, sizeBtc: e.sizeBtc, covers: e.covers ?? [] });
    else if (e.kind === "decision" && e.action?.venue === "strike" && e.action.clientOrderId) placed.set(e.action.clientOrderId, { side: e.action.side, sizeBtc: e.action.sizeBtc, covers: [] });
  }
  // a fill is hedged by a Strike fill or by a later Midnight fill of the other side (netting)
  const hedged = entries.filter((e) => e.kind === "hedge.filled" || e.kind === "hedge.netted");
  const refusals = entries.filter((e) => e.kind === "refusal");

  // every Strike fill belongs to an order the gateway sent, on an allowed market, for no more than it asked
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
  const when = (x) => Number(x.at ?? x.timestamp ?? x.time ?? (x.ts ? Date.parse(x.ts) : NaN));
  for (const f of fills) {
    const h = hedged.find((x) => x.fillId === f.id);
    if (!h) {
      const covered = [...placed.values()].some((p) => p.covers.includes(f.id));
      if (covered && now - when(f) <= mandate.risk.hedgeWithinSec * 1000) continue;
      say("unhedged-fill", { fillId: f.id, sizeBtc: f.sizeBtc, side: f.side });
      continue;
    }
    latencies.push(h.latencyMs);
    if (h.latencyMs > mandate.risk.hedgeWithinSec * 1000) say("risk.hedgeWithinSec", { fillId: f.id, latencyMs: h.latencyMs, limitMs: mandate.risk.hedgeWithinSec * 1000 });
    if (f.pair && !mandate.midnight.pairs.includes(f.pair)) say("midnight.pairs", { fillId: f.id, pair: f.pair });
  }

  // net delta over time, per market: Midnight fills move it, Strike's own fills move it back, in time order; netting moves nothing.
  // Without timestamps (old logs) the walk follows the log and the hedge.filled entries instead, on the first market.
  const markets = {}; // symbol → { maxDeltaUsd }
  const timed = fills.length > 0 && fills.every((f) => when(f) > 0) && strikeFills.every((f) => when(f) > 0);
  if (timed) {
    const marks = entries.filter((e) => e.mark && when(e) > 0).map((e) => ({ t: when(e), sym: e.action?.symbol ?? symbolOfPair(e.action?.pair ?? e.pair), mark: e.mark }));
    const markAt = (sym, t) => { let m = 0; for (const x of marks) if (x.sym === sym && x.t <= t) m = x.mark; return m || marks.find((x) => x.sym === sym)?.mark || 0; };
    const events = [
      ...fills.map((f) => ({ t: when(f), sym: symbolOfPair(f.pair), d: f.side === "buy" ? f.sizeBtc : -f.sizeBtc })),
      ...strikeFills.map((f) => ({ t: when(f), sym: f.symbol ?? first, d: String(f.side).toLowerCase() === "buy" ? Number(f.size) : -Number(f.size) })),
    ].sort((a, b) => a.t - b.t);
    const delta = {};
    for (const e of events) {
      delta[e.sym] = (delta[e.sym] ?? start[e.sym] ?? 0) + e.d;
      const m = markets[e.sym] ??= { maxDeltaUsd: 0 };
      const mark = markAt(e.sym, e.t);
      if (mark) m.maxDeltaUsd = Math.max(m.maxDeltaUsd, Math.abs(delta[e.sym]) * mark);
    }
  } else {
    let delta = start[first] ?? 0;
    let lastMark = 0;
    const m = markets[first] = { maxDeltaUsd: 0 };
    for (const e of entries) {
      if (e.mark) lastMark = e.mark;
      if (e.kind === "fill") delta += e.side === "buy" ? e.sizeBtc : -e.sizeBtc;
      else if (e.kind === "hedge.filled") delta += e.side === "buy" ? (e.sizeBtc ?? 0) : -(e.sizeBtc ?? 0);
      else continue;
      if (lastMark) m.maxDeltaUsd = Math.max(m.maxDeltaUsd, Math.abs(delta) * lastMark);
    }
  }
  for (const [sym, m] of Object.entries(markets)) if (m.maxDeltaUsd > mandate.risk.maxNetDeltaUsd + 1e-6) say("risk.maxNetDeltaUsd", { symbol: sym, maxDeltaUsd: m.maxDeltaUsd, limit: mandate.risk.maxNetDeltaUsd });
  const maxDeltaUsd = Math.max(0, ...Object.values(markets).map((m) => m.maxDeltaUsd));

  // the gateway's own refusals must all name a rule (a refused action never ran)
  for (const r of refusals) if (!r.rule) say("refusal-without-rule", { seq: r.seq });

  return {
    ok: violations.length === 0,
    violations,
    counts: { midnightFills: fills.length, hedgesPlaced: placed.size, hedgesFilled: hedged.length, strikeFills: strikeFills.length, refusals: refusals.length },
    maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
    maxDeltaUsd,
    markets,
    /** The four badge claims as non-negative numbers for prove_field_predicates_batch; the delta claim is the largest market's. */
    claims: {
      violations: violations.length,
      maxNetDeltaUsd: Math.round(maxDeltaUsd * 100) / 100,
      maxFillToHedgeSec: Math.ceil((latencies.length ? Math.max(...latencies) : 0) / 1000),
      venuesOutsideMandate: violations.filter((v) => v.rule === "strike.markets" || v.rule === "midnight.pairs").length,
    },
  };
}
