#!/usr/bin/env node
/**
 * Run the gateway on preprod and Strike testnet: the agents' NIGHTGATE
 * servers, their Strike keys, the feed, the decision log.
 *
 *   npm run gateway -- [--rounds N] (0 = until stopped) [--round-ms 20000] [--agents mm-rule,citizen-a] [--port 4481]
 *
 * An agent's Midnight wallet is trader index i in the order of agents/profiles.mjs,
 * or the index given as `name:i`; its Strike key is STRIKE_KEY_<AGENT>
 * (mm-rule → STRIKE_KEY_MM_RULE), or STRIKE_KEY. The rogue (`rogue:4`) needs
 * a wallet but no coins: every attempt is refused before anything is built.
 * Agents made from the page (data/agents.json) join every run with their
 * own wallet index and their owner-signed mandate.
 */
import fs from "node:fs";
import path from "node:path";
import { midnightSeedOf } from "../lib/identity.mjs";
import { loadFactory, mintTo, settings, tokenTypes } from "../market/chain.mjs";
import { openMcpTrader } from "../market/mcp-trader.mjs";
import { strikeClient, TESTNET } from "../gateway/strike.mjs";
const strikePositions = {};
import { userStream } from "../gateway/strike-stream.mjs";
import { midnightVenue } from "../gateway/midnight.mjs";
import { gatewayBoard } from "../gateway/desk.mjs";
import { ownerApi } from "../gateway/owner.mjs";
import { koios } from "../gateway/cardano.mjs";
import { odatano } from "../gateway/odatano.mjs";
import { fileURLToPath } from "node:url";
import { feedServer, feedState } from "../gateway/feed.mjs";
import { decisionLog } from "../gateway/log.mjs";
import { gateway, mandateCard } from "../gateway/gateway.mjs";
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
import { registry, loadSignedMandate, mandateFileOf, saveSignedMandate, orderIndexes, ONBOARD_DIR } from "../gateway/registry.mjs";
import { MARKETS, QUOTE_TOKEN, SYMBOLS, assertMarkets, marketOf, marketOfPair } from "../gateway/markets.mjs";
import { accountsFile, agentWallet, connectStrike, onboardSteps, orderPayments, ORDER_STEPS, topUpSteps, TOPUP_STEPS, treasuryWallet } from "../gateway/onboard.mjs";
import { onboardJob } from "../gateway/onboard-job.mjs";
import { withdrawRoom, withdrawSteps, WITHDRAW_STEPS } from "../gateway/withdraw.mjs";
import { agentKeys } from "../gateway/agent-keys.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i < 0 ? dflt : args[i + 1]; };
const rounds = Number(opt("rounds", 0));
const roundMs = Number(opt("round-ms", 20_000));
const port = Number(opt("port", 4481));
const toolsPort = Number(opt("tools-port", 0));
const names = opt("agents", "mm-rule,citizen-a,citizen-b").split(",");
// where a maker's half waits for its taker: the server's offer board, or a board inside this process (a network without the offer board)
const boardKind = opt("board", process.env.MIDNIGHT_BOARD || "server");
for (const a of args.filter((x) => x.startsWith("--"))) if (!["--rounds", "--round-ms", "--agents", "--port", "--tools-port", "--board"].includes(a)) { console.error(`unknown option ${a}`); process.exit(2); }
if (!["server", "gateway"].includes(boardKind)) { console.error(`--board is server or gateway, not ${boardKind}`); process.exit(2); }

const log = (...x) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...x);
const accounts = accountsFile();
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
// every market's base token and tUSD on the factory, so a venue can serve any pair
const tokens = await tokenTypes(cfg, pkg.pureCircuits, [QUOTE_TOKEN, ...SYMBOLS.map((s) => MARKETS[s].token)]);
const typeOf = (spec) => tokens.find((t) => t.token === spec).type;
const types = { quote: typeOf(QUOTE_TOKEN), bases: Object.fromEntries(SYMBOLS.map((s) => [MARKETS[s].pair, { type: typeOf(MARKETS[s].token), decimals: MARKETS[s].decimals }])) };
const symbolOfMandate = (mandate) => mandate.strike.markets[0] ?? marketOfPair(mandate.midnight.pairs[0])?.symbol ?? "BTC-USD";
const all = profiles({ owner: process.env.OWNER_ADDRESS || "addr_test1…owner", expiry: new Date(Date.now() + 3 * 86_400_000).toISOString() });
// test settings: a wider hedge deadline and position cap than the shipped profiles, for an empty testnet book
for (const m of Object.values(all)) {
  if (process.env.HEDGE_WITHIN_SEC) m.risk.hedgeWithinSec = Number(process.env.HEDGE_WITHIN_SEC);
  if (process.env.MAX_POSITION_USD && m.strike.maxPositionUsd > 0) m.strike.maxPositionUsd = Number(process.env.MAX_POSITION_USD);
}
for (const agentId of Object.keys(all)) {
  const s = loadSignedMandate(agentId, { owner: all[agentId].owner });
  if (!s) continue;
  if (s.ok) { all[agentId] = s.mandate; log(`${agentId}: owner-signed mandate ${mandateHash(s.mandate).slice(0, 12)}… from ${s.file}`); }
  else log(`${agentId}: ignoring ${s.file}: ${s.why}`);
}
const order = Object.keys(all);
// the built-ins' minds; "claude" is a maker with the Claude brain
const minds = { "mm-rule": "maker", "mm-claude": "claude", "citizen-a": "citizen", "citizen-b": "citizen", rogue: "rogue" };
const sides = { "citizen-a": "auto", "citizen-b": "auto" };
// the agent's Cardano wallet, as cli/onboard.mjs derives it; its Midnight address stays hidden
const walletsOf = (agentId) => ({ cardano: agentWallet(cfg.master, agentId).address, midnight: "hidden" });
const reg = registry();

const sharedBoard = boardKind === "gateway" ? gatewayBoard() : null;
const entries = decisionLog(path.join("data", "decisions.jsonl"));
const strikeBase = process.env.STRIKE_API_URL || TESTNET;
const pub = strikeClient({ baseUrl: strikeBase });
// each market's live rules from Strike, read once: the smallest order, the size step, the price tick
const rules = {};
async function rulesOf(symbol) {
  if (!rules[symbol]) {
    const r = await patient(`Strike market rules ${symbol}`, () => pub.market(symbol));
    const m = marketOf(symbol);
    rules[symbol] = { minNotionalUsd: Number(r.order_min_notional ?? m.minNotionalUsd), step: Number(r.order_limit_step_size ?? m.step), tick: Number(r.order_tick_price ?? m.tick) };
    log(`${symbol}: smallest order ${rules[symbol].minNotionalUsd} USD, step ${rules[symbol].step}, tick ${rules[symbol].tick}`);
  }
  return rules[symbol];
}

