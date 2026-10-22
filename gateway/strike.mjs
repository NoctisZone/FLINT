/**
 * Strike Finance perpetuals over its REST API: public market data and the
 * API-wallet calls an agent's hedge needs. Every authenticated request is
 * signed with the wallet's Ed25519 key over
 * `{METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{BODY_HASH}`; a fresh nonce each time,
 * the timestamp one second behind the server's clock.
 *
 * `strikeClient` runs on any `fetch`; the tests hand it a stand-in.
 */
import crypto from "node:crypto";

export const MAINNET = "https://api.strikefinance.org";
export const TESTNET = "https://api-v2-testnet.strikefinance.org";
export const USER_AGENT = "flint/0.1";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const sha256Hex = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** An Ed25519 API wallet from a 32-byte seed (hex), a new one when none is given. */
export function keypair(privateKeyHex = crypto.randomBytes(32).toString("hex")) {
  const seed = Buffer.from(privateKeyHex, "hex");
  if (seed.length !== 32 && seed.length !== 64) throw new Error("a Strike API wallet key is 32 bytes (64 hex chars), or 64 with the public half");
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const publicKeyHex = crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return { key, privateKeyHex: seed.subarray(0, 32).toString("hex"), publicKeyHex };
}

/** The string an API-wallet request signs; `body` is the exact bytes sent, none for GET. */
export function signedMessage({ method, path, timestamp, nonce, body }) {
  return `${method.toUpperCase()}:${path}:${timestamp}:${nonce}:${sha256Hex(body ?? "")}`;
}

/** The four auth headers of one request. */
export function signRequest({ method, path, body, timestamp, nonce = crypto.randomUUID() }, { key, publicKeyHex }) {
  const signature = crypto.sign(null, Buffer.from(signedMessage({ method, path, timestamp, nonce, body }), "utf8"), key);
  return {
    "X-API-Wallet-Public-Key": publicKeyHex,
    "X-API-Wallet-Signature": signature.toString("hex"),
    "X-API-Wallet-Timestamp": String(timestamp),
    "X-API-Wallet-Nonce": nonce,
  };
}

export class StrikeError extends Error {
  constructor(status, text, code, path) {
    super(`Strike ${status} on ${path}: ${text}`);
    this.status = status;
    this.text = text;
    this.code = code ?? null;
  }
}

/**
 * @param {object} o
 * @param {string} [o.baseUrl]          mainnet or testnet host
 * @param {string} [o.privateKeyHex]    the API wallet's key; public calls work without one
 * @param {number} [o.builderFeeBps]    X-Builder-Fee-Bps on every order; only on builder-connect wallets
 * @param {string} [o.subAccountId]     act on this owned sub-account instead of the master
 */
