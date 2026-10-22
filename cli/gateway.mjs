#!/usr/bin/env node
/**
 * Run the gateway on preprod and Strike testnet: the agents' NIGHTGATE
 * servers, their Strike keys, the feed, the decision log.
 *
 *   npm run gateway -- [--rounds N] [--round-ms 20000] [--agents mm-rule,citizen-a] [--port 4481]
 *
 * An agent's Midnight wallet is trader index i in the order of agents/profiles.mjs,
 * or the index given as `name:i`; its Strike key is STRIKE_KEY_<AGENT>
 * (mm-rule → STRIKE_KEY_MM_RULE), or STRIKE_KEY. The rogue (`rogue:4`) needs
 * a wallet but no coins: every attempt is refused before anything is built.
 */
import fs from "node:fs";
import path from "node:path";
import { midnightSeedOf, secretFor } from "../lib/identity.mjs";
import { cardanoWallet } from "../gateway/cardano.mjs";
import { loadFactory, settings, tokenTypes } from "../market/chain.mjs";
import { openMcpTrader } from "../market/mcp-trader.mjs";
import { strikeClient, TESTNET } from "../gateway/strike.mjs";
const strikePositions = {};
import { userStream } from "../gateway/strike-stream.mjs";
import { midnightVenue } from "../gateway/midnight.mjs";
import { feedServer, feedState } from "../gateway/feed.mjs";
import { decisionLog } from "../gateway/log.mjs";
import { gateway } from "../gateway/gateway.mjs";
import { toolServer } from "../gateway/tools.mjs";
import { charge } from "../gateway/x402.mjs";
import { attester, mandateEnvelope, windowEnvelope } from "../gateway/attest.mjs";
import { mandateHash } from "../gateway/mandate.mjs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { capitalTrail, koiosTxInfo } from "../gateway/capital.mjs";
import { reconcile } from "../gateway/reconcile.mjs";
import { verifyLog } from "../gateway/log.mjs";
import { profiles } from "../agents/profiles.mjs";
import { claudeMaker } from "../agents/claude-maker.mjs";
import { fileBudget, fileJournal } from "../market/llm-trader.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i < 0 ? dflt : args[i + 1]; };
const rounds = Number(opt("rounds", 0));
const roundMs = Number(opt("round-ms", 20_000));
const port = Number(opt("port", 4481));
const toolsPort = Number(opt("tools-port", 0));
const names = opt("agents", "mm-rule,citizen-a,citizen-b").split(",");
for (const a of args.filter((x) => x.startsWith("--"))) if (!["--rounds", "--round-ms", "--agents", "--port", "--tools-port"].includes(a)) { console.error(`unknown option ${a}`); process.exit(2); }