/**
 * One agent for the loop: its MCP server (opened here unless `trader` is
 * handed in), its Midnight venue, its Strike client from its own account
 * or the shared key, its stream, and the Claude brain for `mind: "claude"`.
 * Used for every agent at start and for one made from the page.
 */
async function buildAgent({ agentId, index, mind, side, mandate, name = agentId, trader = null, signatureOk = true, stopped = false }) {
  const kind = mind === "claude" ? "maker" : mind;
  let stoppedReason = null;
  if (!trader) {
    const t0 = Date.now();
    trader = await openMcpTrader({ name: `trader-${index}`, seedHex: midnightSeedOf(cfg.master, index), key: cfg.nightgateKey, cfg, index, onProgress: (p) => { if (p.seconds % 30 === 0) log(`${agentId}: wallet syncing, ${p.seconds}s`); } });
    log(`${agentId}: wallet ready in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  // a maker quotes on every market of its mandate; a citizen's venue serves every pair its mandate names
  const symbol = symbolOfMandate(mandate);
  const symbols = kind === "citizen" ? [] : mandate.strike.markets.length ? assertMarkets(mandate).map((m) => m.symbol) : [symbol];
  const pairs = mandate.midnight.pairs.length ? mandate.midnight.pairs : [marketOf(symbol).pair];
  const venue = midnightVenue({ trader, agentId, types: { quote: types.quote, bases: Object.fromEntries(pairs.map((p) => [p, types.bases[p]])) }, pair: kind === "maker" || kind === "rogue" ? marketOf(symbol).pair : pairs[0], ...(sharedBoard ? { board: sharedBoard } : {}), log: (e) => entries.append({ agent: agentId, ...e }) });
  const rules = {};
  for (const sym of symbols) rules[sym] = await rulesOf(sym);
  const market = rules[symbol] ?? null;
  // an agent that onboarded itself trades on its own Strike account with its builder fee; else the shared key
  const own = accounts.read()[agentId];
  const keyName = `STRIKE_KEY_${agentId.toUpperCase().replace(/-/g, "_")}`;
  const privateKeyHex = kind === "maker" || kind === "rogue" ? (own?.apiWalletPrivateKeyHex || process.env[keyName] || process.env.STRIKE_KEY) : null;
  let strike = null, stream = null, keyUsed = privateKeyHex;
  if (privateKeyHex) {
    const builderFeeBps = own ? Math.min(own.feeShareBps ?? 0, Number(process.env.STRIKE_BUILDER_FEE_BPS || own.feeShareBps || 0)) : (process.env.STRIKE_BUILDER_FEE_BPS ? Number(process.env.STRIKE_BUILDER_FEE_BPS) : undefined);
    strike = strikeClient({ baseUrl: strikeBase, privateKeyHex, builderFeeBps });
    if (own) {
      // an own account without balance cannot hedge yet: fall back to the shared key for this run
      await patient(`${agentId}: Strike clock`, () => strike.syncClock());
      const bal = Number((await patient(`${agentId}: Strike balance`, () => strike.balances()))[0]?.walletBalance ?? 0);
      if (bal > 0) log(`${agentId}: own Strike account ${own.accountId} with ${bal} USD, builder ${own.builderCode} at ${builderFeeBps} bps`);
      // the shared key stands in for a built-in only: an owner's agent trades its owner's money or waits for it
      else if (process.env.STRIKE_KEY && agentId in all) { log(`${agentId}: own Strike account ${own.accountId} holds 0 USD; using the shared key this run`); keyUsed = process.env.STRIKE_KEY; strike = strikeClient({ baseUrl: strikeBase, privateKeyHex: keyUsed }); }
      else { stopped = true; stoppedReason = "deposit needed"; log(`${agentId}: own Strike account ${own.accountId} holds 0 USD; it waits, stopped, for a deposit`); }
    }
    await patient(`${agentId}: Strike clock`, () => strike.syncClock());
    const settings = await patient(`${agentId}: Strike symbols`, () => strike.symbols());
    for (const sym of symbols) {
      const lev = settings.symbol_settings?.[sym]?.leverage ?? settings.default_leverage;
      if (lev > mandate.strike.maxLeverage) { await patient(`${agentId}: Strike leverage`, () => strike.setLeverage(sym, mandate.strike.maxLeverage)); log(`${agentId}: Strike leverage on ${sym} set to ${mandate.strike.maxLeverage}`); }
    }
    stream = (onEvent, onStatus) => userStream({ baseUrl: strike.baseUrl, privateKeyHex: keyUsed, onEvent, onStatus: (x) => { log(`${agentId}: strike stream ${x.state}${x.message ? ` ${x.message}` : ""}`); onStatus?.(x); } });
    // the books' Strike position is what Strike says it is, not what an earlier run on another account recorded
    const positions = (await patient(`${agentId}: Strike positions`, () => strike.positions())).positions ?? [];
    strikePositions[agentId] = Object.fromEntries(symbols.map((sym) => [sym, Number(positions.find((p) => p.symbol === sym)?.size ?? 0)]));
  } else if (kind === "maker") {
    log(`${agentId}: no Strike key (${keyName} or STRIKE_KEY); it will quote without a hedge and freeze on the first fill`);
  }
  let brain = null;
  if (mind === "claude") {
    if (!process.env.ANTHROPIC_API_KEY) log(`${agentId}: no ANTHROPIC_API_KEY; the rules run it`);
    else {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      brain = claudeMaker({ client: new Anthropic(), model: process.env.CLAUDE_MODEL || "claude-haiku-5-5", budget: fileBudget({ limit: Number(process.env.CLAUDE_BUDGET || 300) }), journal: fileJournal() });
    }
  }
  // a citizen looks every round and acts on about half of them; a maker quotes 120 USD a side, above Strike's minimum and inside what a citizen's coins pay
  // the shared key serves every maker without an account of its own: its fills and position are not one agent's
  return { agentId, name, mandate, mind: kind, side, venue, strike, stream, sharedStrike: Boolean(keyUsed) && keyUsed === process.env.STRIKE_KEY, wallets: walletsOf(agentId), trader, brain, leverage: mandate.strike.maxLeverage, signatureOk, stopped, stoppedReason, market: symbol, markets: symbols, rules, step: market?.step, tick: market?.tick, minQuoteUsd: market?.minNotionalUsd, options: kind === "citizen" ? { rate: Number(process.env.CITIZEN_RATE || 0.5) } : { sizeUsd: Number(process.env.MAKER_SIZE_USD || 120) } };
}

const agents = [];
const usedIndexes = order.map((_, i) => i);
for (const spec of names) {
  const [agentId, given] = spec.split(":");
  const index = given !== undefined ? Number(given) : order.indexOf(agentId);
  if (!(agentId in all) || !Number.isInteger(index) || index < 0) { console.error(`unknown agent ${spec}`); process.exit(2); }
  usedIndexes.push(index);
  agents.push(await buildAgent({ agentId, index, mind: minds[agentId], side: sides[agentId], mandate: all[agentId] }));
}
// the agents made from the page: always, with their own index; one whose mandate no longer holds waits, stopped, for a new signature
for (const e of reg.list()) {
  const s = loadSignedMandate(e.agentId, { owner: e.owner });
  if (!s?.mandate) { log(`${e.agentId}: registered but no mandate file; skipped`); continue; }
  if (!s.ok) log(`${e.agentId}: ${s.why}; it waits for its owner to sign again`);
  else log(`${e.agentId}: owner-signed mandate ${mandateHash(s.mandate).slice(0, 12)}… from ${s.file}, wallet ${e.index}`);
  try { agents.push(await buildAgent({ agentId: e.agentId, index: e.index, mind: e.mind === "claude" ? "claude" : "maker", side: e.side ?? undefined, mandate: s.mandate, signatureOk: s.ok, stopped: !s.ok })); }
  catch (err) { log(`${e.agentId}: not started: ${err.message.slice(0, 160)}`); }
}
const ids = () => agents.map((a) => a.agentId);

const runStart = entries.append({ kind: "run.start", agents: ids(), books: {} });
// the hedgers' books outlive a run: unhedged inventory and a freeze are not forgotten on restart
const BOOKS = path.join("data", "books.json");
const books = fs.existsSync(BOOKS) ? JSON.parse(fs.readFileSync(BOOKS, "utf8")) : {};
const saveBooks = (agentId, snap) => { books[agentId] = snap; fs.writeFileSync(BOOKS, JSON.stringify(books, null, 1)); };
// Strike's position wins over the books; what inventory and position then leave open is unhedged again (another account's hedge no longer counts)
for (const [id, sizes] of Object.entries(strikePositions)) {
  const all = books[id];
  if (!all) continue;
  // the shared account's position is nobody's own: an agent on the shared key keeps its books
  if (agents.find((a) => a.agentId === id)?.sharedStrike) continue;
  // the first market's books are the flat ones; every further market's sit under `legs`
  for (const [i, [sym, size]] of Object.entries(sizes).entries()) {
    const b = i === 0 ? all : (all.legs ??= {})[sym] ??= { midnightInventoryBtc: 0, strikePositionBtc: 0, unhedgedBtc: 0 };
    if (b.strikePositionBtc === size) continue;
    const open = Math.round(((b.midnightInventoryBtc ?? 0) + size) * 1e8) / 1e8;
    log(`${id}: Strike position on ${sym} is ${size}, the books said ${b.strikePositionBtc}: taking Strike's number, ${open} unhedged`);
    b.strikePositionBtc = size;
    b.unhedgedBtc = Math.abs(open) >= 0.00001 ? open : 0;
    if (i === 0) (all.legs ??= {})[sym] = { midnightInventoryBtc: b.midnightInventoryBtc ?? 0, strikePositionBtc: size, unhedgedBtc: b.unhedgedBtc };
  }
}
runStart.books = structuredClone(books);
for (const [id, b] of Object.entries(books)) if (ids().includes(id)) log(`${id}: books from the last run: inventory ${b.midnightInventoryBtc} BTC, Strike ${b.strikePositionBtc} BTC, unhedged ${b.unhedgedBtc} BTC${b.frozen ? `, frozen (${b.frozenReason})` : ""}`);
// the marks of every market outlive a run: read at start, written after every round
const MARKS_FILE = path.join("data", "marks.json");
let savedMarks = null;
try { savedMarks = JSON.parse(fs.readFileSync(MARKS_FILE, "utf8")); } catch {}
const feed = feedState({ marks: savedMarks, onMarks: (m) => { try { fs.writeFileSync(MARKS_FILE, JSON.stringify(m)); } catch (err) { log(`marks: ${err.message}`); } } });
const jobs = new Map(); // agentId → onboarding job, for the owner API below and the loop that fills it in
const keys = agentKeys();
const SESSIONS = path.join("data", "owner-sessions.json");
// x402: the tools that act on a venue cost one payment each, the reads are free; a new agent's deposit and a tools key are priced too (0 = free)
const x402 = process.env.X402_FACILITATOR_URL ? { facilitatorUrl: process.env.X402_FACILITATOR_URL, facilitatorKey: process.env.X402_FACILITATOR_KEY || "", payTo: process.env.X402_PAY_TO || "", network: process.env.X402_NETWORK || "cardano:preprod", asset: "lovelace" } : null;
const PAID = { post_quote: "1000000", take_quote: "1000000", place_order: "1000000", hedge: "2000000" };
const prices = Object.fromEntries(Object.entries(PAID).map(([k, v]) => [k, process.env[`X402_PRICE_${k.toUpperCase()}`] || v]));
const ownerPrices = { key: process.env.X402_PRICE_KEY || "0" };
const revenue = { calls: 0, lovelace: 0n };
/** One x402 payment landed: counted, logged, on the feed. */
function paidCall(payment, what, agent, extra = {}) {
  revenue.calls += 1;
  revenue.lovelace += BigInt(payment.amountUnits ?? 0);
  entries.append({ kind: "paid", agent, tool: what, txHash: payment.txHash, lovelace: String(payment.amountUnits ?? 0), payer: payment.payerAddr ?? null, ...extra });
  feed.revenue({ calls: revenue.calls, lovelace: String(revenue.lovelace), payTo: x402.payTo, last: { ts: new Date().toISOString(), tool: what, agent, txHash: payment.txHash, payer: payment.payerAddr ?? null } });
}
const ownerUrl = (process.env.PUBLIC_OWNER_URL || `http://localhost:${port}/owner/`).replace(/\/?$/, "/");
const treasury = treasuryWallet(cfg.master); // the project wallet: where fees go unless X402_PAY_TO says otherwise
/** What a new agent costs its owner; the fee goes where x402 payments go. */
const pricing = { feeAda: Number(process.env.SETUP_FEE_ADA ?? 20), feeClaudeAda: Number(process.env.SETUP_FEE_CLAUDE_ADA ?? 40), keyAda: Number(ownerPrices.key) / 1e6, minDepositAda: Number(process.env.MIN_DEPOSIT_ADA ?? 500), minTopUpAda: Number(process.env.MIN_TOPUP_ADA ?? 50), payTo: process.env.X402_PAY_TO || treasury.address,
  // markets no new agent may be ordered on for now (a Strike testnet book that cannot be hedged); running agents keep theirs
  marketsOff: (process.env.MARKETS_OFF || "").split(",").map((s) => s.trim()).filter(Boolean) };
feed.setOrders({ ...pricing, x402: Boolean(x402) });
feed.setLiquidity(process.env.STRIKE_LIQUIDITY_NOTE || null);
feed.setBoard(boardKind);
log(`midnight board: ${boardKind}`);
const owner = ownerApi({
  agents, log: (e) => entries.append(e),
  // the gateway is built a few lines down; the handler only runs once it exists
  gateway: { freeze: (...x) => g.freeze(...x), resume: (...x) => g.resume(...x), stop: (...x) => g.stop(...x), unwind: (...x) => g.unwind(...x), close: (...x) => g.close(...x), setMandate: (...x) => g.setMandate(...x), stateOf: (...x) => g.stateOf(...x) },
  // the signed mandate outlives the run, and the vault gets its new hash
  onMandate: async (a, sig) => {
    const file = saveSignedMandate(a.agentId, { mandate: a.mandate, signature: sig, hash: sig.hash });
    log(`${a.agentId}: mandate signed by its owner, hash ${sig.hash.slice(0, 12)}…, saved to ${file}`);
    anchorMandate(a).catch((err) => log(`${a.agentId}: anchor after signing failed: ${err.message.slice(0, 120)}`));
  },
  onboarding: { create: (spec) => createAgent(spec), get: (id) => jobs.get(id)?.view() ?? null, retry: async (id) => { const j = jobs.get(id); j.retry().catch(() => {}); await new Promise((r) => setImmediate(r)); return j.view(); }, cancel: (id) => cancelOrder(id) },
  // a name is taken by a built-in, a registered agent or a Strike account made for it, not only by one in the loop
  nameTaken: (name) => name in all || Boolean(reg.get(name)) || Boolean(accounts.read()[name]),
  // the pricing, the payments, the payouts and the deposits are built a few lines down; the handlers only run once they exist
  pricing, payments: { build: (...x) => payments.build(...x), submit: (...x) => payments.submit(...x) },
  withdrawals: { start: (...x) => withdrawals.start(...x), list: (...x) => withdrawals.list(...x), retry: (...x) => withdrawals.retry(...x), room: (...x) => withdrawals.room(...x) },
  deposits: { start: (...x) => deposits.start(...x), build: (...x) => deposits.build(...x), submit: (...x) => deposits.submit(...x), list: (...x) => deposits.list(...x), retry: (...x) => deposits.retry(...x) },
  strikeKeys: { info: (id) => { const o = accounts.read()[id]; return o ? { accountId: o.accountId, publicKey: o.apiWalletPublicKeyHex, connectedAt: o.connectedAt ?? null } : null; }, rotate: (id) => rotateStrikeKey(id) },
  keys,
  // wallet sessions outlive a restart, so the page's owner keeps following its agents (tokens, mode 600)
  sessionStore: { load: () => (fs.existsSync(SESSIONS) ? JSON.parse(fs.readFileSync(SESSIONS, "utf8")) : []), save: (entries) => { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync(SESSIONS, JSON.stringify(entries), { mode: 0o600 }); } },
  x402: x402 ? { prices: ownerPrices, charge: (req, res, o) => charge(req, res, { url: `${ownerUrl}agents${o.extra?.what === "key" ? `/${o.extra.agent}/key` : ""}`, ...o, x: x402, onPaid: (p) => paidCall(p, o.extra?.what ?? "owner", o.extra?.agent ?? null) }) } : null,
});
if (x402) log(`x402 on: ${Object.entries(prices).map(([k, v]) => `${k} ${Number(v) / 1e6} ADA`).join(", ")}, tools key ${Number(ownerPrices.key) / 1e6} ADA, to ${x402.payTo}`);
const server = await feedServer(feed, { port, host: "0.0.0.0", staticDir: fileURLToPath(new URL("../arena/", import.meta.url)), handlers: [owner.handle] });
feed.setOwner(true);
log(`feed on http://localhost:${server.address().port}/feed/meta`);
// the mark of every market each round, for the agents and the page's chart; a market Strike does not answer for keeps its last value
const lastMarks = {};
const mark = async () => {
  await Promise.all(SYMBOLS.map(async (s) => { try { const p = await pub.markPrice(s); lastMarks[s] = { mark: Number(p.p), funding: Number(p.r) }; } catch (err) { log(`${s}: mark: ${err.message.slice(0, 80)}`); } }));
  return { markets: { ...lastMarks } };
};
// a quote smaller than Strike's minimum order could never be hedged
for (const s of SYMBOLS) await rulesOf(s);
const minHedgeUsd = rules["BTC-USD"].minNotionalUsd;

const g = gateway({ agents, mark, feed, books, saveBooks, minHedgeUsd, log: (e) => { const full = entries.append(e); log(`${e.agent ?? "gateway"}: ${e.kind}${e.rule ? ` ${e.rule}` : ""}${e.reason ? ` — ${e.reason}` : ""}${e.error ? ` — ${e.error}` : ""}`); return full; } });

// a new agent from the page: its onboarding job runs here, one at a time, and is written to data/onboard/<id>.json
const chain = process.env.ODATANO_ACCESS_KEY ? odatano({ key: process.env.ODATANO_ACCESS_KEY, baseUrl: process.env.ODATANO_ACCESS_URL || undefined }) : koios();
const jobFile = (agentId) => path.join(ONBOARD_DIR, `${agentId}.json`);
// mints are sponsored one after the other: two orders at once take turns
let mintTurn = Promise.resolve();
const mintInTurn = (spec, amount, i) => { const run = mintTurn.then(() => mintTo(cfg, pkg, spec, amount, i)); mintTurn = run.catch(() => {}); return run; };
function jobFor({ agentId, index, owner: ownerAddress, mind, spec, payment = null, mandate, saved = null }) {
  const wallet = agentWallet(cfg.master, agentId);
  const steps = onboardSteps({
    agentId, index, mandate, wallet, owner: ownerAddress,
    fee: { lovelace: BigInt(spec.feeLovelace), to: pricing.payTo, paid: payment }, depositLovelace: BigInt(spec.depositLovelace),
    mint: mintInTurn, markets: assertMarkets(mandate).map((m) => ({ ...m, minNotionalUsd: (rules[m.symbol] ?? m).minNotionalUsd })),
    marks: async () => (await mark()).markets,
    strike: { baseUrl: strikeBase, code: process.env.STRIKE_BUILDER_CODE, feeShareBps: mandate.strike.builderFeeBps || Number(process.env.STRIKE_BUILDER_FEE_BPS || 10), accounts, chain, master: cfg.master, clientOf: (privateKeyHex) => strikeClient({ baseUrl: strikeBase, privateKeyHex }) },
    // an agent the loop already holds (after a restart) keeps its open wallet: two servers never open one wallet
    open: async () => agents.find((a) => a.agentId === agentId)?.trader ?? openMcpTrader({ name: `trader-${index}`, seedHex: midnightSeedOf(cfg.master, index), key: cfg.nightgateKey, cfg, index, onProgress: (p) => { if (p.seconds % 30 === 0) log(`${agentId}: wallet syncing, ${p.seconds}s`); } }),
    register: async (trader, ctx) => {
      if (!ids().includes(agentId)) {
        const a = await buildAgent({ agentId, index, mind: mind === "claude" ? "claude" : "maker", mandate, trader });
        g.addAgent(a);
        anchorMandate(a).catch((err) => log(`${agentId}: mandate anchor failed: ${err.message.slice(0, 120)}`));
      }
      if (!reg.get(agentId)) reg.add({ agentId, index, mind, side: null, owner: ownerAddress, pay: spec.pay, feeLovelace: String(spec.feeLovelace), depositLovelace: String(spec.depositLovelace), ...(payment ? { payment: { txHash: payment.txHash, lovelace: String(payment.amountUnits ?? 0), payer: payment.payerAddr ?? null } } : {}), mandateFile: mandateFileOf(agentId), createdAt: new Date().toISOString(), strike: { accountId: accounts.read()[agentId]?.accountId ?? null } });
      // its first tools key when ordered, for the mind that will drive it; the owner reads it once from the job
      if (spec.toolsKey !== false && !keys.has(agentId)) ctx.set("toolsKey", keys.issue(agentId).key);
    },
    quoted: () => feed.get("quotes").quotes.some((q) => q.agentId === agentId),
    log: (e) => entries.append(e),
  });
  const j = onboardJob({
    agentId, index, owner: ownerAddress, mind, order: ORDER_STEPS, spec, steps, saved,
    save: (job) => { fs.mkdirSync(ONBOARD_DIR, { recursive: true }); fs.writeFileSync(jobFile(agentId), JSON.stringify(job, null, 1), { mode: 0o600 }); },
    // the Arena sees the newcomer from the first step on; once the job is through, the card is the loop's
    onChange: (job) => {
      const cur = job.steps.find((s) => s.status !== "done") ?? job.steps.at(-1);
      const onboarding = job.status === "done" ? null : { status: job.status, step: cur.step, stepStatus: cur.status, detail: cur.detail, error: job.error };
      feed.agent(agentId, ids().includes(agentId) ? { onboarding } : { agentId, name: agentId, type: "mm", mind, status: "starting", mandate: mandateCard(mandate), wallets: { cardano: wallet.address, midnight: "hidden" }, onboarding });
      if (job.status !== "running") log(`${agentId}: order ${job.status}${job.error ? `: ${job.error}` : ""}`);
    },
  });
  jobs.set(agentId, j);
  return j;
}
async function createAgent({ agentId, mind, pay, depositLovelace, feeLovelace, toolsKey, payment = null, owner: ownerAddress, mandate, signature, hash }) {
  if (!process.env.STRIKE_BUILDER_CODE) throw Object.assign(new Error("STRIKE_BUILDER_CODE is not set on this gateway"), { status: 503 });
  // a wallet index is never handed out twice: built-ins, registered agents and every saved order, finished or not
  const index = reg.nextIndex([...usedIndexes, ...orderIndexes(ONBOARD_DIR), ...[...jobs.values()].map((j) => j.job.index)]);
  saveSignedMandate(agentId, { mandate, signature, hash });
  const spec = { pay, depositLovelace: String(depositLovelace), feeLovelace: String(feeLovelace), toolsKey };
  const j = jobFor({ agentId, index, owner: ownerAddress, mind, spec, payment, mandate });
  log(`${agentId}: new order from ${ownerAddress.slice(0, 16)}…, wallet ${index}, mind ${mind}, deposit ${Number(depositLovelace) / 1e6} tADA, fee ${Number(feeLovelace) / 1e6} tADA ${pay === "x402" ? `paid by x402 (${payment?.txHash?.slice(0, 16) ?? "?"}…)` : "from the owner's wallet"}`);
  j.run().catch((err) => log(`${agentId}: order: ${err.message}`));
  await new Promise((r) => setImmediate(r));
  return j.view();
}
/** An unpaid order taken back: the job ends cancelled, its card leaves the Arena, the name is free; its wallet index stays used. */
async function cancelOrder(agentId) {
  const j = jobs.get(agentId);
  if (!j) throw Object.assign(new Error("no such order"), { status: 404 });
  const job = await j.cancel();
  jobs.delete(agentId);
  if (!ids().includes(agentId)) feed.agentGone(agentId);
  if (j.ctx.trader && !ids().includes(agentId)) await j.ctx.trader.close().catch(() => {});
  log(`${agentId}: order cancelled by its owner`);
  return j.view();
}
const payments = orderPayments({ jobOf: (id) => jobs.get(id) ?? null, chain, log: (e) => entries.append(e) });

// payouts: one job per request, written to data/withdrawals/<agent>-<time>.json, the ones of this run kept in memory
const WITHDRAW_DIR = path.join("data", "withdrawals");
const withdrawJobs = new Map(); // agentId → jobs, newest last
/** The money a payout takes off Strike, or a deposit puts on it, moves the day's loss-stop baseline with it. */
const withBaseline = (steps, step, agentId, delta, why) => ({ ...steps, [step]: async (ctx, s) => { const r = await steps[step](ctx, s); g.adjustEquityStart(agentId, delta(ctx), why); return r; } });
const withdrawJob = (a, usd, stamp, saved = null) => onboardJob({
  agentId: a.agentId, index: null, owner: a.mandate.owner, mind: null, kind: "withdraw", order: WITHDRAW_STEPS, spec: { usd }, saved,
  steps: withBaseline(withdrawSteps({ agentId: a.agentId, wallet: agentWallet(cfg.master, a.agentId), owner: a.mandate.owner, strike: a.strike, chain, usd, log: (e) => entries.append(e) }), "confirm", a.agentId, (ctx) => -Number(ctx.data.quote?.usd ?? 0), "payout"),
  save: (job) => { fs.mkdirSync(WITHDRAW_DIR, { recursive: true }); fs.writeFileSync(path.join(WITHDRAW_DIR, `${a.agentId}-${stamp}.json`), JSON.stringify(job, null, 1), { mode: 0o600 }); },
  onChange: (job) => { if (job.status !== "running") log(`${a.agentId}: payout ${job.status}${job.error ? `: ${job.error}` : ""}`); },
});
const withdrawals = {
  async start(agentId, usd) {
    const a = agents.find((x) => x.agentId === agentId);
    if (!a?.strike || a.sharedStrike) throw Object.assign(new Error("this agent has no Strike account of its own"), { status: 409 });
    const mine = withdrawJobs.get(agentId) ?? [];
    if (mine.some((j) => j.running)) throw Object.assign(new Error("a payout is on its way already"), { status: 409 });
    const j = withdrawJob(a, usd, new Date().toISOString().replace(/[:.]/g, "-"));
    mine.push(j); withdrawJobs.set(agentId, mine);
    j.run().catch((err) => log(`${agentId}: payout: ${err.message}`));
    await new Promise((r) => setImmediate(r));
    return j.view();
  },
  list: (agentId) => (withdrawJobs.get(agentId) ?? []).map((j) => j.view()).reverse(),
  retry: (agentId) => { const j = (withdrawJobs.get(agentId) ?? []).at(-1); if (!j) throw Object.assign(new Error("no payout to retry"), { status: 404 }); j.retry().catch(() => {}); return j.view(); },
  /** What Strike lets go right now, asked at most every 20 s per agent: the page polls it. */
  async room(agentId) {
    const a = agents.find((x) => x.agentId === agentId);
    if (!a?.strike || a.sharedStrike) return null;
    const c = rooms.get(agentId);
    if (c && Date.now() - c.at < 20_000) return c.room;
    const room = await withdrawRoom({ strike: a.strike });
    rooms.set(agentId, { at: Date.now(), room });
    return room;
  },
};
const rooms = new Map(); // agentId → { at, room }

// a further deposit: one job per request, written to data/deposits/<agent>-<time>.json; the owner pays it as an order
const DEPOSIT_DIR = path.join("data", "deposits");
const depositJobs = new Map(); // agentId → jobs, newest last
const ownStrike = (agentId) => { const o = accounts.read()[agentId]; if (!o) throw Object.assign(new Error("this agent has no Strike account of its own"), { status: 409 }); return strikeClient({ baseUrl: strikeBase, privateKeyHex: o.apiWalletPrivateKeyHex }); };
const depositPayments = orderPayments({ jobOf: (id) => (depositJobs.get(id) ?? []).findLast((j) => j.job.status !== "done") ?? null, chain, log: (e) => entries.append(e) });
const depositJob = (a, lovelace, stamp, saved = null) => onboardJob({
  agentId: a.agentId, index: null, owner: a.mandate.owner, mind: null, kind: "deposit", order: TOPUP_STEPS, spec: { lovelace: String(lovelace) }, saved,
  steps: withBaseline(topUpSteps({ agentId: a.agentId, wallet: agentWallet(cfg.master, a.agentId), owner: a.mandate.owner, lovelace, strike: ownStrike(a.agentId), chain, log: (e) => entries.append(e) }), "credit", a.agentId, (ctx) => { g.funded(a.agentId); return Number(ctx.data.pub?.creditedUsd ?? 0); }, "deposit"),
  save: (job) => { fs.mkdirSync(DEPOSIT_DIR, { recursive: true }); fs.writeFileSync(path.join(DEPOSIT_DIR, `${a.agentId}-${stamp}.json`), JSON.stringify(job, null, 1), { mode: 0o600 }); },
  onChange: (job) => { if (job.status !== "running") log(`${a.agentId}: deposit ${job.status}${job.error ? `: ${job.error}` : ""}`); },
});
/**
 * Payouts and deposits of earlier runs, read back from disk: a finished one is listed, a failed or interrupted
 * one can be retried by its owner. The file name carries the agent and the stamp.
 */
function reloadJobs(dir, jobs, build) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    const a = agents.find((x) => x.agentId === saved.agentId);
    if (!a || !saved.spec) continue;
    const stamp = f.slice(saved.agentId.length + 1, -".json".length);
    try { const list = jobs.get(a.agentId) ?? []; list.push(build(a, saved, stamp)); jobs.set(a.agentId, list); } catch (err) { log(`${a.agentId}: ${f}: ${err.message}`); }
  }
}
const deposits = {
  async start(agentId, lovelace) {
    const a = agents.find((x) => x.agentId === agentId);
    if (!a) throw Object.assign(new Error("no such agent"), { status: 404 });
    ownStrike(agentId);
    const mine = depositJobs.get(agentId) ?? [];
    if (mine.some((j) => j.job.status !== "done")) throw Object.assign(new Error("a deposit is under way already; finish or retry it first"), { status: 409 });
    const j = depositJob(a, lovelace, new Date().toISOString().replace(/[:.]/g, "-"));
    mine.push(j); depositJobs.set(agentId, mine);
    j.run().catch((err) => log(`${agentId}: deposit: ${err.message}`));
    await new Promise((r) => setImmediate(r));
    return j.view();
  },
  build: (agentId, body) => depositPayments.build(agentId, body),
  submit: (agentId, body) => depositPayments.submit(agentId, body),
  list: (agentId) => (depositJobs.get(agentId) ?? []).map((j) => j.view()).reverse(),
  retry: (agentId) => { const j = (depositJobs.get(agentId) ?? []).at(-1); if (!j) throw Object.assign(new Error("no deposit to retry"), { status: 404 }); j.retry().catch(() => {}); return j.view(); },
};
// payouts and deposits of earlier runs, for their owners' lists and retries
reloadJobs(WITHDRAW_DIR, withdrawJobs, (a, saved, stamp) => withdrawJob(a, saved.spec.usd === "all" ? "all" : Number(saved.spec.usd), stamp, saved));
reloadJobs(DEPOSIT_DIR, depositJobs, (a, saved, stamp) => depositJob(a, BigInt(saved.spec.lovelace), stamp, saved));

