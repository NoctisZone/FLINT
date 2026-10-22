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
 * Settings: LIQUIDITY_SIZE_BTC (0.01), LIQUIDITY_SPREAD_BPS (10),
 * LIQUIDITY_REDUCE_BPS (5), LIQUIDITY_MAX_POSITION_BTC (0.05),
 * LIQUIDITY_EVERY_MS (5000), LIQUIDITY_SYMBOL (BTC-USD).
 */
import { strikeClient, TESTNET } from "../gateway/strike.mjs";
import { liquidityPlan } from "../gateway/liquidity.mjs";

const log = (...x) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...x);
const num = (name, dflt) => (process.env[name] ? Number(process.env[name]) : dflt);
const symbol = process.env.LIQUIDITY_SYMBOL || "BTC-USD";
const key = process.env.STRIKE_LIQUIDITY_KEY || process.env.STRIKE_KEY;
if (!key) { console.error("no STRIKE_LIQUIDITY_KEY or STRIKE_KEY"); process.exit(2); }
const PREFIX = "liq";
const settings = { sizeBtc: num("LIQUIDITY_SIZE_BTC", 0.01), spreadBps: num("LIQUIDITY_SPREAD_BPS", 10), reduceBps: num("LIQUIDITY_REDUCE_BPS", 5), maxPositionBtc: num("LIQUIDITY_MAX_POSITION_BTC", 0.05) };
const everyMs = num("LIQUIDITY_EVERY_MS", 5000);

const c = strikeClient({ baseUrl: process.env.STRIKE_API_URL || TESTNET, privateKeyHex: key });
await c.syncClock();
const rules = await c.market(symbol);
const tick = Number(rules.order_tick_price ?? 0.1);
log(`liquidity on ${symbol}: ${settings.sizeBtc} BTC a side, ${settings.spreadBps} bps (${settings.reduceBps} on the reducing side), tick ${tick}, cap ${settings.maxPositionBtc} BTC`);

let lastPosition = null;
let fills = 0;
let stopping = false;

async function mine() {
  const r = await c.openOrders(symbol);
  return (r.orders ?? []).filter((o) => String(o.ClientOrderID ?? "").startsWith(`${PREFIX}-`)).map((o) => ({ clientOrderId: o.ClientOrderID, side: String(o.Side).toLowerCase(), price: Number(o.Price) }));
}

async function tickOnce() {
  const mark = Number((await c.markPrice(symbol)).p);
  const pos = (await c.positions()).positions?.find((p) => p.symbol === symbol);
  const positionBtc = pos ? Number(pos.size) : 0;
  if (lastPosition !== null && Math.abs(positionBtc - lastPosition) > 1e-9) { fills += 1; log(`filled: position ${lastPosition} → ${positionBtc} BTC (${fills} fills so far)`); }
  lastPosition = positionBtc;
  const open = await mine();
  const plan = liquidityPlan({ mark, positionBtc, open, tick, prefix: PREFIX, ...settings });
  for (const id of plan.cancel) {
    await c.cancel({ symbol, clientOrderId: id }).catch((err) => log(`cancel ${id}: ${err.message.slice(0, 100)}`));
  }
  for (const o of plan.place) {
    try {
      await c.placeOrder({ symbol, side: o.side, type: "limit", size: o.size, price: o.price, timeInForce: "GTC", clientOrderId: o.clientOrderId });
      log(`${o.side} ${o.size} at ${o.price} (mark ${mark}, position ${positionBtc})`);
    } catch (err) { log(`place ${o.side} at ${o.price}: ${err.message.slice(0, 120)}`); }
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  log("stopping: pulling orders");
  try { for (const o of await mine()) await c.cancel({ symbol, clientOrderId: o.clientOrderId }).catch(() => {}); } catch {}
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

for (;;) {
  if (stopping) break;
  try { await tickOnce(); } catch (err) {
    log(`loop: ${err.message.slice(0, 160)}`);
    // a rate limit or an outage: back off, then resync the clock
    await new Promise((r) => setTimeout(r, everyMs * 3));
    await c.syncClock().catch(() => {});
  }
  await new Promise((r) => setTimeout(r, everyMs));
}
