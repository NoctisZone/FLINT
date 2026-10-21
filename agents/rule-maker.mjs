/**
 * The rule-based market maker's mind: a bid and an ask around the Strike
 * mark at a fixed spread, sized inside the mandate and the wallet, requoted
 * when the mark has moved more than half the spread. Pure: it looks at a
 * view and returns the actions the gateway should take.
 */

/**
 * @param {object} v
 * @param {object} v.mandate
 * @param {number} v.mark
 * @param {{btc:number, usd:number, spendable:{btc:number, usd:number}}} v.holdings
 * @param {Array<{quoteId:string, side:"bid"|"ask", price:number, sizeBtc:number, expiresAt:string}>} v.openQuotes
 * @param {boolean} v.frozen
 * @param {number} [v.netDeltaBtc]  inventory plus Strike position, signed; the side that would grow it is sized to the limit
 * @param {number} [v.strikePositionBtc]  signed; a fill's hedge must keep the Strike position under its cap
 * @param {number} v.now   ms
 * @param {object} [o]
 * @param {number} [o.spreadBps]       quoted spread, clamped into the mandate's band
 * @param {number} [o.requoteBps]      requote when the mark moved this far from a quote's mid; default half the spread
 * @param {number} [o.ttlSec]
 * @param {number} [o.sizeUsd]         each quote's size in USD, capped by the mandate
 * @param {boolean} [o.pause]          pull every quote, post none
 * @param {number} [o.minQuoteUsd]      no quote smaller than this: Strike's minimum hedge notional
 * @returns {{ retire: string[], quotes: Array<{side, sizeBtc, price, ttlSec}>, reason: string }}
 */
export function makerDecision(v, { spreadBps = 50, requoteBps, ttlSec, sizeUsd, pause = false, minQuoteUsd = 5 } = {}) {
  const m = v.mandate.midnight;
  const spread = Math.min(Math.max(spreadBps, m.minSpreadBps + 2), m.maxSpreadBps);
  const half = spread / 2 / 10_000;
  const requote = (requoteBps ?? spread / 2) / 10_000;
  const ttl = Math.min(ttlSec ?? m.quoteTtlSec, m.quoteTtlSec);
  if (pause) return { retire: v.openQuotes.map((q) => q.quoteId), quotes: [], reason: "paused: pulling every quote" };
  // frozen: only the side that brings net delta back toward zero may stand
  const delta = v.netDeltaBtc ?? 0;
  const onlySide = v.frozen ? (delta > 0 ? "ask" : delta < 0 ? "bid" : null) : null;
  if (v.frozen && !onlySide) return { retire: v.openQuotes.map((q) => q.quoteId), quotes: [], reason: "frozen: pulling every quote" };

  const retire = [];
  const keep = { bid: null, ask: null };
  for (const q of v.openQuotes) {
    const mid = q.side === "ask" ? q.price / (1 + half) : q.price / (1 - half);
    const stale = Math.abs(v.mark - mid) / v.mark > requote;
    const closing = q.expiresAt && Date.parse(q.expiresAt) - v.now < 60_000;
    if (stale || closing || keep[q.side] || (onlySide && q.side !== onlySide)) retire.push(q.quoteId);
    else keep[q.side] = q;
  }
  const cap = Math.min(m.maxQuoteUsd, v.mandate.risk.maxNetDeltaUsd);
  const size = Math.min(sizeUsd ?? cap, cap);
  // a fill moves net delta by the quote's size: an ask lowers it, a bid raises it; neither may leave the limit
  const roomBtc = v.mandate.risk.maxNetDeltaUsd / v.mark;
  // frozen: a quote may bring net delta toward zero but never across it
  const roomAsk = onlySide ? Math.max(0, delta) : Math.max(0, roomBtc + delta);
  const roomBid = onlySide ? Math.max(0, -delta) : Math.max(0, roomBtc - delta);
  // a bid's hedge sells on Strike, an ask's hedge buys: neither may push the position past its cap;
  // the part of a fill that nets open exposure of the other side needs no hedge at all
  const pos = v.strikePositionBtc ?? 0;
  const posCapBtc = v.mandate.strike.maxPositionUsd / v.mark;
  const hedgeRoomBid = Math.max(0, posCapBtc + pos) + Math.max(0, -delta);
  const hedgeRoomAsk = Math.max(0, posCapBtc - pos) + Math.max(0, delta);
  const fits = (x) => x >= STEP_BTC && x * v.mark >= minQuoteUsd;
  const quotes = [];
  const reasons = [];
  if (!keep.ask && (!onlySide || onlySide === "ask")) {
    const sizeBtc = Math.min(size / v.mark, v.holdings.spendable.btc, roomAsk, hedgeRoomAsk);
    if (fits(floor8(sizeBtc))) quotes.push({ side: "ask", sizeBtc: round8(floor8(sizeBtc)), price: round1(v.mark * (1 + half)), ttlSec: ttl });
    else reasons.push(roomAsk * v.mark < minQuoteUsd ? "net delta leaves no room for an ask" : hedgeRoomAsk * v.mark < minQuoteUsd ? "the Strike position cap leaves no room to hedge an ask" : `not enough tBTC for an ask of at least ${minQuoteUsd} USD`);
  }
  if (!keep.bid && (!onlySide || onlySide === "bid")) {
    const sizeBtc = Math.min(size / v.mark, v.holdings.spendable.usd / (v.mark * (1 - half)), roomBid, hedgeRoomBid);
    if (fits(floor8(sizeBtc))) quotes.push({ side: "bid", sizeBtc: round8(floor8(sizeBtc)), price: round1(v.mark * (1 - half)), ttlSec: ttl });
    else reasons.push(roomBid * v.mark < minQuoteUsd ? "net delta leaves no room for a bid" : hedgeRoomBid * v.mark < minQuoteUsd ? "the Strike position cap leaves no room to hedge a bid" : `not enough tUSD for a bid of at least ${minQuoteUsd} USD`);
  }
  const reason = [
    onlySide ? `frozen: only the ${onlySide} that reduces net delta` : null,
    retire.length ? `${retire.length} quote(s) off: mark moved past ${spread / 2} bps or expiry near` : null,
    quotes.length ? `quoting ${quotes.map((q) => q.side).join(" and ")} at ${spread} bps around ${v.mark}` : null,
    ...reasons,
  ].filter(Boolean).join("; ") || "both sides standing, nothing to do";
  return { retire, quotes, reason };
}

