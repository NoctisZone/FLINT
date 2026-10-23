#!/usr/bin/env node
/**
 * The stand-in market maker on Strike testnet: a bid and an ask around the
 * mark from an account of ours (STRIKE_LIQUIDITY_KEY, or STRIKE_KEY), kept
 * fresh every few seconds, so the agents' hedges can fill. A resting hedge
 * inside its spread is taken, that is what fills it. On SIGTERM it pulls
 * its orders.
 *
 *   npm run liquidity
 *
 * Settings: LIQUIDITY_SYMBOLS (BTC-USD,ADA-USD,SOL-USD; LIQUIDITY_SYMBOL still
 * names one), LIQUIDITY_SIZE_USD (800 a side, in the market's base asset
 * at the mark), LIQUIDITY_SPREAD_BPS (10), LIQUIDITY_REDUCE_BPS (5),
 * LIQUIDITY_MAX_POSITION_USD (4000), LIQUIDITY_EVERY_MS (5000).
 * LIQUIDITY_SIZE_BTC and LIQUIDITY_MAX_POSITION_BTC still set BTC-USD alone.
 */
import { strikeClient, TESTNET } from "../gateway/strike.mjs";
import { liquidityPlan } from "../gateway/liquidity.mjs";

const log = (...x) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...x);
const num = (name, dflt) => (process.env[name] ? Number(process.env[name]) : dflt);
const symbols = (process.env.LIQUIDITY_SYMBOLS || process.env.LIQUIDITY_SYMBOL || "BTC-USD,ADA-USD,SOL-USD").split(",").map((s) => s.trim()).filter(Boolean);
const key = process.env.STRIKE_LIQUIDITY_KEY || process.env.STRIKE_KEY;
if (!key) { console.error("no STRIKE_LIQUIDITY_KEY or STRIKE_KEY"); process.exit(2); }
const PREFIX = "liq";
const sizeUsd = num("LIQUIDITY_SIZE_USD", 800);
const maxPositionUsd = num("LIQUIDITY_MAX_POSITION_USD", 4000);
const spreadBps = num("LIQUIDITY_SPREAD_BPS", 10), reduceBps = num("LIQUIDITY_REDUCE_BPS", 5);
const everyMs = num("LIQUIDITY_EVERY_MS", 5000);

const c = strikeClient({ baseUrl: process.env.STRIKE_API_URL || TESTNET, privateKeyHex: key });
await c.syncClock();
// one book per symbol: its rules, its last position, its orders carry the symbol in their id
const books = new Map();
for (const symbol of symbols) {
  const rules = await c.market(symbol);
  const tick = Number(rules.order_tick_price ?? 0.1), step = Number(rules.order_limit_step_size ?? 0.00001), minPrice = Number(rules.order_min_price ?? 0);
  const places = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  books.set(symbol, { symbol, tick, step, places, minPrice, prefix: `${PREFIX}-${symbol.split("-")[0].toLowerCase()}`, lastPosition: null, fills: 0, skipped: false });
  log(`liquidity on ${symbol}: ${sizeUsd} USD a side, ${spreadBps} bps (${reduceBps} on the reducing side), tick ${tick}, step ${step}, cap ${maxPositionUsd} USD`);
}
let stopping = false;

async function mine(b) {
  const r = await c.openOrders(b.symbol);
  return (r.orders ?? []).filter((o) => String(o.ClientOrderID ?? "").startsWith(`${b.prefix}-`)).map((o) => ({ clientOrderId: o.ClientOrderID, side: String(o.Side).toLowerCase(), price: Number(o.Price) }));
}

async function tickOnce(b) {
  const mark = Number((await c.markPrice(b.symbol)).p);
  // an engine whose smallest limit price sits above the mark rejects every order: say so once, quote nothing
  if (b.minPrice > mark) { if (!b.skipped) { b.skipped = true; log(`${b.symbol}: the engine's smallest limit price is ${b.minPrice} USD, above the mark ${mark}; no quotes until that changes`); } return; }
  if (b.skipped) { b.skipped = false; log(`${b.symbol}: quoting again, mark ${mark} is above the smallest limit price`); }
  const pos = (await c.positions()).positions?.find((p) => p.symbol === b.symbol);
  const positionBtc = pos ? Number(pos.size) : 0;
  if (b.lastPosition !== null && Math.abs(positionBtc - b.lastPosition) > 1e-9) { b.fills += 1; log(`${b.symbol} filled: position ${b.lastPosition} → ${positionBtc} (${b.fills} fills so far)`); }
  b.lastPosition = positionBtc;
  const open = await mine(b);
  // BTC-USD keeps the old settings when they are set; every market sizes in USD at its mark, on its step
  const onStep = (x) => Number((Math.floor(x / b.step + 1e-9) * b.step).toFixed(b.places));
  const sizeBtc = b.symbol === "BTC-USD" && process.env.LIQUIDITY_SIZE_BTC ? num("LIQUIDITY_SIZE_BTC", 0.01) : onStep(sizeUsd / mark);
  const maxPositionBtc = b.symbol === "BTC-USD" && process.env.LIQUIDITY_MAX_POSITION_BTC ? num("LIQUIDITY_MAX_POSITION_BTC", 0.05) : onStep(maxPositionUsd / mark);
  if (sizeBtc <= 0) return;
  const plan = liquidityPlan({ mark, positionBtc, open, tick: b.tick, step: b.step, prefix: b.prefix, sizeBtc, spreadBps, reduceBps, maxPositionBtc });
  for (const id of plan.cancel) {
    await c.cancel({ symbol: b.symbol, clientOrderId: id }).catch((err) => log(`${b.symbol} cancel ${id}: ${err.message.slice(0, 100)}`));
  }
  for (const o of plan.place) {
    try {
      await c.placeOrder({ symbol: b.symbol, side: o.side, type: "limit", size: o.size, price: o.price, timeInForce: "GTC", clientOrderId: o.clientOrderId });
      log(`${b.symbol} ${o.side} ${o.size} at ${o.price} (mark ${mark}, position ${positionBtc})`);
    } catch (err) { log(`${b.symbol} place ${o.side} at ${o.price}: ${err.message.slice(0, 120)}`); }
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  log("stopping: pulling orders");
  for (const b of books.values()) { try { for (const o of await mine(b)) await c.cancel({ symbol: b.symbol, clientOrderId: o.clientOrderId }).catch(() => {}); } catch {} }
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

for (;;) {
  if (stopping) break;
  try { for (const b of books.values()) await tickOnce(b); } catch (err) {
    log(`loop: ${err.message.slice(0, 160)}`);
    // a rate limit or an outage: back off, then resync the clock
    await new Promise((r) => setTimeout(r, everyMs * 3));
    await c.syncClock().catch(() => {});
  }
  await new Promise((r) => setTimeout(r, everyMs));
}