const log = (...x) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...x);
const ACCOUNTS = path.join("data", "strike-accounts.json");
const strikeAccounts = fs.existsSync(ACCOUNTS) ? JSON.parse(fs.readFileSync(ACCOUNTS, "utf8")) : {};
/** Strike's testnet answers 503 now and then; a startup call tries again a few times before giving up. */
async function patient(what, fn, { tries = 6, waitMs = 10_000 } = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      if (i >= tries) throw err;
      log(`${what}: ${err.message.slice(0, 120).replace(/\s+/g, " ")}; try ${i + 1} of ${tries} in ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
const cfg = settings();
const pkg = await loadFactory({ log });
const [tBTC, tUSD] = await tokenTypes(cfg, pkg.pureCircuits);
const types = { tBTC: tBTC.type, tUSD: tUSD.type };
const all = profiles({ owner: process.env.OWNER_ADDRESS || "addr_test1…owner", expiry: new Date(Date.now() + 3 * 86_400_000).toISOString() });
// test settings: a wider hedge deadline and position cap than the shipped profiles, for an empty testnet book
for (const m of Object.values(all)) {
  if (process.env.HEDGE_WITHIN_SEC) m.risk.hedgeWithinSec = Number(process.env.HEDGE_WITHIN_SEC);
  if (process.env.MAX_POSITION_USD && m.strike.maxPositionUsd > 0) m.strike.maxPositionUsd = Number(process.env.MAX_POSITION_USD);
}
const order = Object.keys(all);
const minds = { "mm-rule": "maker", "mm-claude": "maker", "citizen-a": "citizen", "citizen-b": "citizen", rogue: "rogue" };
// the agent's Cardano wallet, as cli/onboard.mjs derives it; its Midnight address stays hidden
const hex = (u8) => Buffer.from(u8).toString("hex");
const walletsOf = (agentId) => ({ cardano: cardanoWallet(hex(secretFor(cfg.master, "cardano", agentId)), { stakeSeedHex: hex(secretFor(cfg.master, "cardano-stake", agentId)) }).address, midnight: "hidden" });
const sides = { "citizen-a": "auto", "citizen-b": "auto" };

const agents = [];
for (const spec of names) {
  const [agentId, given] = spec.split(":");
  const index = given !== undefined ? Number(given) : order.indexOf(agentId);
  if (!(agentId in all) || !Number.isInteger(index) || index < 0) { console.error(`unknown agent ${spec}`); process.exit(2); }
  const mandate = all[agentId];
  const name = `trader-${index}`;
  const t0 = Date.now();
  const trader = await openMcpTrader({ name, seedHex: midnightSeedOf(cfg.master, index), key: cfg.nightgateKey, cfg, index, onProgress: (p) => { if (p.seconds % 30 === 0) log(`${agentId}: wallet syncing, ${p.seconds}s`); } });
  log(`${agentId}: wallet ready in ${Math.round((Date.now() - t0) / 1000)}s`);
  const venue = midnightVenue({ trader, agentId, types, log: (e) => entries.append({ agent: agentId, ...e }) });
  // an agent that onboarded itself (cli/onboard.mjs) trades on its own Strike account with its builder fee; else the shared key
  const own = strikeAccounts[agentId];
  const keyName = `STRIKE_KEY_${agentId.toUpperCase().replace(/-/g, "_")}`;
  const privateKeyHex = minds[agentId] === "maker" || minds[agentId] === "rogue" ? (own?.apiWalletPrivateKeyHex || process.env[keyName] || process.env.STRIKE_KEY) : null;
  let strike = null, stream = null, keyUsed = privateKeyHex;
  if (privateKeyHex) {
    const builderFeeBps = own ? Math.min(own.feeShareBps ?? 0, Number(process.env.STRIKE_BUILDER_FEE_BPS || own.feeShareBps || 0)) : (process.env.STRIKE_BUILDER_FEE_BPS ? Number(process.env.STRIKE_BUILDER_FEE_BPS) : undefined);
    strike = strikeClient({ baseUrl: process.env.STRIKE_API_URL || TESTNET, privateKeyHex, builderFeeBps });
    if (own) {
      // an own account without balance cannot hedge yet: fall back to the shared key for this run
      await patient(`${agentId}: Strike clock`, () => strike.syncClock());
      const bal = Number((await patient(`${agentId}: Strike balance`, () => strike.balances()))[0]?.walletBalance ?? 0);
      if (bal > 0) log(`${agentId}: own Strike account ${own.accountId} with ${bal} USD, builder ${own.builderCode} at ${builderFeeBps} bps`);
      else if (process.env.STRIKE_KEY) { log(`${agentId}: own Strike account ${own.accountId} holds 0 USD; using the shared key this run`); keyUsed = process.env.STRIKE_KEY; strike = strikeClient({ baseUrl: process.env.STRIKE_API_URL || TESTNET, privateKeyHex: keyUsed }); }
      else log(`${agentId}: own Strike account ${own.accountId} holds 0 USD and there is no shared key: hedges will be rejected`);
    }
    await patient(`${agentId}: Strike clock`, () => strike.syncClock());
    const symbols = await patient(`${agentId}: Strike symbols`, () => strike.symbols());
    const lev = symbols.symbol_settings?.["BTC-USD"]?.leverage ?? symbols.default_leverage;
    if (lev > mandate.strike.maxLeverage) { await patient(`${agentId}: Strike leverage`, () => strike.setLeverage("BTC-USD", mandate.strike.maxLeverage)); log(`${agentId}: Strike leverage set to ${mandate.strike.maxLeverage}`); }
    stream = (onEvent, onStatus) => userStream({ baseUrl: strike.baseUrl, privateKeyHex: keyUsed, onEvent, onStatus: (x) => { log(`${agentId}: strike stream ${x.state}${x.message ? ` ${x.message}` : ""}`); onStatus?.(x); } });
    // the books' Strike position is what Strike says it is, not what an earlier run on another account recorded
    const pos = (await patient(`${agentId}: Strike positions`, () => strike.positions())).positions?.find((p) => p.symbol === "BTC-USD");
    strikePositions[agentId] = pos ? Number(pos.size) : 0;
  } else if (minds[agentId] === "maker") {
    log(`${agentId}: no Strike key (${keyName} or STRIKE_KEY); it will quote without a hedge and freeze on the first fill`);
  }
  let brain = null;
  if (agentId === "mm-claude") {
    if (!process.env.ANTHROPIC_API_KEY) log(`${agentId}: no ANTHROPIC_API_KEY; the rules run it`);
    else {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      brain = claudeMaker({ client: new Anthropic(), model: process.env.CLAUDE_MODEL || "claude-haiku-5-5", budget: fileBudget({ limit: Number(process.env.CLAUDE_BUDGET || 300) }), journal: fileJournal() });
    }
  }
  // a citizen looks every round and acts on about half of them; a maker quotes 120 USD a side, above Strike's minimum and inside what a citizen's coins pay
  // the shared key serves every maker without an account of its own: its fills and position are not one agent's
  agents.push({ agentId, name: agentId, mandate, mind: minds[agentId], side: sides[agentId], venue, strike, stream, sharedStrike: Boolean(keyUsed) && keyUsed === process.env.STRIKE_KEY, wallets: walletsOf(agentId), trader, brain, leverage: mandate.strike.maxLeverage, options: minds[agentId] === "citizen" ? { rate: Number(process.env.CITIZEN_RATE || 0.5) } : { sizeUsd: Number(process.env.MAKER_SIZE_USD || 120) } });
}

const entries = decisionLog(path.join("data", "decisions.jsonl"));
const runStart = entries.append({ kind: "run.start", agents: names, books: {} });
// the hedgers' books outlive a run: unhedged inventory and a freeze are not forgotten on restart
const BOOKS = path.join("data", "books.json");
const books = fs.existsSync(BOOKS) ? JSON.parse(fs.readFileSync(BOOKS, "utf8")) : {};
const saveBooks = (agentId, snap) => { books[agentId] = snap; fs.writeFileSync(BOOKS, JSON.stringify(books, null, 1)); };
// Strike's position wins over the books; what inventory and position then leave open is unhedged again (another account's hedge no longer counts)
for (const [id, size] of Object.entries(strikePositions)) {
  const b = books[id];
  if (!b || b.strikePositionBtc === size) continue;
  const open = Math.round((b.midnightInventoryBtc + size) * 1e8) / 1e8;
  log(`${id}: Strike position is ${size} BTC, the books said ${b.strikePositionBtc}: taking Strike's number, ${open} BTC unhedged`);
  b.strikePositionBtc = size;
  b.unhedgedBtc = Math.abs(open) >= 0.00001 ? open : 0;
}
runStart.books = structuredClone(books);
for (const [id, b] of Object.entries(books)) if (names.some((n) => n.split(":")[0] === id)) log(`${id}: books from the last run: inventory ${b.midnightInventoryBtc} BTC, Strike ${b.strikePositionBtc} BTC, unhedged ${b.unhedgedBtc} BTC${b.frozen ? `, frozen (${b.frozenReason})` : ""}`);
const feed = feedState();
feed.setLiquidity(process.env.STRIKE_LIQUIDITY_NOTE || null);
const server = await feedServer(feed, { port, host: "0.0.0.0" });
log(`feed on http://localhost:${server.address().port}/feed/meta`);
const pub = strikeClient({ baseUrl: process.env.STRIKE_API_URL || TESTNET });
const mark = async () => { const p = await pub.markPrice("BTC-USD"); return { mark: Number(p.p), funding: Number(p.r) }; };
// a quote smaller than Strike's minimum order could never be hedged
const minHedgeUsd = Number((await patient("Strike market rules", () => pub.market("BTC-USD"))).order_min_notional ?? 0);
log(`Strike minimum hedge notional: ${minHedgeUsd} USD`);

const g = gateway({ agents, mark, feed, books, saveBooks, minHedgeUsd, log: (e) => { const full = entries.append(e); log(`${e.agent ?? "gateway"}: ${e.kind}${e.rule ? ` ${e.rule}` : ""}${e.reason ? ` — ${e.reason}` : ""}${e.error ? ` — ${e.error}` : ""}`); return full; } });

async function shutdown() {
  log("stopping: retiring quotes, closing wallets");
  await g.stop();
  await refreshReconcile().catch((err) => log(`reconcile: ${err.message}`));
  await attestBadges().catch((err) => log(`badges: ${err.message}`));
  for (const a of agents) await a.trader.close().catch(() => {});
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// the capital trail: Strike's deposit record and its Cardano transactions, refreshed every ten minutes
const treasurer = agents.find((a) => a.strike)?.strike ?? null;
async function refreshCapital() {
  if (!treasurer) return;
  try {
    const c = await capitalTrail({ history: () => treasurer.transactions(), txInfo: koiosTxInfo, balance: async () => Number((await treasurer.balances())[0]?.walletBalance ?? 0) });
    feed.capital(c);
    log(`capital: ${c.deposits.length} deposit(s), ${c.depositedUsd} USD in, balance ${c.balanceUsd} USD, fees ${c.feesUsd}, funding ${c.fundingUsd}`);
  } catch (err) { log(`capital: ${err.message}`); }
}
await refreshCapital();
setInterval(refreshCapital, 600_000).unref();

// attestations on the vault: the mandate anchor once, then a window every ATTEST_EVERY_ROUNDS rounds, per maker
const VAULT = process.env.ATTESTATION_VAULT || null;
const attestEvery = Number(process.env.ATTEST_EVERY_ROUNDS || 10);
const attesters = new Map();
const attestDir = path.join("data", "attestations");
let windowFrom = new Date().toISOString();
async function anchorMandates() {
  if (!VAULT) { log("no ATTESTATION_VAULT: attestations off"); return; }
  fs.mkdirSync(attestDir, { recursive: true });
  for (const a of agents) {
    if (!a.strike) continue;
    const at = attester({ call: (tool, args) => a.trader.call(tool, args), contractAddress: VAULT, artifact: process.env.ATTESTATION_ARTIFACT || "attestation-vault-32", waitForJob: (jobId, sessionId) => import("../market/chain.mjs").then((m) => m.waitForJob(cfg, jobId, sessionId, { timeoutMs: 300_000 })), log: (e) => entries.append({ agent: a.agentId, ...e }) });
    attesters.set(a.agentId, at);
    try {
      const id = await at.identity();
      const m = mandateEnvelope({ agentId: a.agentId, mandateHash: mandateHash(a.mandate) });
      const r = await at.attest({ ...m, label: "mandate" });
      fs.writeFileSync(path.join(attestDir, `${a.agentId}-mandate.json`), JSON.stringify({ mandate: a.mandate, ...r }, null, 1));
      const v = r.status === "succeeded" ? await at.verify({ payloadHash: m.payloadHash }).catch((err) => ({ verified: false, error: err.message })) : { verified: false };
      feed.proof(a.agentId, { attesterId: id.attesterId, vault: VAULT, mandate: { payloadHash: m.payloadHash, txHash: r.txHash, status: r.status, verified: v.verified, at: r.at } });
      log(`${a.agentId}: mandate anchored on the vault: ${r.status}${r.txHash ? ` tx ${r.txHash.slice(0, 16)}…` : ""}, verified ${v.verified}, proving ${Math.round(r.provingMs / 1000)}s`);
    } catch (err) { log(`${a.agentId}: mandate anchor failed: ${err.message.slice(0, 160)}`); }
  }
}
async function attestWindow() {
  if (!VAULT) return;
  const to = new Date().toISOString();
  const file = path.join("data", "decisions.jsonl");
  const all = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.ts >= windowFrom && e.ts <= to);
  for (const [agentId, at] of attesters) {
    const a = agents.find((x) => x.agentId === agentId);
    const mine = all.filter((e) => e.agent === agentId);
    const w = windowEnvelope({
      agentId, policyHash: mandateHash(a.mandate), from: windowFrom, to,
      marks: mine.filter((e) => e.kind === "decision" && e.mark).map((e) => e.mark),
      decisions: mine.filter((e) => e.kind === "decision").map(({ hash, prev, ...e }) => e),
      fills: mine.filter((e) => e.kind === "fill").map(({ hash, prev, ...e }) => e),
      hedges: mine.filter((e) => /^hedge\./.test(e.kind)).map(({ hash, prev, ...e }) => e),
      refusals: mine.filter((e) => e.kind === "refusal").map(({ hash, prev, ...e }) => e),
      capitalTrailHash: feed.get("capital")?.trailHash ?? null,
    });
    // an empty window has nothing to attest, and the sponsor's hour has only 60 transactions
    if (w.envelope.outputs.decisions + w.envelope.outputs.fills + w.envelope.outputs.refusals === 0) continue;
    try {
      const r = await at.attest({ payloadHash: w.payloadHash, metadataHash: w.metadataHash, label: "window" });
      fs.writeFileSync(path.join(attestDir, `${agentId}-${to.replace(/[:.]/g, "-")}.json`), JSON.stringify({ ...w, ...r }, null, 1));
      const v = r.status === "succeeded" ? await at.verify({ payloadHash: w.payloadHash }).catch((err) => ({ verified: false, error: err.message })) : { verified: false };
      feed.proof(agentId, { lastAttestation: { at: r.at, window: { from: windowFrom, to }, payloadHash: w.payloadHash, txHash: r.txHash, status: r.status, verified: v.verified, decisions: w.envelope.outputs.decisions, fills: w.envelope.outputs.fills } });
      log(`${agentId}: window attested: ${r.status}${r.txHash ? ` tx ${r.txHash.slice(0, 16)}…` : ""}, verified ${v.verified}, ${w.envelope.outputs.decisions} decisions, ${w.envelope.outputs.fills} fills`);
    } catch (err) { log(`${agentId}: window attestation failed: ${err.message.slice(0, 160)}`); }
  }
  windowFrom = to;
}

// the badges: the latest reconciler report of each maker proven on the vault, at shutdown and every BADGES_EVERY_ROUNDS rounds
const badgesEvery = Number(process.env.BADGES_EVERY_ROUNDS || 30);
const lastReconcile = new Map();
let badgesBusy = false;
async function attestBadges() {
  if (!VAULT || badgesBusy) return;
  badgesBusy = true;
  try {
    for (const [agentId, at] of attesters) {
      const a = agents.find((x) => x.agentId === agentId);
      const r = lastReconcile.get(agentId);
      // the sponsor allows 60 transactions an hour: badges only for a maker that has fills to prove
      if (!a || !r || minds[agentId] !== "maker" || !(r.counts?.midnightFills > 0)) continue;
      try {
        const b = await at.badges({ agentId, mandate: a.mandate, mandateHash: mandateHash(a.mandate), runStart: runStart.ts, asOf: r.asOf, claims: r.claims, counts: r.counts });
        fs.writeFileSync(path.join(attestDir, `${agentId}-badges-${b.at.replace(/[:.]/g, "-")}.json`), JSON.stringify(b, null, 1));
        const { witness, document, ...pub } = b;
        feed.proof(agentId, { badges: pub });
        log(`${agentId}: badges on chain: ${b.earned.length ? b.earned.join(", ") : "none earned"}; ${b.claims.map((c) => `${c.badge} ${c.status}${c.verified ? " verified" : ""}`).join(", ")}`);
      } catch (err) { log(`${agentId}: badges failed: ${err.message.slice(0, 160)}`); }
    }
  } finally { badgesBusy = false; }
}

// the reconciler: this run's decision log against Strike's own fill history, per maker; the four badge claims go to the feed
async function refreshReconcile() {
  const file = path.join("data", "decisions.jsonl");
  const chain = verifyLog(file);
  const whole = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  // this run only: from its own run.start entry
  const all = whole.slice(whole.findIndex((e) => e.kind === "run.start" && e.seq === runStart.seq));
  const report = { asOf: new Date().toISOString(), log: chain, agents: {} };
  for (const a of agents) {
    if (!a.strike) continue;
    try {
      // this run's hedges only: Strike keeps every fill ever, the log starts at run.start
      const since = Date.parse(runStart.ts);
      const fills = ((await a.strike.fills({ symbol: a.mandate.strike.markets[0], limit: 500 })).fills ?? []).filter((f) => typeof f.client_order_id === "string" && f.client_order_id.startsWith(`${a.agentId}-`) && Number(f.timestamp ?? 0) >= since);
      const entries = all.filter((e) => e.agent === a.agentId);
      const carried = runStart.books[a.agentId] ?? {};
      const r = reconcile({ entries, strikeFills: fills, mandate: a.mandate, startDeltaBtc: (carried.midnightInventoryBtc ?? 0) + (carried.strikePositionBtc ?? 0) });
      report.agents[a.agentId] = { ok: r.ok, counts: r.counts, claims: r.claims, violations: r.violations, maxLatencyMs: r.maxLatencyMs };
      lastReconcile.set(a.agentId, { asOf: report.asOf, claims: r.claims, counts: r.counts });
      feed.proof(a.agentId, { reconciled: report.asOf, claims: r.claims, violations: r.violations.length, counts: r.counts, logChain: chain.ok ? `${chain.entries} entries, chain intact` : `broken at ${chain.brokenAt}` });
      log(`${a.agentId}: reconcile — ${r.ok ? "0 violations" : `${r.violations.length} violation(s): ${[...new Set(r.violations.map((v) => v.rule))].join(", ")}`}; ${r.counts.midnightFills} Midnight fills, ${r.counts.strikeFills} Strike fills, max fill-to-hedge ${Math.round(r.maxLatencyMs / 100) / 10}s; log ${chain.ok ? "intact" : "BROKEN"}`);
    } catch (err) { log(`${a.agentId}: reconcile: ${err.message}`); }
  }
  fs.writeFileSync(path.join("data", "reconcile.json"), JSON.stringify(report, null, 1));
}

// orders a previous run left on Strike are unknown to this one; the books carry their exposure, so pull them
for (const a of agents) if (a.strike) { const open = await patient(`${a.agentId}: Strike open orders`, () => a.strike.openOrders("BTC-USD")); if (open.count > 0) { await patient(`${a.agentId}: Strike cancel`, () => a.strike.cancelAll("BTC-USD")); log(`${a.agentId}: pulled ${open.count} order(s) left on Strike by an earlier run`); } }
await g.rehedge();
await anchorMandates();

// the agents' MCP tools over HTTP: POST /mcp/<agentId>, one stateless transport per request
if (toolsPort) {
  // stateless: a fresh server and transport per request, both gone when the response closes
  const ports = new Map(agents.map((a) => [a.agentId, g.portFor(a.agentId)]));
  // x402: the tools that act on a venue cost one payment each, the reads are free
  const x402 = process.env.X402_FACILITATOR_URL ? { facilitatorUrl: process.env.X402_FACILITATOR_URL, facilitatorKey: process.env.X402_FACILITATOR_KEY || "", payTo: process.env.X402_PAY_TO || "", network: process.env.X402_NETWORK || "cardano:preprod", asset: "lovelace" } : null;
  const PAID = { post_quote: "1000000", take_quote: "1000000", place_order: "1000000", hedge: "2000000" };
  const prices = Object.fromEntries(Object.entries(PAID).map(([k, v]) => [k, process.env[`X402_PRICE_${k.toUpperCase()}`] || v]));
  const revenue = { calls: 0, lovelace: 0n };
  if (x402) log(`x402 on: ${Object.entries(prices).map(([k, v]) => `${k} ${Number(v) / 1e6} ADA`).join(", ")} to ${x402.payTo}`);
  const tools = http.createServer(async (req, res) => {
    const m = req.url.match(/^\/mcp\/([a-z0-9-]+)$/);
    const port = m && ports.get(m[1]);
    if (!port) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no such agent" })); return; }
    let parsedBody;
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try { parsedBody = raw ? JSON.parse(raw) : undefined; } catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "body is not JSON" })); return; }
      const tool = parsedBody?.method === "tools/call" ? parsedBody.params?.name : null;
      if (x402 && tool && prices[tool]) {
        const paid = await charge(req, res, { url: `${process.env.PUBLIC_TOOLS_URL || `http://localhost:${toolsPort}`}/mcp/${m[1]}`, description: `one ${tool} for ${m[1]}`, amount: prices[tool], x: x402, extra: { tool, agent: m[1] } });
        if (!paid.paid) return;
        revenue.calls += 1;
        revenue.lovelace += BigInt(paid.payment.amountUnits ?? prices[tool]);
        entries.append({ kind: "paid", agent: m[1], tool, txHash: paid.payment.txHash, lovelace: String(paid.payment.amountUnits ?? prices[tool]), payer: paid.payment.payerAddr ?? null });
        feed.revenue({ calls: revenue.calls, lovelace: String(revenue.lovelace), payTo: x402.payTo, last: { ts: new Date().toISOString(), tool, agent: m[1], txHash: paid.payment.txHash, payer: paid.payment.payerAddr ?? null } });
      }
    }
    const server = toolServer(port, { name: `flint-${m[1]}` });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, parsedBody); } catch (err) { log(`tools: ${err.message}`); if (!res.headersSent) { res.writeHead(500); res.end(); } }
  });
  await new Promise((r) => tools.listen(toolsPort, "0.0.0.0", r));
  log(`agent tools on http://localhost:${toolsPort}/mcp/<agentId> for ${[...ports.keys()].join(", ")}`);
}

if (rounds > 0) {
  for (let i = 1; i <= rounds; i++) {
    log(`round ${i} of ${rounds}`);
    await g.round();
    if (i % 5 === 0) await refreshReconcile().catch((err) => log(`reconcile: ${err.message}`));
    if (i % attestEvery === 0) await attestWindow().catch((err) => log(`attest: ${err.message}`));
    // several sponsored calls in a row: in the background, so the rounds and the quotes go on
    if (badgesEvery && i % badgesEvery === 0 && i < rounds) attestBadges().catch((err) => log(`badges: ${err.message}`));
    if (i < rounds) await new Promise((r) => setTimeout(r, roundMs));
  }
  await attestWindow().catch((err) => log(`attest: ${err.message}`));
  await shutdown();
} else {
  g.start(roundMs);
  setInterval(() => refreshReconcile().catch((err) => log(`reconcile: ${err.message}`)), 5 * roundMs).unref();
  setInterval(() => attestWindow().catch((err) => log(`attest: ${err.message}`)), attestEvery * roundMs).unref();
  if (badgesEvery) setInterval(() => attestBadges().catch((err) => log(`badges: ${err.message}`)), badgesEvery * roundMs).unref();
}
