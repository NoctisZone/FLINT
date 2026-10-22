/**
 * The nine checks every action passes before the gateway builds anything,
 * in a fixed order; the first failure is the refusal, with the rule, the
 * limit and the attempted value. A hedge, close or quote that brings net
 * delta toward zero skips the size, position, delta, loss and rate limits,
 * never the price checks: its price must still sit inside the band.
 *
 * Sizes are in BTC, prices and limits in USD. Net delta is the agent's
 * Midnight inventory plus its Strike position, in BTC, signed.
 */
import { mandateProblems } from "./mandate.mjs";

/**
 * @typedef {object} Action
 * @prop {"strike"|"midnight"} venue
 * @prop {"order"|"quote"|"take"|"cancel"} kind   cancel is never refused
 * @prop {string} [symbol]       Strike market, e.g. BTC-USD
 * @prop {string} [pair]         Midnight pair, e.g. tBTC/tUSD
 * @prop {"buy"|"sell"|"bid"|"ask"} side   a bid buys BTC, an ask sells it
 * @prop {number} sizeBtc
 * @prop {number} [price]        limit price; a Strike market order has none
 * @prop {number} [ttlSec]       quote expiry
 * @prop {boolean} [reduceOnly]
 *
 * @typedef {object} State
 * @prop {object} mandate
 * @prop {boolean} signatureOk
 * @prop {boolean} frozen
 * @prop {number} now                      ms
 * @prop {number} mark                     Strike mark price
 * @prop {number} strikePositionBtc        signed
 * @prop {number} leverage                 the symbol's leverage
 * @prop {number} midnightInventoryBtc     tBTC held
 * @prop {number} unhedgedBtc              fills not yet hedged, signed
 * @prop {number} openQuotes
 * @prop {number} equityStartUsd           at 00:00 UTC
 * @prop {number} equityNowUsd
 * @prop {number} actionsLastMinute
 */

const refusal = (rule, limit, attempted, message) => ({ rule, limit, attempted, message });
const EPS = 1e-9;
const STEP_BTC = 0.00001; // Strike's size step: less than that across zero is dust, not a position

/** +size buys BTC, −size sells it. */
export function signedSize(a) {
  return (a.side === "buy" || a.side === "bid") ? a.sizeBtc : -a.sizeBtc;
}

export const netDeltaBtc = (s) => s.midnightInventoryBtc + s.strikePositionBtc;

/** True when the action moves net delta toward zero without crossing it by more than dust; a quote counts as if it filled. */
export function reducesDelta(a, s) {
  if (a.kind === "cancel" || !(a.sizeBtc > 0)) return false;
  const before = netDeltaBtc(s);
  const after = before + signedSize(a);
  return Math.abs(after) < Math.abs(before) - EPS && (Math.sign(after) !== -Math.sign(before) || Math.abs(after) < STEP_BTC);
}

