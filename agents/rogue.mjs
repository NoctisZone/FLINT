/**
 * The rogue agent: a fixed list of actions that each break a different rule
 * of its mandate, on both venues. The demo expects every one refused, with
 * at least five distinct rules; `runRogue` returns what the checker said.
 */
import { check } from "../gateway/checks.mjs";

/** A sane state for `mandate` at `mark`; the rogue starts flat and within limits. */
export function baseState(mandate, mark, now = Date.now()) {
  return {
    mandate, signatureOk: true, frozen: false, now, mark,
    strikePositionBtc: 0, leverage: Math.min(mandate.strike.maxLeverage, 20), midnightInventoryBtc: 0, unhedgedBtc: 0,
    openQuotes: 0, equityStartUsd: 1000, equityNowUsd: 1000, actionsLastMinute: 0,
  };
}

/** The rogue's attempts: label, action, and the state it tries them in. */
export function rogueAttempts(mandate, mark) {
  const m = mandate;
  const s = baseState(mandate, mark);
  const btc = (usd) => usd / mark;
  return [
    { label: "oversized Strike order", action: { venue: "strike", kind: "order", symbol: m.strike.markets[0], side: "buy", sizeBtc: btc(m.strike.maxPositionUsd * 4) }, state: s },
    { label: "Strike limit far off the mark", action: { venue: "strike", kind: "order", symbol: m.strike.markets[0], side: "buy", sizeBtc: btc(m.strike.maxPositionUsd / 2), price: mark * (1 - (m.strike.priceBandPct + 3) / 100) }, state: s },
    { label: "market not in the mandate", action: { venue: "strike", kind: "order", symbol: "DOGE-USD", side: "buy", sizeBtc: btc(10) }, state: s },
    { label: "unhedged position past net delta", action: { venue: "strike", kind: "order", symbol: m.strike.markets[0], side: "buy", sizeBtc: btc(Math.min(m.strike.maxPositionUsd, m.risk.maxNetDeltaUsd * 1.5)) }, state: s },
    { label: "oversized Midnight quote", action: { venue: "midnight", kind: "quote", pair: m.midnight.pairs[0], side: "ask", sizeBtc: btc(m.midnight.maxQuoteUsd * 3), price: mark * (1 + m.midnight.maxSpreadBps / 20_000), ttlSec: 60 }, state: s },
    { label: "Midnight quote outside the spread band", action: { venue: "midnight", kind: "quote", pair: m.midnight.pairs[0], side: "ask", sizeBtc: btc(m.midnight.maxQuoteUsd / 2), price: mark * (1 + (m.midnight.maxSpreadBps * 4) / 10_000), ttlSec: 60 }, state: s },
    { label: "Midnight bid above the mark", action: { venue: "midnight", kind: "quote", pair: m.midnight.pairs[0], side: "bid", sizeBtc: btc(m.midnight.maxQuoteUsd / 2), price: mark * 1.01, ttlSec: 60 }, state: s },
    { label: "too many open quotes", action: { venue: "midnight", kind: "quote", pair: m.midnight.pairs[0], side: "ask", sizeBtc: btc(m.midnight.maxQuoteUsd / 2), price: mark * (1 + m.midnight.maxSpreadBps / 20_000), ttlSec: 60 }, state: { ...s, openQuotes: m.midnight.maxOpenQuotes } },
    { label: "quote living too long", action: { venue: "midnight", kind: "quote", pair: m.midnight.pairs[0], side: "ask", sizeBtc: btc(m.midnight.maxQuoteUsd / 2), price: mark * (1 + m.midnight.maxSpreadBps / 20_000), ttlSec: m.midnight.quoteTtlSec * 10 }, state: s },
    { label: "trading after the daily loss stop", action: { venue: "midnight", kind: "quote", pair: m.midnight.pairs[0], side: "ask", sizeBtc: btc(m.midnight.maxQuoteUsd / 2), price: mark * (1 + m.midnight.maxSpreadBps / 20_000), ttlSec: 60 }, state: { ...s, equityNowUsd: 1000 * (1 - (m.risk.dailyLossStopPct + 1) / 100) } },
    { label: "hammering the gateway", action: { venue: "strike", kind: "order", symbol: m.strike.markets[0], side: "buy", sizeBtc: btc(10) }, state: { ...s, actionsLastMinute: m.risk.maxActionsPerMin } },
    { label: "quoting while frozen", action: { venue: "midnight", kind: "quote", pair: m.midnight.pairs[0], side: "ask", sizeBtc: btc(m.midnight.maxQuoteUsd / 2), price: mark * (1 + m.midnight.maxSpreadBps / 20_000), ttlSec: 60 }, state: { ...s, frozen: true } },
  ];
}

/** Every attempt with the checker's answer; `rules` are the distinct rules broken. */
export function runRogue(mandate, mark) {
  const results = rogueAttempts(mandate, mark).map((t) => ({ label: t.label, refused: check(t.action, t.state) }));
  const rules = [...new Set(results.map((r) => r.refused?.rule).filter(Boolean))];
  return { results, rules, allRefused: results.every((r) => r.refused) };
}
