#!/usr/bin/env node
/**
 * A feed with made-up numbers in the live feed's shapes, for building the
 * arena before the gateway runs. Every few seconds the mark moves, a quote
 * appears, a fill lands and its hedge follows, the rogue is refused.
 *
 *   npm run mock-feed [-- --port 4481]
 */
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { feedServer, feedState } from "../gateway/feed.mjs";
import { profiles } from "../agents/profiles.mjs";

const portArg = process.argv.indexOf("--port");
const port = portArg < 0 ? 4481 : Number(process.argv[portArg + 1]);
const s = feedState({ runStart: new Date().toISOString() });
let mark = 84_200;
let n = 0;
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const hex = (seed, len = 64) => seed.repeat(len).slice(0, len);
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const round2 = (x) => Math.round(x * 100) / 100;
const SPREAD_BPS = 25; // each side's distance from the mark

// the built-ins' mandates as the gateway ships them, so the cards carry `mandate.full` as live
const FULL = profiles({ owner: `addr_test1q${hex("owner", 52)}`, expiry: iso(3 * 86_400_000) });
const mandate = (id) => { const m = FULL[id]; return { hash: sha(`mandate:${id}`), maxNetDeltaUsd: m.risk.maxNetDeltaUsd, hedgeWithinSec: m.risk.hedgeWithinSec, maxQuoteUsd: m.midnight.maxQuoteUsd, maxPositionUsd: m.strike.maxPositionUsd, full: m }; };
const leg = (mark) => ({ pair: "tBTC/tUSD", mark, inventoryBtc: 0, strikePositionBtc: 0, netDeltaUsd: 0, unhedgedUsd: 0, openQuotes: 0, pending: 0, resting: 0, frozen: false });
const maker = (id, mind, strikeEquityUsd) => ({ name: id, type: "mm", mind, status: "quoting", stoppedReason: null, mandate: mandate(id), equityUsd: round2(390.45 + 0.0035 * mark + strikeEquityUsd), equityStartUsd: round2(390.45 + 0.0035 * mark + strikeEquityUsd), strikeEquityUsd, pnlPct: 0, spreadCapturedUsd: 0, hedgeCostUsd: 0, netDeltaUsd: 0, unhedgedUsd: 0, strikePositionBtc: 0, strikeVolumeUsd: 0, builderFeesUsd: 0, hedges: 0, maxHedgeLatencySec: 0, pending: 0, resting: 0, legs: { "BTC-USD": leg(mark) }, day: iso().slice(0, 10) });
const agents = {
  "mm-rule": maker("mm-rule", "rules", 386.06),
  "mm-claude": maker("mm-claude", "claude", 385.96),
  "citizen-a": { name: "citizen-a", type: "citizen", mind: "rules", status: "watching", mandate: mandate("citizen-a"), equityUsd: 500, pnlPct: 0 },
  "citizen-b": { name: "citizen-b", type: "citizen", mind: "rules", status: "watching", mandate: mandate("citizen-b"), equityUsd: 500, pnlPct: 0 },
  rogue: { name: "rogue", type: "rogue", mind: "rules", status: "probing", mandate: mandate("rogue"), equityUsd: 192.49, pnlPct: 0 },
};
const holdings = () => ({ btc: 0.0035, usd: 390.45, reservedUsd: 0, openQuotes: 0, bases: { "tBTC/tUSD": 0.0035 } });
for (const [id, a] of Object.entries(agents)) {
  s.agent(id, { ...a, midnight: holdings(), wallets: { cardano: `addr_test1q${hex(id.replace(/-/g, ""), 52)}`, midnight: "hidden" }, onboarding: null });
  if (a.type !== "citizen") {
    // the rogue is reconciled like a maker (no fills, no violations of its own) but earns no badges: it never trades
    s.proof(id, {
      attesterId: sha(`attester:${id}`), vault: hex("e7ffe63b"),
      mandate: { payloadHash: hex("8b0f8ce6"), txHash: hex("009e42cc"), status: "succeeded", verified: true, at: iso(-3_600_000) },
      lastAttestation: { at: iso(-600_000), window: { from: iso(-1_200_000), to: iso(-600_000) }, payloadHash: hex("a1b2c3d4"), txHash: hex("0f1e2d3c"), status: "succeeded", verified: true, decisions: 12, fills: id === "rogue" ? 0 : 2 },
      reconciled: iso(-300_000),
      claims: id === "rogue" ? { violations: 0, maxNetDeltaUsd: 0, maxFillToHedgeSec: 0, venuesOutsideMandate: 0 } : { violations: 0, maxNetDeltaUsd: 118.2, maxFillToHedgeSec: 10, venuesOutsideMandate: 0 },
      violations: [],
      counts: id === "rogue" ? { midnightFills: 0, hedgesPlaced: 0, hedgesFilled: 0, strikeFills: 0, refusals: 12 } : { midnightFills: 7, hedgesPlaced: 6, hedgesFilled: 5, strikeFills: 5, refusals: 0 },
      logChain: "934 entries this run, chain intact",
      ...(id === "rogue" ? {} : {
        badges: {
          at: iso(-240_000), agentId: id, attesterId: sha(`attester:${id}`), payloadHash: sha(`badges:${id}`), contentRoot: sha(`root:${id}`), anchor: { txHash: hex("00a1b2c3"), status: "succeeded" }, root: { txHash: hex("00d4e5f6"), status: "succeeded" },
          earned: ["no-violations", "delta-held", "hedged-in-time", "allowed-venues"],
          claims: [
            { badge: "no-violations", field: "claims.violations", predicate: "lessOrEqual", threshold: 0, value: 0, status: "succeeded", txHash: hex("00b1"), verified: true, earned: true },
            { badge: "delta-held", field: "claims.maxNetDeltaUsd", predicate: "lessOrEqual", threshold: 150, value: 118.2, status: "succeeded", txHash: hex("00b2"), verified: true, earned: true },
            { badge: "hedged-in-time", field: "claims.maxFillToHedgeSec", predicate: "lessOrEqual", threshold: 120, value: 10, status: "succeeded", txHash: hex("00b3"), verified: true, earned: true },
            { badge: "allowed-venues", field: "claims.venuesOutsideMandate", predicate: "lessOrEqual", threshold: 0, value: 0, status: "succeeded", txHash: hex("00b4"), verified: true, earned: true },
          ],
        },
      }),
    });
  }
}
// the three markets' marks, as the gateway sets them every round; ADA and SOL drift on their own
const marks = { "BTC-USD": mark, "ADA-USD": 0.2126, "SOL-USD": 83.4 };
const setMarks = () => s.setMarks(Object.fromEntries(Object.entries(marks).map(([sym, m]) => [sym, { mark: m, funding: 0.00001 }])));
setMarks();
s.setSponsor(true);
s.setLiquidity("flint testnet liquidity account: stands in for the empty testnet book");
s.setBoard("server");
s.setAttestEvery(60_000);
s.setTools({ url: "https://flint-gateway.example/mcp/", prices: { post_quote: "1000000", take_quote: "1000000", place_order: "1000000", hedge: "2000000" }, paid: true });
s.setOwner(false);
s.setOrders({ feeAda: 20, feeClaudeAda: 40, keyAda: 0, minDepositAda: 500, minTopUpAda: 50, payTo: `addr_test1v${hex("qcz4", 50)}`, x402: false });
s.capital({
  balanceUsd: 2272.93, depositedUsd: 2273.06, feesUsd: -0.13, fundingUsd: 0.0019, asOf: iso(),
  trailHash: hex("c0ffee"),
  deposits: [{
    requestId: "9c4d5f0b-f763-4f7f-8671-f2eabdb85550", status: "settled", chain: "cardano", asset: "ADA", lovelace: 10_000_000_000, usd: 2273.06, usdPerAda: 0.227306, settledAt: "2026-10-21T14:58:06Z", ownerAddress: "d19dd79b…",
    hops: [
      { label: "owner → Strike intake", txHash: "2a4b2776f4835c872c31c253a52d5bf2eec03ca7623b7efc216ad2582906d897", block: 5318563, time: "2026-10-21T14:57:09Z", inputs: [{ address: "addr_test1qrgem4…sqljhzv", lovelace: 20_000_000_000, from: "aaaaaaaa#1" }], outputs: [{ address: "addr_test1qrgem4…sqljhzv", lovelace: 9_997_822_047, datum: false }, { address: "addr_test1qzs2ll…", lovelace: 10_002_000_000, datum: true }], memo: null },
      { label: "Strike intake → vault", txHash: "f0e6f413b0bca92f0f044e6d123f449fefed43f51336fcf3f52d44fd6ef5e8c0", block: 5318564, time: "2026-10-21T14:58:06Z", inputs: [{ address: "addr_test1qzs2ll…", lovelace: 10_002_000_000, from: "2a4b2776#0" }], outputs: [{ address: "addr_test1qrgem4…sqljhzv", lovelace: 1_820_243, datum: false }, { address: "addr_test1wrprva…", lovelace: 10_000_000_000, datum: true }], memo: "Strike V2 Deposit Refund | Request ID: 9c4d5f0b-… | Asset: ADA" },
      { label: "vault settlement", txHash: "3d5aa67bbed506a5004eb42402fb1ee37c4e2d8a702e6fc84d6b521c258959e1", block: 5318573, time: "2026-10-21T15:00:28Z", inputs: [{ address: "addr_test1wrprva…", lovelace: 10_000_000_000, from: "f0e6f413#0" }], outputs: [{ address: "addr_test1wqgwwc…", lovelace: 184_583_345_577, datum: true }], memo: null },
    ],
  }],
});
const revenue = { calls: 0, lovelace: 0n, payTo: `addr_test1v${hex("qcz4", 50)}` };

