#!/usr/bin/env node
/**
 * An outside agent that pays for the gateway's tools with x402 on Cardano:
 * the official x402 client (@x402/fetch + @x402/cardano) with a mnemonic
 * wallet on preprod. It reads the market for free, then posts a quote and
 * pays one call for it.
 *
 *   npm run pay-demo -- address                 # the buyer's address (fund it with tADA)
 *   npm run pay-demo -- quote <agent> ask|bid <sizeBtc> <price>   # a paid post_quote
 *   npm run pay-demo -- market <agent>          # a free read
 *
 * BUYER_MNEMONIC in .env (24 words; `npm run pay-demo -- mnemonic` makes one),
 * TOOLS_URL the gateway's tools endpoint (default http://localhost:4483),
 * AGENT_KEY the agent's tools key when its owner issued one.
 */
import { paidFetch } from "../lib/paid-fetch.mjs";

const [cmd, agent = "mm-rule", side = "ask", sizeBtc = "0.0012", price] = process.argv.slice(2);
const TOOLS = (process.env.TOOLS_URL || "http://localhost:4483").replace(/\/+$/, "");
const network = process.env.X402_NETWORK || "cardano:preprod";
const log = (...x) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...x);

if (cmd === "mnemonic") {
  const { generateMnemonic } = await import("bip39");
  console.log(`BUYER_MNEMONIC="${generateMnemonic(256)}"`);
  process.exit(0);
}
const mnemonic = process.env.BUYER_MNEMONIC;
if (!mnemonic) { console.error("BUYER_MNEMONIC is not set"); process.exit(2); }
const { fetch: fetchPaid, address } = paidFetch({ mnemonic, network, koiosUrl: process.env.KOIOS_URL || undefined });
if (cmd === "address") { console.log(address); process.exit(0); }
// an agent whose owner issued a tools key: AGENT_KEY opens its endpoint
const keyHeader = process.env.AGENT_KEY ? { authorization: `Bearer ${process.env.AGENT_KEY}` } : {};

async function call(name, args = {}, { paid = false } = {}) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...keyHeader };
  const res = await (paid ? fetchPaid : fetch)(`${TOOLS}/mcp/${agent}`, { method: "POST", headers, body });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const json = JSON.parse(line ? line.slice(5) : text);
  const receipt = res.headers.get("payment-response");
  if (receipt) log("paid:", JSON.stringify(JSON.parse(Buffer.from(receipt, "base64").toString("utf8"))).slice(0, 200));
  if (res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  const content = json.result?.content?.[0]?.text;
  return content ? JSON.parse(content) : json;
}

log(`buyer ${address} on ${network}, tools at ${TOOLS}, agent ${agent}`);
if (cmd === "market") { console.log(JSON.stringify(await call("get_market"), null, 1).slice(0, 800)); process.exit(0); }
if (cmd === "quote") {
  const m = await call("get_market");
  const p = price ? Number(price) : Math.round(m.mark * (side === "ask" ? 1.003 : 0.997) * 10) / 10;
  log(`mark ${m.mark}: posting a paid ${side} of ${sizeBtc} BTC at ${p}`);
  const r = await call("post_quote", { side, sizeBtc: Number(sizeBtc), price: p, ttlSec: 180, reason: "paid demo quote from an outside agent" }, { paid: true });
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
}
console.error("usage: mnemonic | address | market <agent> | quote <agent> ask|bid <sizeBtc> [<price>]");
process.exit(2);
