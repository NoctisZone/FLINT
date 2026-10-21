/**
 * Hedge on fill: every Midnight fill opens exposure that a Strike order of
 * the opposite sign closes. The hedger keeps the agent's delta books as a
 * queue of exposures, nets a new fill against exposures of the other side,
 * places one Strike order for what is left, matches Strike fills back to
 * the exposures they close, rests a limit when the market has no liquidity,
 * and freezes the agent when a hedge misses its deadline. The freeze lifts
 * by itself once nothing is left unhedged.
 *
 * Chain-free: `strike.placeOrder`, `strike.cancel` and `strike.mark` are
 * injected, as are `check`, `log` and `now`.
 */
import { check as defaultCheck, signedSize } from "./checks.mjs";

const EPS = 1e-12;
const r8 = (x) => Math.round(x * 1e8) / 1e8;

/**
 * @param {object} o
 * @param {object} o.mandate
 * @param {string} o.symbol                 Strike market to hedge on
 * @param {(order) => Promise<object>} o.strike.placeOrder
 * @param {(o: {clientOrderId}) => Promise<object>} [o.strike.cancel]
 * @param {() => number} o.strike.mark      current mark price
 * @param {(action, state) => (null|object)} [o.check]
 * @param {(entry) => void} [o.log]
 * @param {() => number} [o.now]            ms
 * @param {object} [o.state]                books from the last run
 * @param {number} [o.stepBtc]              Strike's size step
 * @param {number} [o.minNotionalUsd]       Strike's smallest order
 * @param {(snapshot) => void} [o.onChange]
 */
