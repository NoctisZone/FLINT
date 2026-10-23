/**
 * A stand-in market maker for Strike's empty testnet book: one bid and one
 * ask around the mark from an account of ours, so the agents' hedges have
 * something to fill against. The side that reduces this account's own
 * position quotes tighter; past a position cap only that side stands. Pure:
 * it looks at the mark, the position and the resting orders and returns what
 * to cancel and what to place.
 */

const STEP_BTC = 0.00001;

/**
 * @param {object} o
 * @param {number} o.mark
 * @param {number} o.positionBtc          signed
 * @param {Array<{clientOrderId, side: "buy"|"sell", price: number}>} o.open   this account's resting orders
 * @param {number} [o.sizeBtc]
 * @param {number} [o.step]       the market's size step; BTC-USD's by default
 * @param {number} [o.spreadBps]          each side's distance from the mark
 * @param {number} [o.reduceBps]          the reducing side's distance
 * @param {number} [o.requoteBps]         replace an order whose price is this far from where it should be; default half the spread
 * @param {number} [o.tick]               price tick
 * @param {number} [o.maxPositionBtc]     past this, only the reducing side quotes
 * @param {string} [o.prefix]             clientOrderId prefix
 * @param {number} [o.now]                ms, for the clientOrderIds
 * @returns {{ cancel: string[], place: Array<{side, price, size, clientOrderId}>, wanted: {buy: number|null, sell: number|null} }}
 */
export function liquidityPlan({ mark, positionBtc = 0, open = [], sizeBtc = 0.01, spreadBps = 10, reduceBps = 5, requoteBps, tick = 0.1, step = STEP_BTC, maxPositionBtc = 0.05, prefix = "liq", now = Date.now() }) {
  const requote = (requoteBps ?? spreadBps / 2) / 10_000;
  const reducing = positionBtc > 0 ? "sell" : positionBtc < 0 ? "buy" : null;
  const capped = Math.abs(positionBtc) >= maxPositionBtc - 1e-12;
  const onTick = (x, dir) => Math.round((dir > 0 ? Math.ceil(x / tick - 1e-9) : Math.floor(x / tick + 1e-9)) * tick * 1e6) / 1e6;
  const wanted = { buy: null, sell: null };
  for (const side of ["buy", "sell"]) {
    if (capped && side !== reducing) continue;
    const bps = side === reducing ? reduceBps : spreadBps;
    // a bid rounds down, an ask up: never inside the distance it is meant to keep
    wanted[side] = side === "buy" ? onTick(mark * (1 - bps / 10_000), -1) : onTick(mark * (1 + bps / 10_000), +1);
  }
  const cancel = [];
  const place = [];
  const size = Number((Math.floor(sizeBtc / step + 1e-9) * step).toFixed(Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))));
  for (const side of ["buy", "sell"]) {
    const mine = open.filter((o) => o.side === side);
    const want = wanted[side];
    // one order a side: extras go, and so does an order that drifted off its price
    const keep = want === null ? null : mine.find((o) => Math.abs(o.price - want) / mark <= requote);
    for (const o of mine) if (o !== keep) cancel.push(o.clientOrderId);
    if (want !== null && !keep) place.push({ side, price: want, size, clientOrderId: `${prefix}-${side}-${now}` });
  }
  return { cancel, place, wanted };
}

/**
 * The sweep: an agent's hedge that has rested on Strike longer than
 * `afterMs` is taken at its own price, so a one-sided book does not leave
 * it unhedged. Reads the gateway's agents feed (each leg's `restingOrders`)
 * and returns one IOC order per resting order on `symbol` not yet in
 * `done`; the caller adds what it placed.
 *
 * @param {object} o
 * @param {Array<{agentId, legs}>} o.agents   the agents feed
 * @param {string} o.symbol
 * @param {number} [o.afterMs]                how long a hedge may rest first
 * @param {number} [o.step]                   the market's size step
 * @param {number} [o.tick]                   price tick
 * @param {string} [o.prefix]                 clientOrderId prefix
 * @param {Set<string>} [o.done]              the agents' order ids already swept
 * @param {number} [o.now]                    ms
 * @returns {Array<{side, price, size, clientOrderId, timeInForce: "IOC", agent, agentSide, restingId, restedSec}>}
 */
export function sweepPlan({ agents = [], symbol, afterMs = 60_000, step = STEP_BTC, tick = 0.1, prefix = "liq", done = new Set(), now = Date.now() }) {
  const places = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  const onStep = (x) => Number((Math.floor(x / step + 1e-9) * step).toFixed(places));
  // our price lands on the tick on the crossing side of the agent's, so the order still meets it
  const onTick = (x, dir) => Math.round((dir > 0 ? Math.ceil(x / tick - 1e-9) : Math.floor(x / tick + 1e-9)) * tick * 1e6) / 1e6;
  const out = [];
  for (const a of agents) {
    for (const o of a.legs?.[symbol]?.restingOrders ?? []) {
      const since = Date.parse(o.since);
      if (!o.clientOrderId || done.has(o.clientOrderId) || !(o.price > 0) || !(now - since >= afterMs)) continue;
      const size = onStep(Number(o.sizeBtc));
      if (size <= 0) continue;
      const side = o.side === "sell" ? "buy" : "sell";
      out.push({ side, price: onTick(Number(o.price), side === "buy" ? +1 : -1), size, clientOrderId: `${prefix}-sweep-${o.clientOrderId}`, timeInForce: "IOC", agent: a.agentId, agentSide: o.side, restingId: o.clientOrderId, restedSec: Math.round((now - since) / 1000) });
    }
  }
  return out;
}