/**
 * A citizen's mind: takes the best quote on its side when it sits within
 * `tolBps` of the mark, with probability `rate` per look, if the wallet can
 * pay. `side` is what the citizen wants to do with BTC: "buy" takes asks;
 * "auto" sells when more than half its worth is BTC and buys otherwise, so
 * the coins keep circulating.
 */
export function citizenDecision(v, { side: wanted = "buy", tolBps = 60, rate = 0.3, maxUsd = 150, rnd = Math.random } = {}) {
  if (v.frozen) return { take: null, reason: "frozen" };
  if (rnd() > rate) return { take: null, reason: "waiting" };
  const btcUsd = (v.holdings.btc ?? v.holdings.spendable.btc) * v.mark;
  const usd = v.holdings.usd ?? v.holdings.spendable.usd;
  const side = wanted === "auto" ? (btcUsd > usd ? "sell" : "buy") : wanted;
  // the preferred side first; an auto citizen also takes the other side when that is all the board offers
  const sides = wanted === "auto" ? [side, side === "buy" ? "sell" : "buy"] : [side];
  let why = null;
  for (const s of sides) {
    const want = s === "buy" ? "ask" : "bid";
    const mine = v.board.filter((q) => q.side === want && q.maker !== v.agentId && q.sizeBtc * v.mark <= maxUsd && !closingSoon(q, v.now));
    const best = mine.sort((a, b) => (want === "ask" ? a.price - b.price : b.price - a.price))[0];
    if (!best) { why ??= `no ${want} on the board`; continue; }
    const offBps = (want === "ask" ? best.price - v.mark : v.mark - best.price) / v.mark * 10_000;
    if (offBps > tolBps) { why ??= `best ${want} is ${Math.round(offBps)} bps off the mark, more than ${tolBps}`; continue; }
    const canPay = want === "ask" ? v.holdings.spendable.usd >= best.sizeBtc * best.price : v.holdings.spendable.btc >= best.sizeBtc;
    if (!canPay) { why ??= "cannot pay for it in one half"; continue; }
    return { take: best, reason: `${s}s ${best.sizeBtc} BTC at ${best.price}, ${Math.round(offBps)} bps off the mark${s !== side ? " (the only side on the board)" : ""}` };
  }
  return { take: null, reason: why ?? "nothing on the board" };
}

const closingSoon = (q, now) => q.expiresAt && Date.parse(q.expiresAt) - now < 60_000;
/** Strike's BTC-USD step: quote sizes are multiples of it, so a hedge is the same size. */
export const STEP_BTC = 0.00001;
const floor8 = (x) => Math.floor(x / STEP_BTC + 1e-9) * STEP_BTC;
const round1 = (x) => Math.round(x * 10) / 10;
const round8 = (x) => Math.round(x * 1e8) / 1e8;