export function hedger({ mandate, symbol, strike, check = defaultCheck, log = () => {}, now = Date.now, state: init = {}, stepBtc = 0.00001, minNotionalUsd = 0, dustUsd = 5, onChange = () => {} }) {
  const s = {
    mandate, signatureOk: true, frozen: false, frozenReason: null, manual: false,
    mark: 0, strikePositionBtc: 0, leverage: mandate.strike.maxLeverage, midnightInventoryBtc: 0, unhedgedBtc: 0,
    openQuotes: 0, equityStartUsd: 0, equityNowUsd: 0, actionsLastMinute: 0,
    ...init,
  };
  // what is still unhedged, oldest first; a carried book from the last run is one exposure without a fill
  const exposures = [];
  if (Math.abs(s.unhedgedBtc) >= stepBtc) exposures.push({ fill: { id: `carry-${now()}`, side: s.unhedgedBtc > 0 ? "buy" : "sell", sizeBtc: Math.abs(s.unhedgedBtc), at: now() }, remaining: s.unhedgedBtc, at: now() });
  const pending = new Map(); // clientOrderId → { side, sizeBtc, filledBtc, resting, deadline, placedAt, lateLogged }
  const done = [];           // { fill, hedge, latencyMs }
  let seq = 0;

  const view = () => ({ ...s, mark: strike.mark(), now: now() });
  const snapshot = () => ({ midnightInventoryBtc: s.midnightInventoryBtc, strikePositionBtc: s.strikePositionBtc, unhedgedBtc: s.unhedgedBtc, frozen: s.frozen, frozenReason: s.frozenReason });
  const changed = () => onChange(snapshot());
  const recount = () => { s.unhedgedBtc = r8(exposures.reduce((a, e) => a + e.remaining, 0)); };

  /** Close exposures of `sign` with `amount` BTC, oldest first; each closed one is a finished hedge. */
  function consume(sign, amount, how, at, price = null, clientOrderId = null) {
    let left = amount;
    for (const e of exposures) {
      if (left <= EPS || Math.sign(e.remaining) !== sign) continue;
      const take = Math.min(Math.abs(e.remaining), left);
      e.remaining = r8(e.remaining - sign * take);
      left -= take;
      // less than one Strike step left is dust: closed, it stays in the inventory
      if (Math.abs(e.remaining) < stepBtc) {
        const latencyMs = at - e.at;
        done.push({ fill: e.fill, hedge: { how, clientOrderId, price, sizeBtc: e.fill.sizeBtc, at }, latencyMs });
        log({ kind: how === "netted" ? "hedge.netted" : "hedge.filled", agent: mandate.agentId, fillId: e.fill.id, clientOrderId, price, latencyMs, side: sign > 0 ? "sell" : "buy", sizeBtc: e.fill.sizeBtc });
      }
    }
    for (let i = exposures.length - 1; i >= 0; i--) if (Math.abs(exposures[i].remaining) < stepBtc) exposures.splice(i, 1);
    recount();
    return left;
  }

  async function onFill(fill) {
    // fill: { id, pair, side: "sell"|"buy" (what the agent did with tBTC), sizeBtc, price, txHash, at }
    const signed = fill.side === "buy" ? fill.sizeBtc : -fill.sizeBtc;
    s.midnightInventoryBtc = r8(s.midnightInventoryBtc + signed);
    log({ kind: "fill", ...fill });
    // a fill on the other side closes older exposure before anything goes to Strike
    const left = consume(-Math.sign(signed), Math.abs(signed), "netted", fill.at);
    // the part of this fill that closed older exposure is hedged on arrival
    if (Math.abs(signed) - left > EPS) log({ kind: "hedge.netted", agent: mandate.agentId, fillId: fill.id, latencyMs: 0, side: fill.side, sizeBtc: r8(Math.abs(signed) - left), by: "netting" });
    if (left > EPS) exposures.push({ fill, remaining: r8(Math.sign(signed) * left), at: fill.at });
    recount();
    changed();
    return rebalance();
  }

  /** One Strike order for everything unhedged; resting orders are pulled first so nothing is hedged twice. */
  async function rebalance() {
    for (const [id, p] of [...pending.entries()]) {
      if (!p.resting) continue;
      pending.delete(id);
      await strike.cancel?.({ symbol, clientOrderId: id }).catch((err) => log({ kind: "hedge.cancel.failed", agent: mandate.agentId, clientOrderId: id, error: err.message }));
      log({ kind: "hedge.pulled", agent: mandate.agentId, clientOrderId: id });
    }
    // a market order still in flight counts as hedged already
    const inflight = [...pending.values()].reduce((a, p) => a + (p.side === "sell" ? 1 : -1) * (p.sizeBtc - p.filledBtc), 0);
    const need = r8(s.unhedgedBtc - inflight);
    if (Math.abs(need) < stepBtc) { settle(); return { placed: false }; }
    // a few dollars of exposure are not worth an order: closed as dust, the inventory keeps them
    if (Math.abs(need) * strike.mark() < dustUsd && pending.size === 0) {
      log({ kind: "dust", agent: mandate.agentId, unhedgedBtc: need, dustUsd });
      exposures.length = 0;
      recount();
      settle();
      return { placed: false, dust: true };
    }
    // the hedge brings net delta toward zero and never across it: the dust in the inventory is not hedged
    const net = s.midnightInventoryBtc + s.strikePositionBtc + inflight;
    const most = Math.sign(need) === Math.sign(net) ? Math.min(Math.abs(need), Math.abs(net)) : Math.abs(need);
    const sizeBtc = r8(Math.floor(most / stepBtc + 1e-9) * stepBtc);
    if (sizeBtc * strike.mark() < minNotionalUsd) {
      log({ kind: "carry.small", agent: mandate.agentId, unhedgedBtc: need, minNotionalUsd });
      return { placed: false, small: true };
    }
    const side = need > 0 ? "sell" : "buy";
    const action = { venue: "strike", kind: "order", symbol, side, sizeBtc, hedge: true };
    const refused = check(action, view());
    if (refused) {
      log({ kind: "refusal", agent: mandate.agentId, action, ...refused });
      freeze(`hedge refused: ${refused.rule}`);
      return { placed: false, refused };
    }
    const oldest = exposures.reduce((m, e) => Math.min(m, e.at), now());
    const clientOrderId = `${mandate.agentId}-hedge-${++seq}-${now()}`;
    const p = { side, sizeBtc, filledBtc: 0, resting: false, deadline: oldest + mandate.risk.hedgeWithinSec * 1000, placedAt: now(), lateLogged: false };
    pending.set(clientOrderId, p);
    try {
      await strike.placeOrder({ symbol, side, type: "market", size: sizeBtc, clientOrderId, reduceOnly: false });
      log({ kind: "hedge.placed", agent: mandate.agentId, clientOrderId, side, sizeBtc, covers: exposures.map((e) => e.fill.id), deadline: new Date(p.deadline).toISOString() });
      return { placed: true, clientOrderId };
    } catch (err) {
      pending.delete(clientOrderId);
      log({ kind: "hedge.failed", agent: mandate.agentId, error: err.message });
      freeze(`hedge not placed: ${err.message}`);
      return { placed: false, error: err.message };
    }
  }

  /** The market order found no liquidity: rest a limit at the edge of the price band for what is left. */
  async function restLimit(p, marketId) {
    const left = r8(Math.floor((p.sizeBtc - p.filledBtc) / stepBtc + 1e-9) * stepBtc);
    if (left < stepBtc) return;
    const mark = strike.mark();
    const price = Math.round(p.side === "sell" ? mark * (1 - mandate.strike.priceBandPct / 100) : mark * (1 + mandate.strike.priceBandPct / 100));
    const clientOrderId = `${marketId}-L`;
    pending.set(clientOrderId, { ...p, sizeBtc: left, filledBtc: 0, resting: true, placedAt: now() });
    try {
      await strike.placeOrder({ symbol, side: p.side, type: "limit", size: left, price, timeInForce: "GTC", clientOrderId, reduceOnly: false });
      log({ kind: "hedge.resting", agent: mandate.agentId, clientOrderId, side: p.side, sizeBtc: left, price });
    } catch (err) {
      pending.delete(clientOrderId);
      log({ kind: "hedge.failed", agent: mandate.agentId, error: err.message });
      freeze(`limit hedge not placed: ${err.message}`);
    }
  }

  /** A Strike stream event (see strike-stream.mjs classify). */
  async function onStrikeEvent(e) {
    try { await strikeEvent(e); } finally { changed(); }
  }

  async function strikeEvent(e) {
    if (e.kind === "fill") {
      const size = Number(e.size);
      s.strikePositionBtc = r8(s.strikePositionBtc + (e.side === "BUY" ? size : -size));
      const p = pending.get(e.clientOrderId);
      if (!p) return;
      p.filledBtc = r8(p.filledBtc + size);
      consume(p.side === "sell" ? 1 : -1, size, p.resting ? "limit" : "market", e.at, e.price, e.clientOrderId);
      if (p.filledBtc + EPS >= p.sizeBtc) pending.delete(e.clientOrderId);
      settle();
    } else if (e.kind === "order" && e.terminal && e.status !== "FILLED") {
      const p = pending.get(e.clientOrderId);
      if (!p) return;
      pending.delete(e.clientOrderId);
      log({ kind: "hedge.lost", agent: mandate.agentId, clientOrderId: e.clientOrderId, status: e.status, closeReason: e.closeReason });
      if (e.closeReason === "market_order_exceeded_slippage" && !p.resting) return restLimit(p, e.clientOrderId);
      freeze(`hedge ${e.status.toLowerCase()}${e.closeReason ? `: ${e.closeReason}` : ""}`);
    } else if (e.kind === "position") {
      s.strikePositionBtc = Number(e.size);
    }
  }

  /** The watchdog: a hedge past its deadline freezes the agent, once. Returns the overdue ones. */
  function tick() {
    const t = now();
    const late = [...pending.entries()].filter(([, p]) => t > p.deadline);
    for (const [id, p] of late) {
      if (p.lateLogged) continue;
      p.lateLogged = true;
      log({ kind: "hedge.late", agent: mandate.agentId, clientOrderId: id, lateMs: t - p.deadline, resting: p.resting });
      freeze(`hedge not filled within ${mandate.risk.hedgeWithinSec}s`);
    }
    return late.map(([id]) => id);
  }

  /** Nothing unhedged and nothing pending: an automatic freeze is over. */
  function settle() {
    if (s.frozen && !s.manual && exposures.length === 0 && pending.size === 0) {
      s.frozen = false;
      s.frozenReason = null;
      log({ kind: "resumed", agent: mandate.agentId, reason: "nothing left unhedged" });
    }
  }

  function freeze(reason, { manual = false } = {}) {
    if (s.frozen) return;
    s.frozen = true;
    s.frozenReason = reason;
    s.manual = manual;
    log({ kind: "frozen", agent: mandate.agentId, reason });
    changed();
  }

  return {
    onFill, onStrikeEvent, tick, freeze, snapshot,
    /** Hedge what the books carry from the last run. */
    rehedge: () => { if (exposures.length) log({ kind: "carry", agent: mandate.agentId, unhedgedBtc: s.unhedgedBtc }); return rebalance(); },
    resume() { s.frozen = false; s.frozenReason = null; s.manual = false; log({ kind: "resumed", agent: mandate.agentId }); changed(); },
    get state() { return view(); },
    get pending() { return [...pending.entries()].map(([id, p]) => ({ clientOrderId: id, side: p.side, sizeBtc: p.sizeBtc, filledBtc: p.filledBtc, resting: p.resting, deadline: p.deadline })); },
    get exposures() { return exposures.map((e) => ({ fillId: e.fill.id, remaining: e.remaining, at: e.at })); },
    get hedges() { return done.slice(); },
    get maxLatencyMs() { return done.reduce((m, h) => Math.max(m, h.latencyMs), 0); },
  };
}

export { signedSize };
