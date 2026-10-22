/**
 * Hedge on fill: every Midnight fill opens exposure that a Strike order of
 * the opposite sign closes. The hedger keeps the agent's delta books as a
 * queue of exposures, nets a new fill against exposures of the other side,
 * places one Strike order for what is left, matches Strike fills back to
 * the exposures they close, rests a limit when the market has no liquidity,
 * and freezes the agent when a hedge misses its deadline. The freeze lifts
 * by itself once nothing is left unhedged.
 *
 * An exposure whose market order is still in flight is not netted: the
 * order may fill any moment. Once the order is decided, what its exposure
 * can net is netted, and only the rest goes back to Strike as a limit.
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
 * @param {(hedged: {fill, hedge, latencyMs}) => void} [o.onHedged]   a Midnight fill is fully hedged (or netted, or closed as dust)
 * @param {boolean} [o.ownAccount]          false when the Strike key is shared: position events then describe other agents too and are ignored
 */
export function hedger({ mandate, symbol, strike, check = defaultCheck, log = () => {}, now = Date.now, state: init = {}, stepBtc = 0.00001, minNotionalUsd = 0, dustUsd = 5, onChange = () => {}, onHedged = () => {}, ownAccount = true }) {
  const s = {
    mandate, signatureOk: true, frozen: false, frozenReason: null, manual: false,
    mark: 0, strikePositionBtc: 0, leverage: mandate.strike.maxLeverage, midnightInventoryBtc: 0, unhedgedBtc: 0,
    openQuotes: 0, equityStartUsd: 0, equityNowUsd: 0, actionsLastMinute: 0,
    ...init,
  };
  // what is still unhedged, oldest first; a carried book from the last run is one exposure without a fill
  const exposures = [];
  if (Math.abs(s.unhedgedBtc) >= stepBtc) exposures.push({ fill: { id: `carry-${now()}`, side: s.unhedgedBtc > 0 ? "buy" : "sell", sizeBtc: Math.abs(s.unhedgedBtc), at: now() }, remaining: s.unhedgedBtc, at: now(), parts: [], coveredBy: null });
  const pending = new Map(); // clientOrderId → { side, sizeBtc, filledBtc, resting, deadline, placedAt, lateLogged }
  const done = [];           // { fill, hedge, latencyMs }
  let seq = 0;
  let restDue = null;        // a dead market order whose exposure waits for the other in-flight order before it rests
  // covered: a market order for this exposure is in flight; a resting limit is pulled before anything else happens, so it does not cover
  const covered = (e) => e.coveredBy !== null && pending.has(e.coveredBy) && !pending.get(e.coveredBy).resting;
  const inflightOf = () => [...pending.values()].filter((p) => !p.resting);
  const mine = (clientOrderId) => typeof clientOrderId === "string" && clientOrderId.startsWith(`${mandate.agentId}-`);

  const view = () => ({ ...s, mark: strike.mark(), now: now() });
  const snapshot = () => ({ midnightInventoryBtc: s.midnightInventoryBtc, strikePositionBtc: s.strikePositionBtc, unhedgedBtc: s.unhedgedBtc, frozen: s.frozen, frozenReason: s.frozenReason });
  const changed = () => onChange(snapshot());
  const recount = () => { s.unhedgedBtc = r8(exposures.reduce((a, e) => a + e.remaining, 0)); };

  /** A fill is hedged: the parts that closed it (netting, Strike fills, dust) summed into one record. */
  function hedged(fill, parts, at) {
    const latencyMs = at - fill.at;
    const largest = parts.reduce((m, p) => (p.sizeBtc > m.sizeBtc ? p : m), parts[0]);
    const priced = parts.filter((p) => p.price !== null);
    const price = priced.length ? Math.round(priced.reduce((a, p) => a + p.price * p.sizeBtc, 0) / priced.reduce((a, p) => a + p.sizeBtc, 0) * 10) / 10 : null;
    const clientOrderIds = [...new Set(parts.map((p) => p.clientOrderId).filter(Boolean))];
    const h = { fill, hedge: { how: largest.how, clientOrderIds, clientOrderId: clientOrderIds.at(-1) ?? null, price, sizeBtc: fill.sizeBtc, at, parts }, latencyMs };
    done.push(h);
    onHedged(h);
    return h;
  }

  function closeIfDone(e, how, at, price, clientOrderId, sign) {
    if (Math.abs(e.remaining) >= stepBtc) return;
    const h = hedged(e.fill, e.parts, at);
    log({ kind: how === "netted" ? "hedge.netted" : "hedge.filled", agent: mandate.agentId, fillId: e.fill.id, clientOrderId, price, latencyMs: h.latencyMs, side: sign > 0 ? "sell" : "buy", sizeBtc: e.fill.sizeBtc });
  }
  const sweep = () => { for (let i = exposures.length - 1; i >= 0; i--) if (Math.abs(exposures[i].remaining) < stepBtc) exposures.splice(i, 1); recount(); };

  /** Close exposures of `sign` with `amount` BTC, oldest first; each closed one is a finished hedge. Netting skips covered ones. */
  function consume(sign, amount, how, at, price = null, clientOrderId = null) {
    let left = amount;
    for (const e of exposures) {
      if (left <= EPS || Math.sign(e.remaining) !== sign || (how === "netted" && covered(e))) continue;
      const take = Math.min(Math.abs(e.remaining), left);
      e.remaining = r8(e.remaining - sign * take);
      left -= take;
      e.parts.push({ how, clientOrderId, price: price === null ? null : Number(price), sizeBtc: r8(take) });
      // less than one Strike step left is dust: closed, it stays in the inventory
      closeIfDone(e, how, at, price, clientOrderId, sign);
    }
    sweep();
    return left;
  }

  /** Uncovered exposures of opposite signs close each other, oldest first. */
  function netUncovered(at) {
    for (;;) {
      const pos = exposures.find((e) => !covered(e) && e.remaining > 0);
      const neg = exposures.find((e) => !covered(e) && e.remaining < 0);
      if (!pos || !neg) break;
      const take = r8(Math.min(pos.remaining, -neg.remaining));
      for (const e of [pos, neg]) {
        const sign = Math.sign(e.remaining);
        e.remaining = r8(e.remaining - sign * take);
        e.parts.push({ how: "netted", clientOrderId: null, price: null, sizeBtc: take });
        closeIfDone(e, "netted", at, null, null, sign);
      }
      sweep();
    }
  }

  async function onFill(fill) {
    // fill: { id, pair, side: "sell"|"buy" (what the agent did with tBTC), sizeBtc, price, txHash, at }
    const signed = fill.side === "buy" ? fill.sizeBtc : -fill.sizeBtc;
    s.midnightInventoryBtc = r8(s.midnightInventoryBtc + signed);
    log({ kind: "fill", ...fill });
    // a fill on the other side closes older exposure before anything goes to Strike
    const left = consume(-Math.sign(signed), Math.abs(signed), "netted", fill.at);
    // the part of this fill that closed older exposure is hedged on arrival
    const netted = r8(Math.abs(signed) - left);
    if (netted > EPS) log({ kind: "hedge.netted", agent: mandate.agentId, fillId: fill.id, latencyMs: 0, side: fill.side, sizeBtc: netted, by: "netting" });
    const parts = netted > EPS ? [{ how: "netted", clientOrderId: null, price: null, sizeBtc: netted }] : [];
    if (left >= stepBtc) exposures.push({ fill, remaining: r8(Math.sign(signed) * left), at: fill.at, parts, coveredBy: null });
    else if (netted > EPS) hedged(fill, parts, fill.at);
    recount();
    changed();
    return rebalance();
  }

  /**
   * One Strike order for everything unhedged and uncovered; resting orders are
   * pulled first so nothing is hedged twice. `rest` places a limit at the
   * edge of the price band instead of a market order, for a market order
   * that found no liquidity.
   */
  async function rebalance({ rest = null } = {}) {
    for (const [id, p] of [...pending.entries()]) {
      if (!p.resting) continue;
      pending.delete(id);
      await strike.cancel?.({ symbol, clientOrderId: id }).catch((err) => log({ kind: "hedge.cancel.failed", agent: mandate.agentId, clientOrderId: id, error: err.message }));
      log({ kind: "hedge.pulled", agent: mandate.agentId, clientOrderId: id });
    }
    netUncovered(now());
    // a market order still in flight counts as hedged already
    const inflight = inflightOf().reduce((a, p) => a + (p.side === "sell" ? 1 : -1) * (p.sizeBtc - p.filledBtc), 0);
    const uncovered = r8(exposures.filter((e) => !covered(e)).reduce((a, e) => a + e.remaining, 0));
    let need = r8(s.unhedgedBtc - inflight);
    // never counter an order in flight: only what uncovered exposure asks for is placed
    if (Math.sign(need) !== Math.sign(uncovered)) need = 0;
    need = r8(Math.sign(need) * Math.min(Math.abs(need), Math.abs(uncovered)));
    if (Math.abs(need) < stepBtc) { restDue = null; settle(); return { placed: false }; }
    // the rest for a dead order waits while another order flies: that one may net it when it is decided
    if (rest && inflightOf().length) { restDue = rest; return { placed: false, waiting: true }; }
    // a few dollars of exposure are not worth an order: closed as dust, the inventory keeps them
    if (Math.abs(need) * strike.mark() < dustUsd && pending.size === 0) {
      log({ kind: "dust", agent: mandate.agentId, unhedgedBtc: need, dustUsd });
      for (const e of exposures) hedged(e.fill, [...e.parts, { how: "dust", clientOrderId: null, price: null, sizeBtc: r8(Math.abs(e.remaining)) }], now());
      exposures.length = 0;
      recount();
      settle();
      return { placed: false, dust: true };
    }
    // the hedge brings net delta toward zero and at most one step across it: a hedge one step short would leave the fill open
    const net = s.midnightInventoryBtc + s.strikePositionBtc + inflight;
    const most = Math.sign(need) === Math.sign(net) && Math.abs(net) < Math.abs(need) - stepBtc + 1e-12 ? Math.abs(net) : Math.abs(need);
    const sizeBtc = r8(Math.floor(most / stepBtc + 1e-9) * stepBtc);
    if (sizeBtc * strike.mark() < minNotionalUsd) {
      log({ kind: "carry.small", agent: mandate.agentId, unhedgedBtc: need, minNotionalUsd });
      // too small for Strike and nothing in flight: a freeze could not change that, so quoting goes on and the next fill nets or completes it
      if (s.frozen && !s.manual && pending.size === 0) { s.frozen = false; s.frozenReason = null; log({ kind: "resumed", agent: mandate.agentId, reason: "carried exposure under Strike's minimum order" }); changed(); }
      return { placed: false, small: true };
    }
    const side = need > 0 ? "sell" : "buy";
    // a limit sits at the edge of the price band, rounded toward the mark so the band check passes
    const mark = strike.mark();
    const price = rest ? (side === "sell" ? Math.ceil(mark * (1 - mandate.strike.priceBandPct / 100)) : Math.floor(mark * (1 + mandate.strike.priceBandPct / 100))) : undefined;
    const action = { venue: "strike", kind: "order", symbol, side, sizeBtc, price, hedge: true };
    const refused = check(action, view());
    if (refused) {
      log({ kind: "refusal", agent: mandate.agentId, action, ...refused });
      freeze(`hedge refused: ${refused.rule}`);
      return { placed: false, refused };
    }
    const mineToCover = exposures.filter((e) => !covered(e) && Math.sign(e.remaining) === Math.sign(need));
    const oldest = mineToCover.reduce((m, e) => Math.min(m, e.at), now());
    const clientOrderId = rest ? `${rest}-L` : `${mandate.agentId}-hedge-${++seq}-${now()}`;
    const p = { side, sizeBtc, filledBtc: 0, resting: Boolean(rest), deadline: oldest + mandate.risk.hedgeWithinSec * 1000, placedAt: now(), lateLogged: false };
    pending.set(clientOrderId, p);
    for (const e of mineToCover) e.coveredBy = rest ? null : clientOrderId;
    restDue = null;
    try {
      if (rest) await strike.placeOrder({ symbol, side, type: "limit", size: sizeBtc, price, timeInForce: "GTC", clientOrderId, reduceOnly: false });
      else await strike.placeOrder({ symbol, side, type: "market", size: sizeBtc, clientOrderId, reduceOnly: false });
      if (rest) log({ kind: "hedge.resting", agent: mandate.agentId, clientOrderId, side, sizeBtc, price });
      else log({ kind: "hedge.placed", agent: mandate.agentId, clientOrderId, side, sizeBtc, covers: mineToCover.map((e) => e.fill.id), deadline: new Date(p.deadline).toISOString() });
      return { placed: true, clientOrderId };
    } catch (err) {
      pending.delete(clientOrderId);
      for (const e of mineToCover) if (e.coveredBy === clientOrderId) e.coveredBy = null;
      log({ kind: "hedge.failed", agent: mandate.agentId, error: err.message });
      freeze(`${rest ? "limit " : ""}hedge not placed: ${err.message}`);
      return { placed: false, error: err.message };
    }
  }

  /** A Strike stream event (see strike-stream.mjs classify). */
  async function onStrikeEvent(e) {
    try { await strikeEvent(e); } finally { changed(); }
  }

  async function strikeEvent(e) {
    if (e.kind === "fill") {
      // another agent's fill on a shared account is not this agent's position
      if (!mine(e.clientOrderId)) return;
      const size = Number(e.size);
      s.strikePositionBtc = r8(s.strikePositionBtc + (e.side === "BUY" ? size : -size));
      const p = pending.get(e.clientOrderId);
      if (!p) return;
      p.filledBtc = r8(p.filledBtc + size);
      consume(p.side === "sell" ? 1 : -1, size, p.resting ? "limit" : "market", e.at, e.price, e.clientOrderId);
      if (p.filledBtc + EPS >= p.sizeBtc) pending.delete(e.clientOrderId);
      // the order a deferred rest waited for is decided: rest now
      if (restDue && !inflightOf().length) return rebalance({ rest: restDue });
      settle();
    } else if (e.kind === "order" && e.terminal && e.status !== "FILLED") {
      const p = pending.get(e.clientOrderId);
      if (!p) return;
      pending.delete(e.clientOrderId);
      for (const x of exposures) if (x.coveredBy === e.clientOrderId) x.coveredBy = null;
      log({ kind: "hedge.lost", agent: mandate.agentId, clientOrderId: e.clientOrderId, status: e.status, closeReason: e.closeReason });
      // a market order the engine canceled or expired found no liquidity: what cannot be netted rests as a limit
      if (!p.resting && e.status !== "REJECTED") return rebalance({ rest: e.clientOrderId });
      freeze(`hedge ${e.status.toLowerCase()}${e.closeReason ? `: ${e.closeReason}` : ""}`);
    } else if (e.kind === "position" && ownAccount) {
      s.strikePositionBtc = Number(e.size);
    }
  }

  /**
   * A pending order looked up over REST after the stream was away: fills the
   * stream missed are applied, and a terminal order is closed out.
   */
  async function syncOrder({ clientOrderId, status, filledBtc, price = null, closeReason = null, at = now() }) {
    const p = pending.get(clientOrderId);
    if (!p) return;
    const missed = r8(Number(filledBtc) - p.filledBtc);
    if (missed >= stepBtc) await strikeEvent({ kind: "fill", symbol, clientOrderId, side: p.side.toUpperCase(), size: String(missed), price, at });
    if (["CANCELED", "REJECTED", "EXPIRED"].includes(status)) await strikeEvent({ kind: "order", symbol, clientOrderId, status, terminal: true, closeReason, at });
    changed();
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
    onFill, onStrikeEvent, syncOrder, tick, freeze, snapshot,
    /** Hedge what the books carry from the last run. */
    rehedge: () => { if (exposures.length) log({ kind: "carry", agent: mandate.agentId, unhedgedBtc: s.unhedgedBtc }); return rebalance(); },
    resume() { s.frozen = false; s.frozenReason = null; s.manual = false; log({ kind: "resumed", agent: mandate.agentId }); changed(); },
    get state() { return view(); },
    get pending() { return [...pending.entries()].map(([id, p]) => ({ clientOrderId: id, side: p.side, sizeBtc: p.sizeBtc, filledBtc: p.filledBtc, resting: p.resting, deadline: p.deadline, placedAt: p.placedAt })); },
    get exposures() { return exposures.map((e) => ({ fillId: e.fill.id, remaining: e.remaining, at: e.at, coveredBy: covered(e) ? e.coveredBy : null })); },
    get hedges() { return done.slice(); },
    get maxLatencyMs() { return done.reduce((m, h) => Math.max(m, h.latencyMs), 0); },
  };
}

export { signedSize };