const quoteOf = (maker, side) => ({ quoteId: `q-${n}`, agentId: maker, side, pair: "tBTC/tUSD", price: Math.round(mark * (1 + (side === "ask" ? 1 : -1) * SPREAD_BPS / 10_000) * 10) / 10, sizeBtc: 0.0014, expiresAt: iso(300_000) });

/** A citizen takes `q`; the maker's fill lands now, its hedge a few seconds later (or nets a fill of the other side). */
function fillAndHedge(q, taker) {
  s.quoteGone(q.quoteId);
  s.decision({ ts: iso(), agentId: taker, action: "midnight.take", side: q.side === "ask" ? "buy" : "sell", sizeBtc: q.sizeBtc, price: q.price, pair: q.pair, quoteId: q.quoteId, reason: `${q.side === "ask" ? "buys" : "sells"} ${q.sizeBtc} BTC at ${q.price}, ${SPREAD_BPS} bps off the mark` });
  const makerSide = q.side === "ask" ? "sell" : "buy";
  s.fill({ ts: iso(), agentId: q.agentId, quoteId: q.quoteId, txHash: hex(String(n).padStart(2, "0")), midnight: { side: makerSide, sizeBtc: q.sizeBtc, price: q.price, pair: q.pair } });
  const a = agents[q.agentId];
  a.spreadCapturedUsd = round2(a.spreadCapturedUsd + q.sizeBtc * mark * SPREAD_BPS / 10_000);
  const netted = n % 6 === 0;
  const latencySec = netted ? 0 : Math.round((3 + Math.random() * 9) * 10) / 10;
  a.pending = netted ? 0 : 1;
  a.status = netted ? "quoting" : "hedging";
  a.unhedgedUsd = netted ? 0 : round2(q.sizeBtc * mark * (makerSide === "sell" ? -1 : 1));
  Object.assign(a.legs["BTC-USD"], { pending: a.pending, unhedgedUsd: a.unhedgedUsd, inventoryBtc: round2(a.legs["BTC-USD"].inventoryBtc * 1e5 + (makerSide === "sell" ? -q.sizeBtc : q.sizeBtc) * 1e5) / 1e5 });
  s.agent(q.agentId, a);
  setTimeout(() => {
    const clientOrderId = `${q.agentId}-hedge-${n}-${Date.now()}`;
    if (!netted) {
      s.fill({ ts: iso(), agentId: q.agentId, strikeFill: { symbol: "BTC-USD", side: makerSide === "sell" ? "BUY" : "SELL", size: String(q.sizeBtc), price: String(mark), clientOrderId } });
      a.hedgeCostUsd = round2(a.hedgeCostUsd + q.sizeBtc * mark * 0.0008);
      a.strikeVolumeUsd = Math.round(a.strikeVolumeUsd + q.sizeBtc * mark);
      a.builderFeesUsd = round2(a.builderFeesUsd + q.sizeBtc * mark * 0.001);
      a.strikePositionBtc = Math.round((a.strikePositionBtc + (makerSide === "sell" ? q.sizeBtc : -q.sizeBtc)) * 1e8) / 1e8;
    }
    s.fillHedged(q.quoteId, { how: netted ? "netted" : "market", clientOrderIds: netted ? [] : [clientOrderId], price: netted ? null : mark, latencySec, at: iso() });
    a.hedges += 1;
    a.maxHedgeLatencySec = Math.max(a.maxHedgeLatencySec, latencySec);
    a.pending = 0;
    a.status = "quoting";
    a.unhedgedUsd = 0;
    a.netDeltaUsd = round2((Math.random() - 0.5) * 20);
    a.pnlPct = round2((a.spreadCapturedUsd - a.hedgeCostUsd) / a.equityUsd * 100);
    Object.assign(a.legs["BTC-USD"], { pending: 0, unhedgedUsd: 0, netDeltaUsd: a.netDeltaUsd, strikePositionBtc: a.strikePositionBtc });
    s.agent(q.agentId, a);
  }, netted ? 200 : latencySec * 1000);
}