/** A fresh Strike API wallet for a running agent: builder connect again on its own Cardano wallet, the loop swapped onto the new key. */
async function rotateStrikeKey(agentId) {
  const a = agents.find((x) => x.agentId === agentId);
  if (!a) throw Object.assign(new Error("no such agent"), { status: 404 });
  const before = accounts.read()[agentId];
  if (!before) throw Object.assign(new Error("this agent has no Strike account of its own"), { status: 409 });
  if (!process.env.STRIKE_BUILDER_CODE) throw Object.assign(new Error("STRIKE_BUILDER_CODE is not set on this gateway"), { status: 503 });
  const acc = await connectStrike({ agentId, wallet: agentWallet(cfg.master, agentId), master: cfg.master, accounts, baseUrl: strikeBase, code: process.env.STRIKE_BUILDER_CODE, feeShareBps: before.feeShareBps ?? a.mandate.strike.builderFeeBps ?? Number(process.env.STRIKE_BUILDER_FEE_BPS || 10) });
  if (acc.accountId !== before.accountId) log(`${agentId}: builder connect answered account ${acc.accountId}, the agent had ${before.accountId}`);
  const builderFeeBps = Math.min(acc.feeShareBps ?? 0, Number(process.env.STRIKE_BUILDER_FEE_BPS || acc.feeShareBps || 0));
  const strike = strikeClient({ baseUrl: strikeBase, privateKeyHex: acc.apiWalletPrivateKeyHex, builderFeeBps });
  await patient(`${agentId}: Strike clock`, () => strike.syncClock());
  const stream = (onEvent, onStatus) => userStream({ baseUrl: strike.baseUrl, privateKeyHex: acc.apiWalletPrivateKeyHex, onEvent, onStatus: (x) => { log(`${agentId}: strike stream ${x.state}${x.message ? ` ${x.message}` : ""}`); onStatus?.(x); } });
  await g.setStrike(agentId, { strike, stream });
  a.sharedStrike = false;
  rooms.delete(agentId);
  log(`${agentId}: Strike key rotated, API wallet ${acc.apiWalletPublicKeyHex.slice(0, 12)}… on account ${acc.accountId}`);
  return { accountId: acc.accountId, publicKey: acc.apiWalletPublicKeyHex, connectedAt: acc.connectedAt, sameAccount: acc.accountId === before.accountId };
}
// jobs a restart cut short come back failed, for their owner to retry
if (fs.existsSync(ONBOARD_DIR)) {
  for (const f of fs.readdirSync(ONBOARD_DIR).filter((x) => x.endsWith(".json"))) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(ONBOARD_DIR, f), "utf8"));
      if (saved.status === "done" || saved.status === "cancelled") continue;
      const s = loadSignedMandate(saved.agentId, { owner: saved.owner });
      if (!s?.mandate) continue;
      if (!saved.spec) { log(`${saved.agentId}: an order from before orders had a spec; skipped`); continue; }
      jobFor({ agentId: saved.agentId, index: saved.index, owner: saved.owner, mind: saved.mind, spec: saved.spec, mandate: s.mandate, saved });
      log(`${saved.agentId}: onboarding was cut short at ${saved.steps.find((x) => x.status !== "done")?.step}; its owner can retry`);
    } catch (err) { log(`onboard/${f}: ${err.message.slice(0, 100)}`); }
  }
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("stopping: retiring quotes, closing wallets");
  await g.stop();
  await refreshReconcile().catch((err) => log(`reconcile: ${err.message}`));
  await attestBadges().catch((err) => log(`badges: ${err.message}`));
  for (const a of agents) await a.trader.close().catch(() => {});
  // a wallet an onboarding job opened but never handed to the loop
  for (const j of jobs.values()) if (j.ctx.trader && !ids().includes(j.agentId)) await j.ctx.trader.close().catch(() => {});
  for (const list of withdrawJobs.values()) for (const j of list) if (j.running) log(`${j.agentId}: a payout was under way; its owner can retry`);
  for (const list of depositJobs.values()) for (const j of list) if (j.running) log(`${j.agentId}: a deposit was under way; its owner can retry`);
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
feed.setAttestEvery(attestEvery * roundMs);
const attesters = new Map();
const attestDir = path.join("data", "attestations");
let windowFrom = new Date().toISOString();
async function anchorMandates() {
  if (!VAULT) { log("no ATTESTATION_VAULT: attestations off"); return; }
  fs.mkdirSync(attestDir, { recursive: true });
  for (const a of agents) await anchorMandate(a);
}
/** One maker's mandate hash on the vault, under its own attester id; after a start and after the owner signs anew. */
async function anchorMandate(a) {
  if (!VAULT || !a.strike) return;
  {
    const at = attesters.get(a.agentId) ?? attester({ call: (tool, args) => a.trader.call(tool, args), contractAddress: VAULT, artifact: process.env.ATTESTATION_ARTIFACT || "attestation-vault-32", waitForJob: (jobId, sessionId) => import("../market/chain.mjs").then((m) => m.waitForJob(cfg, jobId, sessionId, { timeoutMs: 300_000 })), log: (e) => entries.append({ agent: a.agentId, ...e }) });
    attesters.set(a.agentId, at);
    try {
      const id = await at.identity();
      const m = mandateEnvelope({ agentId: a.agentId, mandateHash: mandateHash(a.mandate) });
      // the same mandate after a restart is on the vault already: the record is checked, not written again, and its first anchor's hash is kept
      const file = path.join(attestDir, `${a.agentId}-mandate.json`);
      const earlier = () => { try { const p = JSON.parse(fs.readFileSync(file, "utf8")); return p.payloadHash === m.payloadHash ? p : null; } catch { return null; } };
      const r = await at.attest({ ...m, label: "mandate" }).catch((err) => { if (/already attested/.test(err.message)) { const p = earlier(); return { status: "succeeded", txHash: p?.txHash ?? null, at: p?.at ?? new Date().toISOString(), provingMs: 0, already: true }; } throw err; });
      if (!r.already) fs.writeFileSync(file, JSON.stringify({ mandate: a.mandate, ...r }, null, 1));
      const v = r.status === "succeeded" ? await at.verify({ payloadHash: m.payloadHash }).catch((err) => ({ verified: false, error: err.message })) : { verified: false };
      feed.proof(a.agentId, { attesterId: id.attesterId, vault: VAULT, mandate: { payloadHash: m.payloadHash, txHash: r.txHash, status: r.status, verified: v.verified, at: r.at } });
      log(`${a.agentId}: mandate ${r.already ? "already anchored" : "anchored"} on the vault: ${r.status}${r.txHash ? ` tx ${r.txHash.slice(0, 16)}…` : ""}, verified ${v.verified}${r.already ? "" : `, proving ${Math.round(r.provingMs / 1000)}s`}`);
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
      if (!a || !r || a.mind !== "maker" || !(r.counts?.midnightFills > 0)) continue;
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
  // this run's part of the chain: an older break in the file does not make this run's record unverifiable
  const chain = verifyLog(file, { fromSeq: runStart.seq });
  const whole = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  // this run only: from its own run.start entry
  const all = whole.slice(whole.findIndex((e) => e.kind === "run.start" && e.seq === runStart.seq));
  const report = { asOf: new Date().toISOString(), log: chain, agents: {} };
  for (const a of agents) {
    if (!a.strike) continue;
    try {
      // this run's hedges only, on every market the agent trades: Strike keeps every fill ever, the log starts at run.start
      const since = Date.parse(runStart.ts);
      const fills = [];
      for (const symbol of a.mandate.strike.markets.length ? a.mandate.strike.markets : [a.market]) fills.push(...((await a.strike.fills({ symbol, limit: 500 })).fills ?? []).filter((f) => typeof f.client_order_id === "string" && f.client_order_id.startsWith(`${a.agentId}-`) && Number(f.timestamp ?? 0) >= since));
      const entries = all.filter((e) => e.agent === a.agentId);
      const carried = runStart.books[a.agentId] ?? {};
      // what each market carried into this run: the first market's books are the flat ones, every market's sit under legs
      const legs = carried.legs ?? {};
      const startDeltaBtc = Object.fromEntries((a.markets ?? [a.market]).map((sym, i) => { const b = legs[sym] ?? (i === 0 ? carried : {}); return [sym, (b.midnightInventoryBtc ?? 0) + (b.strikePositionBtc ?? 0)]; }));
      const r = reconcile({ entries, strikeFills: fills, mandate: a.mandate, startDeltaBtc });
      report.agents[a.agentId] = { ok: r.ok, counts: r.counts, claims: r.claims, violations: r.violations, maxLatencyMs: r.maxLatencyMs };
      lastReconcile.set(a.agentId, { asOf: report.asOf, claims: r.claims, counts: r.counts });
      feed.proof(a.agentId, { reconciled: report.asOf, claims: r.claims, violations: r.violations, counts: r.counts, logChain: chain.ok ? `${chain.entries} entries this run, chain intact` : `broken at ${chain.brokenAt}` });
      log(`${a.agentId}: reconcile — ${r.ok ? "0 violations" : `${r.violations.length} violation(s): ${[...new Set(r.violations.map((v) => v.rule))].join(", ")}`}; ${r.counts.midnightFills} Midnight fills, ${r.counts.strikeFills} Strike fills, max fill-to-hedge ${Math.round(r.maxLatencyMs / 100) / 10}s; log ${chain.ok ? "intact" : "BROKEN"}`);
    } catch (err) { log(`${a.agentId}: reconcile: ${err.message}`); }
  }
  fs.writeFileSync(path.join("data", "reconcile.json"), JSON.stringify(report, null, 1));
}

// orders a previous run left on Strike are unknown to this one; the books carry their exposure, so pull them
for (const a of agents) if (a.strike) for (const sym of a.markets ?? [a.market ?? "BTC-USD"]) { const open = await patient(`${a.agentId}: Strike open orders`, () => a.strike.openOrders(sym)); if (open.count > 0) { await patient(`${a.agentId}: Strike cancel`, () => a.strike.cancelAll(sym)); log(`${a.agentId}: pulled ${open.count} ${sym} order(s) left on Strike by an earlier run`); } }
await g.rehedge();
await anchorMandates();

// the agents' MCP tools over HTTP: POST /mcp/<agentId>, one stateless transport per request
if (toolsPort) {
  // stateless: a fresh server and transport per request, both gone when the response closes; an agent made meanwhile answers too
  const portOf = (agentId) => (ids().includes(agentId) ? g.portFor(agentId) : null);
  feed.setTools({ url: process.env.PUBLIC_TOOLS_URL ? `${process.env.PUBLIC_TOOLS_URL}/mcp/` : null, prices, paid: Boolean(x402) });
  // a throw here, an aborted body for one, would otherwise end the gateway
  const tools = http.createServer((req, res) => serveTools(req, res).catch((err) => {
    log(`tools: ${err.message}`);
    if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy();
  }));
  async function serveTools(req, res) {
    const m = req.url.match(/^\/mcp\/([a-z0-9-]+)$/);
    const port = m && portOf(m[1]);
    if (!port) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no such agent" })); return; }
    // an agent whose owner issued a tools key answers that key alone
    if (!keys.authorize(m[1], req.headers.authorization)) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "this agent's tools need its key: Authorization: Bearer <key>" })); return; }
    let parsedBody;
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try { parsedBody = raw ? JSON.parse(raw) : undefined; } catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "body is not JSON" })); return; }
      const tool = parsedBody?.method === "tools/call" ? parsedBody.params?.name : null;
      if (x402 && tool && prices[tool]) {
        const paid = await charge(req, res, { url: `${process.env.PUBLIC_TOOLS_URL || `http://localhost:${toolsPort}`}/mcp/${m[1]}`, description: `one ${tool} for ${m[1]}`, amount: prices[tool], x: x402, extra: { tool, agent: m[1] } });
        if (!paid.paid) return;
        paidCall(paid.payment, tool, m[1]);
      }
    }
    const server = toolServer(port, { name: `flint-${m[1]}` });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, parsedBody); } catch (err) { log(`tools: ${err.message}`); if (!res.headersSent) { res.writeHead(500); res.end(); } }
  }
  await new Promise((r) => tools.listen(toolsPort, "0.0.0.0", r));
  log(`agent tools on http://localhost:${toolsPort}/mcp/<agentId> for ${ids().join(", ")}`);
}

// --rounds 0 runs until stopped; reconcile, attestations and badges count rounds either way
const total = rounds > 0 ? rounds : Infinity;
for (let i = 1; i <= total && !stopping; i++) {
  log(rounds > 0 ? `round ${i} of ${rounds}` : `round ${i}`);
  await g.round();
  if (stopping) break;
  if (i % 5 === 0) await refreshReconcile().catch((err) => log(`reconcile: ${err.message}`));
  if (i % attestEvery === 0 && !stopping) await attestWindow().catch((err) => log(`attest: ${err.message}`));
  // several sponsored calls in a row: in the background, so the rounds and the quotes go on
  if (badgesEvery && i % badgesEvery === 0 && i < total && !stopping) attestBadges().catch((err) => log(`badges: ${err.message}`));
  if (i < total && !stopping) await new Promise((r) => setTimeout(r, roundMs));
}
if (!stopping) {
  await attestWindow().catch((err) => log(`attest: ${err.message}`));
  await shutdown();
}
