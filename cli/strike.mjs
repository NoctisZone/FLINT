#!/usr/bin/env node
/**
 * Strike by hand. Public reads need no key; the rest signs with the API
 * wallet in STRIKE_KEY, or in STRIKE_KEY_<NAME> with `--key <NAME>`.
 * Testnet unless STRIKE_API_URL says otherwise.
 *
 *   npm run strike -- keygen                      # a new API wallet: private key for .env, public key to register
 *   npm run strike -- time | ping | markets [<symbol>]
 *   npm run strike -- mark <symbol>               # mark, index, funding
 *   npm run strike -- book <symbol> [<levels>]    # order book
 *   npm run strike -- account | balances | positions | sub-accounts | symbols
 *   npm run strike -- open-orders [<symbol>]
 *   npm run strike -- fills [<symbol>]
 *   npm run strike -- order <symbol> buy|sell <size> [<price>]   # limit with a price, market without
 *   npm run strike -- cancel <symbol> <orderId>
 *   npm run strike -- cancel-all [<symbol>]
 *   npm run strike -- stream                      # the user stream: orders, fills, balances, until Ctrl-C
 *
 * Options: --key <NAME>, --sub <subAccountId>, --fee <bps>
 */
import { TESTNET, keypair, strikeClient } from "../gateway/strike.mjs";
import { userStream } from "../gateway/strike-stream.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); if (i < 0) return undefined; const [v] = args.splice(i, 2).slice(1); return v; };
const keyName = opt("key");
const subAccountId = opt("sub") ?? process.env.STRIKE_SUB_ACCOUNT;
const fee = opt("fee");
const [cmd, ...rest] = args;

const privateKeyHex = keyName ? process.env[`STRIKE_KEY_${keyName.toUpperCase()}`] : process.env.STRIKE_KEY;
const show = (x) => console.log(JSON.stringify(x, null, 2));

async function main() {
  if (cmd === "keygen") {
    const w = keypair();
    console.log(`STRIKE_KEY=${w.privateKeyHex}\n# public key to register on Strike (API Wallets page):\n${w.publicKeyHex}`);
    return;
  }
  const c = strikeClient({ baseUrl: process.env.STRIKE_API_URL || TESTNET, privateKeyHex, subAccountId, builderFeeBps: fee === undefined ? undefined : Number(fee) });
  const needKey = () => { if (!privateKeyHex) throw new Error(keyName ? `STRIKE_KEY_${keyName.toUpperCase()} is not set` : "STRIKE_KEY is not set (or pass --key <NAME>)"); };
  switch (cmd) {
    case "time": return show(await c.time());
    case "ping": return show(await c.ping());
    case "markets": return show(rest[0] ? await c.market(rest[0]) : Object.keys((await c.markets()).markets ?? {}));
    case "mark": return show(await c.premiumIndex(rest[0] ?? "BTC-USD"));
    case "book": return show(await c.depth(rest[0] ?? "BTC-USD", Number(rest[1] ?? 10)));
    case "account": needKey(); await c.syncClock(); return show(await c.account());
    case "balances": needKey(); await c.syncClock(); return show(await c.balances());
    case "positions": needKey(); await c.syncClock(); return show(await c.positions());
    case "sub-accounts": needKey(); await c.syncClock(); return show(await c.subAccounts());
    case "symbols": needKey(); await c.syncClock(); return show(await c.symbols());
    case "open-orders": needKey(); await c.syncClock(); return show(await c.openOrders(rest[0]));
    case "fills": needKey(); await c.syncClock(); return show(await c.fills({ symbol: rest[0] }));
    case "order": {
      needKey();
      const [symbol, side, size, price] = rest;
      if (!symbol || !["buy", "sell"].includes(side) || !size) throw new Error("order <symbol> buy|sell <size> [<price>]");
      await c.syncClock();
      const r = await c.placeOrder({ symbol, side, size, ...(price ? { type: "limit", price } : { type: "market" }), clientOrderId: `flint-cli-${Date.now()}` });
      show(r);
      await new Promise((r) => setTimeout(r, 2000));
      return show(await c.order({ symbol, clientOrderId: r.client_order_id }));
    }
    case "cancel": needKey(); await c.syncClock(); return show(await c.cancel({ symbol: rest[0], orderId: Number(rest[1]) }));
    case "cancel-all": needKey(); await c.syncClock(); return show(await c.cancelAll(rest[0]));
    case "stream": {
      needKey();
      const stamp = () => new Date().toISOString().slice(11, 19);
      userStream({ baseUrl: c.baseUrl, privateKeyHex, subAccountId, onEvent: (e) => console.log(stamp(), JSON.stringify(e)), onStatus: (x) => console.log(stamp(), "stream", JSON.stringify(x)) });
      return new Promise(() => {});
    }
    default: throw new Error(`unknown command "${cmd ?? ""}"; see the header of cli/strike.mjs`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
