/**
 * Strike's user stream: one WebSocket per account that reports order state,
 * fills, balances and positions as they happen. Logon signs
 * `session.logon:{ms}:{publicKey}` with the API wallet's key; after every
 * (re)connect the caller must reload its REST state, since the stream sends
 * no snapshot and replays nothing.
 */
import { keypair } from "./strike.mjs";
import crypto from "node:crypto";

const TERMINAL = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);

/** The logon params: timestamp in ms, signature over the ASCII logon string. */
export function logonParams({ key, publicKeyHex }, timestamp) {
  const signature = crypto.sign(null, Buffer.from(`session.logon:${timestamp}:${publicKeyHex}`, "ascii"), key).toString("hex");
  return { apiKey: publicKeyHex, signature, timestamp };
}

/** A text frame may hold several JSON objects, one per line. */
export function parseFrame(text) {
  return String(text).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * One stream message as the gateway sees it:
 *   { kind: "fill", symbol, orderId, clientOrderId, side, size, price, fee, maker, tradeId, realizedPnl, builderFee, accountId, at }
 *   { kind: "order", symbol, orderId, clientOrderId, side, status, type, filled, size, price, closeReason, terminal, at }
 *   { kind: "balance", wallet, reason, at } | { kind: "position", symbol, size, entryPrice, leverage, marginMode, accountId, at }
 *   { kind: "transfer", status, reason, txHash, at } | { kind: "error", code, message } | null for replies and unknown events
 */
export function classify(msg) {
  if (msg?.e === "error") return { kind: "error", code: msg.error?.code ?? null, message: msg.error?.msg ?? "" };
  const d = msg?.data;
  if (!d) return null;
  if (msg.e === "ORDER_TRADE_UPDATE") {
    const at = d.T ?? msg.E;
    if (Number(d.t) > 0) {
      return {
        kind: "fill", symbol: d.s, orderId: String(d.order_id ?? d.i), clientOrderId: d.c, side: d.S, size: d.l, price: d.L,
        fee: d.n, maker: d.m === true, tradeId: String(d.trade_id ?? d.t), realizedPnl: d.rp, builderFee: d.builder_fee ?? "0",
        accountId: d.account_id ?? null, at,
      };
    }
    return {
      kind: "order", symbol: d.s, orderId: String(d.i), clientOrderId: d.c, side: d.S, status: d.X, type: d.o, filled: d.z, size: d.q, price: d.p,
      closeReason: d.cr || null, terminal: TERMINAL.has(d.X), at,
    };
  }
  if (msg.e === "ACCOUNT_UPDATE") {
    const at = d.T ?? msg.E;
    if (/^(DEPOSIT|WITHDRAWAL)_/.test(d.e ?? "")) return { kind: "transfer", status: d.e, reason: d.r, txHash: d.th ?? null, usdValue: d.usd_value ?? null, at };
    const p = d.P?.[0];
    if (p) return { kind: "position", symbol: p.s, size: p.pa, entryPrice: p.ep, leverage: p.leverage, marginMode: p.mt, accountId: p.account_id ?? null, event: d.e, seq: p.position_seq, at };
    return { kind: "balance", wallet: d.B?.[0]?.wb ?? null, reason: d.r, at };
  }
  return null;
}

/**
 * Open the stream and keep it open. `onEvent(event)` gets every classified
 * message; `onStatus({ state, ... })` reports `open` (logged on and
 * subscribed: reload REST state now), `closed` and `error`.
 */
export function userStream({ baseUrl, privateKeyHex, subAccountId, onEvent, onStatus = () => {}, WebSocket = globalThis.WebSocket, now = Date.now, reconnectMs = 2000 }) {
  const wallet = keypair(privateKeyHex);
  const url = baseUrl.replace(/^http/, "ws") + "/ws/user-api";
  let ws = null;
  let stopped = false;
  let timer = null;
  let attempt = 0;

  function connect() {
    ws = new WebSocket(url);
    const send = (o) => ws.send(JSON.stringify(o));
    ws.onopen = () => send({ id: 1, method: "session.logon", params: logonParams(wallet, now()) });
    ws.onmessage = (ev) => {
      let msgs;
      try { msgs = parseFrame(ev.data); } catch (e) { onStatus({ state: "error", message: `bad frame: ${e.message}` }); return; }
      for (const m of msgs) {
        if (m.id === 1) {
          if (m.status === 200) { attempt = 0; send({ id: 2, method: "subscribe", channel: "userstream", ...(subAccountId ? { sub_account_id: subAccountId } : {}) }); }
          else onStatus({ state: "error", message: `logon ${m.status}: ${m.error?.msg ?? JSON.stringify(m.error ?? m)}` });
          continue;
        }
        if (m.id === 2) { onStatus({ state: "open", accountId: null }); continue; }
        const e = classify(m);
        if (e?.kind === "error") onStatus({ state: "error", code: e.code, message: e.message });
        else if (e) onEvent(e);
      }
    };
    ws.onerror = (ev) => onStatus({ state: "error", message: ev?.message ?? "socket error" });
    ws.onclose = (ev) => {
      onStatus({ state: "closed", code: ev?.code ?? null, reason: ev?.reason ?? "" });
      if (stopped) return;
      attempt += 1;
      timer = setTimeout(connect, Math.min(reconnectMs * 2 ** Math.min(attempt - 1, 5), 60_000));
    };
  }

  connect();
  return {
    close() { stopped = true; clearTimeout(timer); ws?.close(); },
    /** Application-level ping; the server's own ping frames are answered by the socket itself. */
    ping() { ws?.send(JSON.stringify({ method: "ping", id: 9 })); },
  };
}