export function strikeClient({ baseUrl = TESTNET, privateKeyHex, builderFeeBps, subAccountId, userAgent = USER_AGENT, fetch = globalThis.fetch, now = Date.now } = {}) {
  const wallet = privateKeyHex ? keypair(privateKeyHex) : null;
  let clockOffsetMs = 0;

  async function call(method, path, { body, auth = false, prefix = "" } = {}) {
    const url = `${baseUrl}${prefix}${path}`;
    const bodyStr = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Accept: "application/json", "User-Agent": userAgent };
    if (bodyStr !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      if (!wallet) throw new Error(`${method} ${path} needs the API wallet key`);
      // the server rejects a timestamp even a second ahead of its clock
      const timestamp = Math.floor((now() + clockOffsetMs - 1000) / 1000);
      Object.assign(headers, signRequest({ method, path, body: bodyStr, timestamp }, wallet));
      if (builderFeeBps !== undefined && method === "POST" && /^\/v2\/order(s)?(\/batch|\/strategy|\/replace-batch)?$|^\/v2\/orders\/replace$/.test(path)) headers["X-Builder-Fee-Bps"] = String(builderFeeBps);
    }
    const res = await fetch(url, { method, headers, body: bodyStr, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (!res.ok) throw new StrikeError(res.status, json?.error ?? json?.msg ?? text.slice(0, 200), json?.code, path);
    return json;
  }

  const market = (path) => call("GET", path, { prefix: "/price" });
  const withSub = (q = {}) => (subAccountId ? { ...q, sub_account_id: subAccountId } : q);
  const query = (q) => { const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString(); return s ? `?${s}` : ""; };

  return {
    baseUrl,
    publicKeyHex: wallet?.publicKeyHex ?? null,

    /** Align with the server's clock; call once before signed requests, again after a timestamp 401. */
    async syncClock() {
      const t0 = now();
      const { serverTime } = await call("GET", "/v2/time");
      clockOffsetMs = serverTime - Math.round((t0 + now()) / 2);
      return clockOffsetMs;
    },

    ping: () => call("GET", "/v2/ping"),
    time: () => call("GET", "/v2/time"),
    /** The engine's own market rules: tick, step, min size, min notional, price bounds. */
    markets: () => call("GET", "/v2/markets"),
    market: async (symbol) => { const r = await call("GET", `/v2/markets/${symbol}`); return r.market ?? r; },
    /** { p: mark, i: index, r: funding rate, T: next funding time } */
    markPrice: (symbol) => market(`/v2/markPrice?symbol=${symbol}`),
    premiumIndex: (symbol) => market(`/v2/premiumIndex?symbol=${symbol}`),
    depth: (symbol, limit = 20) => market(`/v2/depth?symbol=${symbol}&limit=${limit}`),
    bookTicker: (symbol) => market(`/v2/ticker/bookTicker?symbol=${symbol}`),
    ticker: (symbol) => market(`/v2/ticker/24hr?symbol=${symbol}`),

    account: () => call("GET", `/v2/account${query(withSub())}`, { auth: true }),
    balances: () => call("GET", `/v2/balances${query(withSub())}`, { auth: true }),
    positions: () => call("GET", `/v2/positions${query(withSub())}`, { auth: true }),
    openOrders: (symbol) => call("GET", `/v2/openOrders${query(withSub({ symbol }))}`, { auth: true }),
    order: ({ symbol, orderId, clientOrderId }) => call("GET", `/v2/order${query(withSub({ symbol, order_id: orderId, client_order_id: clientOrderId }))}`, { auth: true }),
    subAccounts: () => call("GET", "/v2/sub-accounts", { auth: true }),
    symbols: () => call("GET", `/v2/symbols${query(withSub())}`, { auth: true }),
    fills: ({ symbol, limit } = {}) => call("GET", `/v2/history/fill${query(withSub({ symbol, limit }))}`, { auth: true }),
    /** Deposits, fees, funding and withdrawals, newest first. */
    transactions: ({ limit = 50 } = {}) => call("GET", `/v2/history/transaction${query(withSub({ limit }))}`, { auth: true }),

    setLeverage: (symbol, leverage) => call("POST", "/v2/leverage", { auth: true, body: withSub({ symbol, leverage }) }),

    /** Deposits, master account only: quote, the unsigned transaction for our UTxOs, the submitted hash. */
    depositQuote: (body) => call("POST", "/v2/deposit/quote", { auth: true, body }),
    depositBuildTx: (body) => call("POST", "/v2/deposit/build-tx", { auth: true, body }),
    depositConfirm: (body) => call("POST", "/v2/deposit", { auth: true, body }),
    /** Withdrawals to the account's registered wallet: the quote (message and Cardano tx to sign), the confirm, the limits. */
    withdrawQuote: (body) => call("POST", "/v2/withdraw/quote", { auth: true, body }),
    withdrawConfirm: (body) => call("POST", "/v2/withdraw", { auth: true, body }),
    withdrawLimits: ({ chain = "cardano", asset = "ADA" } = {}) => call("GET", `/v2/withdraw/limits${query({ chain, asset })}`, { auth: true }),

    /**
     * Accepted (201, status pending) is not filled: the engine answers on the
     * user stream, or `order()` by clientOrderId shows the outcome.
     */
    placeOrder: ({ symbol, side, type = "limit", size, price, timeInForce, reduceOnly, postOnly, slippage, clientOrderId }) => call("POST", "/v2/order", {
      auth: true,
      body: withSub(compact({
        symbol, side, type, size: String(size),
        price: price === undefined ? undefined : String(price),
        time_in_force: timeInForce, reduce_only: reduceOnly, post_only: postOnly,
        slippage: slippage === undefined ? undefined : String(slippage),
        client_order_id: clientOrderId,
      })),
    }),
    cancel: ({ symbol, orderId, clientOrderId }) => call("DELETE", "/v2/order/cancel", { auth: true, body: withSub(compact({ symbol, order_id: orderId, client_order_id: clientOrderId })) }),
    cancelAll: (symbol) => call("DELETE", "/v2/order/cancel-all", { auth: true, body: withSub(compact({ symbol })) }),
  };
}

const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
