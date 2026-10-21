/**
 * The user stream against a stand-in socket: the signed logon, subscribe
 * after the logon reply, several messages in one frame, fill against order
 * update, errors, and the reconnect after a close.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { keypair } from "../gateway/strike.mjs";
import { classify, logonParams, parseFrame, userStream } from "../gateway/strike-stream.mjs";

const SEED = "22".repeat(32);

/** A WebSocket stand-in the test drives by hand. */
function socketFactory() {
  const sockets = [];
  class Fake {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.onclose?.({ code: 1000, reason: "by us" }); }
    open() { this.onopen?.(); }
    receive(text) { this.onmessage?.({ data: text }); }
  }
  return { Fake, sockets };
}

test("logonParams signs session.logon:{ms}:{publicKey}, verifiable with the public key", () => {
  const w = keypair(SEED);
  const p = logonParams(w, 1792440000000);
  assert.equal(p.apiKey, w.publicKeyHex);
  assert.equal(p.timestamp, 1792440000000);
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(w.publicKeyHex, "hex")]), format: "der", type: "spki" });
  assert.ok(crypto.verify(null, Buffer.from(`session.logon:1792440000000:${w.publicKeyHex}`, "ascii"), pub, Buffer.from(p.signature, "hex")));
});

test("a frame holds several JSON lines", () => {
  assert.deepEqual(parseFrame('{"a":1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
});

test("classify: a fill has t > 0; an order update has not; balance, position, transfer and error are told apart", () => {
  const fill = classify({ e: "ORDER_TRADE_UPDATE", E: 2, data: { s: "BTC-USD", c: "c1", S: "SELL", o: "MARKET", x: "TRADE", X: "FILLED", i: 7, l: "0.0015", L: "83700", n: "0.06", t: 18073, m: false, rp: "0", T: 1, order_id: "7", trade_id: "18073", builder_fee: "0.01", account_id: "acc" } });
  assert.equal(fill.kind, "fill");
  assert.deepEqual([fill.orderId, fill.clientOrderId, fill.side, fill.size, fill.price, fill.fee, fill.tradeId, fill.builderFee, fill.accountId, fill.at], ["7", "c1", "SELL", "0.0015", "83700", "0.06", "18073", "0.01", "acc", 1]);
  const open = classify({ e: "ORDER_TRADE_UPDATE", E: 2, data: { s: "BTC-USD", c: "c1", S: "BUY", o: "LIMIT", x: "TRADE", X: "OPEN", i: 7, q: "0.002", p: "60000", z: "0", t: 0, cr: "", T: 1 } });
  assert.equal(open.kind, "order");
  assert.deepEqual([open.status, open.terminal, open.closeReason, open.filled], ["OPEN", false, null, "0"]);
  const rejected = classify({ e: "ORDER_TRADE_UPDATE", E: 2, data: { s: "BTC-USD", c: "c2", X: "REJECTED", x: "REJECTED", i: 8, t: 0, cr: "order_less_than_min_notional", T: 1 } });
  assert.deepEqual([rejected.terminal, rejected.closeReason], [true, "order_less_than_min_notional"]);
  assert.deepEqual(classify({ e: "ACCOUNT_UPDATE", E: 3, data: { e: "ORDER", B: [{ a: "USDT", wb: "1999.9" }], P: [], r: "FILL", T: 3 } }), { kind: "balance", wallet: "1999.9", reason: "FILL", at: 3 });
  const pos = classify({ e: "ACCOUNT_UPDATE", E: 3, data: { e: "POSITION_OPENED", B: [], P: [{ s: "BTC-USD", pa: "-0.0015", ep: "83700", mt: "cross", leverage: 20, account_id: "acc", position_seq: 1 }], r: "", T: 3 } });
  assert.deepEqual([pos.kind, pos.size, pos.entryPrice, pos.leverage, pos.event], ["position", "-0.0015", "83700", 20, "POSITION_OPENED"]);
  assert.equal(classify({ e: "ACCOUNT_UPDATE", E: 3, data: { e: "DEPOSIT_PENDING", B: [], P: [], r: "DEPOSIT", th: "0xabc", T: 3 } }).kind, "transfer");
  assert.deepEqual(classify({ e: "error", E: 1, error: { code: 401, msg: "Authentication failed" } }), { kind: "error", code: 401, message: "Authentication failed" });
  assert.equal(classify({ id: 9, method: "pong" }), null);
});

test("the stream logs on, subscribes after the reply, hands events on, and reconnects after a close", async () => {
  const { Fake, sockets } = socketFactory();
  const events = [];
  const status = [];
  const s = userStream({ baseUrl: "https://api.example", privateKeyHex: SEED, subAccountId: "sub-9", onEvent: (e) => events.push(e), onStatus: (x) => status.push(x), WebSocket: Fake, now: () => 1792440000000, reconnectMs: 1 });
  const a = sockets[0];
  assert.equal(a.url, "wss://api.example/ws/user-api");
  a.open();
  assert.equal(a.sent[0].method, "session.logon");
  assert.equal(a.sent[0].params.apiKey, keypair(SEED).publicKeyHex);
  assert.equal(a.sent.length, 1, "nothing before the logon reply");
  a.receive('{"id":1,"status":200,"result":{"authenticated":true,"account_id":"acc"}}');
  assert.deepEqual(a.sent[1], { id: 2, method: "subscribe", channel: "userstream", sub_account_id: "sub-9" });
  a.receive('{"id":2,"result":null}\n{"e":"ACCOUNT_UPDATE","E":5,"data":{"e":"ORDER","B":[{"wb":"10"}],"P":[],"r":"FILL","T":5}}');
  assert.equal(status.at(-1).state, "open");
  assert.equal(events[0].kind, "balance");
  a.receive('{"e":"error","E":1,"error":{"code":403,"msg":"nope"}}');
  assert.deepEqual(status.at(-1), { state: "error", code: 403, message: "nope" });
  a.onclose({ code: 1006, reason: "" });
  assert.equal(status.at(-1).state, "closed");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sockets.length, 2, "a second socket after the close");
  s.close();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sockets.length, 2, "no reconnect after close()");
});
