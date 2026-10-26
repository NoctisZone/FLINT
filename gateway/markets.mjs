/**
 * The markets an agent can trade: a Strike perpetual and the Midnight pair
 * that mirrors it. The base token on Midnight is the market's own
 * (market:tBTC, market:tADA, market:tSOL), the quote token is tUSD for all
 * of them. Sizes in the gateway are in the base asset whatever it is; the
 * field name `sizeBtc` is kept for every market.
 *
 * `step` and `tick` are Strike testnet's as of 2026-10-22 (the gateway reads
 * the live rules at start and falls back to these).
 */
export const MARKETS = {
  "BTC-USD": { symbol: "BTC-USD", base: "BTC", pair: "tBTC/tUSD", token: "market:tBTC", decimals: 8, step: 0.00001, tick: 0.1, minNotionalUsd: 100 },
  "ADA-USD": { symbol: "ADA-USD", base: "ADA", pair: "tADA/tUSD", token: "market:tADA", decimals: 6, step: 1, tick: 0.0001, minNotionalUsd: 5 },
  "SOL-USD": { symbol: "SOL-USD", base: "SOL", pair: "tSOL/tUSD", token: "market:tSOL", decimals: 9, step: 0.01, tick: 0.01, minNotionalUsd: 10 },
};
export const QUOTE_TOKEN = "market:tUSD";
/** Share above Strike's minimum order that quotes and hedges keep, so a small price move cannot push them under it. */
export const MIN_MARGIN = 0.01;
export const SYMBOLS = Object.keys(MARKETS);

/** The market of a symbol; throws for one the gateway does not trade. */
export function marketOf(symbol) {
  const m = MARKETS[symbol];
  if (!m) throw new Error(`no such market: ${symbol}; one of ${SYMBOLS.join(", ")}`);
  return m;
}

/** The market behind a Midnight pair, or null. */
export const marketOfPair = (pair) => Object.values(MARKETS).find((m) => m.pair === pair) ?? null;

/**
 * The markets a mandate allows, in its order: every Strike symbol known here,
 * none twice, and `midnight.pairs` exactly those markets' pairs. Throws otherwise.
 */
export function assertMarkets(mandate) {
  const symbols = mandate.strike.markets;
  if (!symbols.length) throw new Error("strike.markets names no market");
  if (new Set(symbols).size !== symbols.length) throw new Error("strike.markets names a market twice");
  const ms = symbols.map(marketOf);
  const want = ms.map((m) => m.pair);
  const have = mandate.midnight.pairs;
  if (have.length !== want.length || have.some((p, i) => p !== want[i])) throw new Error(`midnight.pairs must be ${want.join(", ")} for ${symbols.join(", ")}`);
  return ms;
}

/** A mandate's market: its first Strike symbol; the pair must agree. */
export function marketOfMandate(mandate) {
  const m = marketOf(mandate.strike.markets[0]);
  if (mandate.midnight.pairs[0] !== m.pair) throw new Error(`mandate pair ${mandate.midnight.pairs[0]} does not belong to ${m.symbol}`);
  return m;
}

/** Decimal places of a step (0.00001 → 5, 1 → 0). */
export const placesOf = (step) => Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