/** @returns {null | {rule, limit, attempted, message}} */
export function check(a, s) {
  const m = s.mandate;
  // 1. mandate itself
  const problems = mandateProblems(m);
  if (problems.length) return refusal("mandate", "well formed", problems.join(", "), "mandate is not well formed");
  if (!s.signatureOk) return refusal("signature", "owner signature over the mandate hash", "invalid", "the owner has not signed this mandate");
  if (Date.parse(m.expiry) <= s.now) return refusal("expiry", m.expiry, new Date(s.now).toISOString(), "the mandate has expired");
  if (a.kind === "cancel") return null;
  const reducing = reducesDelta(a, s);
  if (s.frozen && !reducing) return refusal("frozen", "quoting and opening are frozen", a.kind, "the agent is frozen; only orders that reduce net delta pass");
  // 2. venue, market, pair
  if (a.venue === "strike" && !m.strike.markets.includes(a.symbol)) return refusal("strike.markets", m.strike.markets.join(","), a.symbol ?? "", "market not in the mandate");
  if (a.venue === "midnight" && !m.midnight.pairs.includes(a.pair)) return refusal("midnight.pairs", m.midnight.pairs.join(","), a.pair ?? "", "pair not in the mandate");
  if (!(a.sizeBtc > 0)) return refusal("size", "> 0", a.sizeBtc, "size must be positive");
  // 3. price: a Strike limit inside the band; a quote on the right side of the mark, per-side distance inside the spread band
  if (a.venue === "strike" && a.price !== undefined) {
    const offPct = Math.abs(a.price - s.mark) / s.mark * 100;
    if (offPct > m.strike.priceBandPct + EPS) return refusal("strike.priceBandPct", m.strike.priceBandPct, round(offPct, 3), "limit price too far from the Strike mark");
  }
  if (a.venue === "midnight" && a.kind === "quote") {
    const spreadBps = (a.side === "ask" ? (a.price - s.mark) : (s.mark - a.price)) / s.mark * 10_000;
    if (spreadBps < m.midnight.minSpreadBps - EPS) return refusal("midnight.minSpreadBps", m.midnight.minSpreadBps, round(spreadBps, 2), "quote inside the minimum spread, or on the wrong side of the mark");
    if (spreadBps > m.midnight.maxSpreadBps + EPS) return refusal("midnight.maxSpreadBps", m.midnight.maxSpreadBps, round(spreadBps, 2), "quote outside the maximum spread");
  }
  if (reducing) return null;
  const notional = a.sizeBtc * s.mark;
  // 4. size
  if (a.venue === "midnight" && notional > m.midnight.maxQuoteUsd + EPS) return refusal("midnight.maxQuoteUsd", m.midnight.maxQuoteUsd, round(notional), "quote larger than the mandate allows");
  if (a.venue === "strike" && notional > m.strike.maxPositionUsd + EPS) return refusal("strike.maxPositionUsd", m.strike.maxPositionUsd, round(notional), "order larger than the position cap");
  // 5. Strike position and leverage after the action
  if (a.venue === "strike") {
    const posAfter = Math.abs(s.strikePositionBtc + signedSize(a)) * s.mark;
    if (posAfter > m.strike.maxPositionUsd + EPS) return refusal("strike.maxPositionUsd", m.strike.maxPositionUsd, round(posAfter), "position after the order above the cap");
    if (s.leverage > m.strike.maxLeverage) return refusal("strike.maxLeverage", m.strike.maxLeverage, s.leverage, "leverage above the mandate");
  }
  // 6. open quotes and expiry
  if (a.venue === "midnight" && a.kind === "quote") {
    if (s.openQuotes >= m.midnight.maxOpenQuotes) return refusal("midnight.maxOpenQuotes", m.midnight.maxOpenQuotes, s.openQuotes + 1, "too many open quotes");
    if ((a.ttlSec ?? 0) > m.midnight.quoteTtlSec) return refusal("midnight.quoteTtlSec", m.midnight.quoteTtlSec, a.ttlSec, "quote lives longer than the mandate allows");
  }
  // 7. net delta after the action; inventory already holds the unhedged fills
  const deltaAfter = Math.abs(netDeltaBtc(s) + signedSize(a)) * s.mark;
  if (deltaAfter > m.risk.maxNetDeltaUsd + EPS) return refusal("risk.maxNetDeltaUsd", m.risk.maxNetDeltaUsd, round(deltaAfter), "net delta after the action above the limit");
  // 8. daily loss stop
  if (s.equityStartUsd > 0) {
    const lossPct = (s.equityStartUsd - s.equityNowUsd) / s.equityStartUsd * 100;
    if (lossPct >= m.risk.dailyLossStopPct - EPS) return refusal("risk.dailyLossStopPct", m.risk.dailyLossStopPct, round(lossPct, 3), "daily loss stop reached");
  }
  // 9. rate
  if (s.actionsLastMinute >= m.risk.maxActionsPerMin) return refusal("risk.maxActionsPerMin", m.risk.maxActionsPerMin, s.actionsLastMinute + 1, "too many actions this minute");
  return null;
}

const round = (x, d = 2) => Number(x.toFixed(d));