function tick() {
  n += 1;
  mark = Math.round(mark * (1 + (Math.random() - 0.5) * 0.002));
  marks["BTC-USD"] = mark;
  marks["ADA-USD"] = Math.round(marks["ADA-USD"] * (1 + (Math.random() - 0.5) * 0.002) * 1e4) / 1e4;
  marks["SOL-USD"] = Math.round(marks["SOL-USD"] * (1 + (Math.random() - 0.5) * 0.002) * 100) / 100;
  setMarks();
  for (const id of ["mm-rule", "mm-claude"]) agents[id].legs["BTC-USD"].mark = mark;
  const maker = n % 2 ? "mm-rule" : "mm-claude";
  const side = n % 3 ? "ask" : "bid";
  const q = quoteOf(maker, side);
  s.quoteOpen(q);
  s.decision({ ts: iso(), agentId: maker, action: "midnight.quote", side, sizeBtc: q.sizeBtc, price: q.price, pair: q.pair, reason: maker === "mm-rule" ? `quoting ${side} ${SPREAD_BPS} bps off ${mark}` : `Funding is flat and hedges are fast, ${SPREAD_BPS} bps a side keeps fills coming. (quoting ${side} ${SPREAD_BPS} bps off ${mark})` });
  const open = s.get("quotes").quotes.filter((x) => x.agentId === maker).length;
  agents[maker].midnight = { ...holdings(), openQuotes: open, reservedUsd: round2(open * 0.0014 * mark) };
  agents[maker].legs["BTC-USD"].openQuotes = open;
  s.agent(maker, agents[maker]);
  if (n % 2 === 0) fillAndHedge({ ...quoteOf(n % 4 ? "mm-rule" : "mm-claude", n % 3 ? "ask" : "bid"), quoteId: `q-${n - 1}` }, n % 3 ? "citizen-a" : "citizen-b");
  if (n % 4 === 0) {
    const refusals = [["midnight.maxSpreadBps", 100, 450, "quote"], ["strike.maxPositionUsd", 150, 600, "order"], ["risk.maxNetDeltaUsd", 50, 75, "order"], ["midnight.maxOpenQuotes", 2, 3, "quote"], ["strike.priceBandPct", 2, 5, "order"]];
    const [rule, limit, attempted, action] = refusals[(n / 4) % refusals.length];
    s.refusal({ ts: iso(), agentId: "rogue", venue: rule.startsWith("strike") ? "strike" : "midnight", rule, limit, attempted, action, pair: "tBTC/tUSD", symbol: "BTC-USD" });
  }
  if (n % 10 === 0) {
    revenue.calls += 1;
    revenue.lovelace += 1_000_000n;
    s.revenue({ calls: revenue.calls, lovelace: String(revenue.lovelace), payTo: revenue.payTo, last: { ts: iso(), tool: "post_quote", agent: "mm-rule", txHash: hex("698d603e"), payer: `addr_test1q${hex("rcrf", 52)}` } });
  }
}
tick();
setInterval(tick, 5000);
const server = await feedServer(s, { port, host: "0.0.0.0", staticDir: fileURLToPath(new URL("../arena/", import.meta.url)) });
console.log(`mock feed on http://localhost:${server.address().port}/feed/{meta,agents,quotes,fills,decisions,refusals,proofs,capital,revenue}`);
