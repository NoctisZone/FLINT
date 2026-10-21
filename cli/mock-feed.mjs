#!/usr/bin/env node
/**
 * A feed with made-up numbers in the real shape, for building the arena
 * before the gateway runs. Every few seconds the mark moves, a quote
 * appears, a fill and its hedge land, the rogue is refused.
 *
 *   npm run mock-feed [-- --port 4481]
 */
import { feedServer, feedState } from "../gateway/feed.mjs";

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 4481);
const s = feedState({ runStart: new Date().toISOString() });
let mark = 84_200;
let n = 0;
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();

const agents = {
  "mm-rule": { name: "MM rule-based", type: "mm", status: "quoting", equityUsd: 2273.06, pnlPct: 0.0, spreadCapturedUsd: 0, hedgeCostUsd: 0, netDeltaUsd: 0, strikeVolumeUsd: 0, builderFeesUsd: 0 },
  "mm-claude": { name: "MM Claude", type: "mm", status: "quoting", equityUsd: 2250.0, pnlPct: 0.0, spreadCapturedUsd: 0, hedgeCostUsd: 0, netDeltaUsd: 0, strikeVolumeUsd: 0, builderFeesUsd: 0 },
  "citizen-a": { name: "Citizen A", type: "citizen", status: "quoting", equityUsd: 500, pnlPct: 0 },
  "citizen-b": { name: "Citizen B", type: "citizen", status: "quoting", equityUsd: 500, pnlPct: 0 },
  rogue: { name: "Rogue", type: "rogue", status: "frozen", equityUsd: 300, pnlPct: 0 },
};
for (const [id, a] of Object.entries(agents)) {
  s.agent(id, {
    ...a,
    wallets: { cardano: `addr_test1…${id}`, midnight: "hidden" },
    mandate: { hash: "7d2c…" + id, maxNetDeltaUsd: 150, hedgeWithinSec: 30, maxQuoteUsd: 150 },
    proof: { lastAttestation: iso(-3_600_000), verifyUrl: "https://api.preprod.odatano.dev/…", badges: id === "rogue" ? [] : ["no-violations", "delta-held", "hedged-in-time", "allowed-venues"] },
  });
}
s.setMark(mark);
s.setSponsor(true);
s.capital({
  balanceUsd: 2272.93, depositedUsd: 2273.06, feesUsd: -0.13, fundingUsd: 0.0019, asOf: iso(),
  trailHash: "c0ffee".padEnd(64, "0"),
  deposits: [{
    requestId: "9c4d5f0b-f763-4f7f-8671-f2eabdb85550", status: "settled", chain: "cardano", asset: "ADA", lovelace: 10_000_000_000, usd: 2273.06, usdPerAda: 0.227306, settledAt: "2026-10-21T14:58:06Z", ownerAddress: "d19dd79b…",
    hops: [
      { label: "owner → Strike intake", txHash: "2a4b2776f4835c872c31c253a52d5bf2eec03ca7623b7efc216ad2582906d897", block: 5318563, time: "2026-10-21T14:57:09Z", inputs: [{ address: "addr_test1qrgem4…sqljhzv", lovelace: 20_000_000_000, from: "aaaaaaaa#1" }], outputs: [{ address: "addr_test1qrgem4…sqljhzv", lovelace: 9_997_822_047, datum: false }, { address: "addr_test1qzs2ll…", lovelace: 10_002_000_000, datum: true }], memo: null },
      { label: "Strike intake → vault", txHash: "f0e6f413b0bca92f0f044e6d123f449fefed43f51336fcf3f52d44fd6ef5e8c0", block: 5318564, time: "2026-10-21T14:58:06Z", inputs: [{ address: "addr_test1qzs2ll…", lovelace: 10_002_000_000, from: "2a4b2776#0" }], outputs: [{ address: "addr_test1qrgem4…sqljhzv", lovelace: 1_820_243, datum: false }, { address: "addr_test1wrprva…", lovelace: 10_000_000_000, datum: true }], memo: "Strike V2 Deposit Refund | Request ID: 9c4d5f0b-… | Asset: ADA" },
      { label: "vault settlement", txHash: "3d5aa67bbed506a5004eb42402fb1ee37c4e2d8a702e6fc84d6b521c258959e1", block: 5318573, time: "2026-10-21T15:00:28Z", inputs: [{ address: "addr_test1wrprva…", lovelace: 10_000_000_000, from: "f0e6f413#0" }], outputs: [{ address: "addr_test1wqgwwc…", lovelace: 184_583_345_577, datum: true }], memo: null },
    ],
  }],
});

function tick() {
  n += 1;
  mark = Math.round(mark * (1 + (Math.random() - 0.5) * 0.002));
  s.setMark(mark);
  const maker = n % 2 ? "mm-rule" : "mm-claude";
  const side = n % 3 ? "ask" : "bid";
  const price = side === "ask" ? mark * 1.0025 : mark * 0.9975;
  const quoteId = `q-${n}`;
  s.quoteOpen({ quoteId, agentId: maker, side, pair: "tBTC/tUSD", price: Math.round(price * 10) / 10, sizeBtc: 0.0007, expiresAt: iso(300_000) });
  s.decision({ ts: iso(), agentId: maker, action: "post_quote", reason: n % 2 ? "Spread 25 bps around the mark, size inside the cap." : "Funding is flat; I lean the ask a little wider.", quoteId });
  if (n % 2 === 0) {
    const old = `q-${n - 1}`;
    s.quoteGone(old);
    const latencySec = Math.round((3 + Math.random() * 9) * 10) / 10;
    s.fill({ ts: iso(), quoteId: old, agentId: "mm-rule", txHash: "ab".repeat(32), midnight: { side: "sell", sizeBtc: 0.0007, price: Math.round(mark * 1.0025) }, strikeHedge: { side: "buy", sizeUsd: Math.round(mark * 0.0007 * 100) / 100, price: mark, latencySec } });
    const a = agents["mm-rule"];
    a.spreadCapturedUsd = Math.round((a.spreadCapturedUsd + mark * 0.0007 * 0.0025) * 100) / 100;
    a.hedgeCostUsd = Math.round((a.hedgeCostUsd + mark * 0.0007 * 0.0005) * 100) / 100;
    a.strikeVolumeUsd = Math.round(a.strikeVolumeUsd + mark * 0.0007);
    a.pnlPct = Math.round((a.spreadCapturedUsd - a.hedgeCostUsd) / a.equityUsd * 10000) / 100;
    s.agent("mm-rule", { ...a, netDeltaUsd: Math.round((Math.random() - 0.5) * 20 * 100) / 100 });
  }
  if (n % 4 === 0) {
    const refusals = [["midnight.maxSpreadBps", 100, 450], ["strike.maxPositionUsd", 150, 600], ["risk.maxNetDeltaUsd", 50, 75], ["midnight.maxOpenQuotes", 2, 3], ["strike.priceBandPct", 2, 5]];
    const [rule, limit, attempted] = refusals[(n / 4) % refusals.length];
    s.refusal({ ts: iso(), agentId: "rogue", venue: rule.startsWith("strike") ? "strike" : "midnight", rule, limit, attempted });
  }
}
tick();
setInterval(tick, 5000);
const server = await feedServer(s, { port, host: "0.0.0.0" });
console.log(`mock feed on http://localhost:${server.address().port}/feed/{meta,agents,quotes,fills,decisions,refusals,proofs,capital}`);
