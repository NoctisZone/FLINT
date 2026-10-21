#!/usr/bin/env node
/**
 * The token factory and shielded swaps on Midnight preprod, by hand. A trader
 * acts through its own MCP server with the market's key; its wallet state is
 * the one the gateway uses (data/wallets/), so run these while no gateway
 * holds that trader.
 *
 *   npm run live -- types [<issuer>:<name> ...]   # raw token types, computed off-chain
 *   npm run live -- status                        # the factory's tokens, read from the chain
 *   npm run live -- mint <issuer>:<name> <amount> <trader index>
 *   npm run live -- wallet <trader index>         # sync (or resume) its shielded wallet, show what it holds
 *   npm run live -- swap [maker give:amount want:amount taker]   # both halves proven, then sponsorSwap
 *   npm run live -- consolidate <trader index>    # merge its small coins: a swap with itself
 *   npm run live -- board                         # the server's open offers
 *   npm run live -- post <maker> give:amount want:amount [tag ...]       # a maker half on the server's board
 *   npm run live -- take <taker> <offerId>        # take a board offer: mirror half, sponsorSwap by offer id
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { midnightSeedOf } from "../lib/identity.mjs";
import { openMcpTrader } from "../market/mcp-trader.mjs";
import { DEMO_TOKENS, board, factoryState, journal, journalSwap, loadFactory, mintTo, settings, tokenTypes } from "../market/chain.mjs";

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const said = (label, e) => log(`${label}: ${e.status}${e.txHash ? ` tx ${e.txHash}` : ""}${e.error ? ` — ${e.error}` : ""}`);
const seconds = (t0) => Math.round((Date.now() - t0) / 1000);

/** Trader `i`'s server, its wallet synced. */
async function open(cfg, i) {
  const name = `trader-${i}`;
  const t0 = Date.now();
  let shown = 0;
  const w = await openMcpTrader({
    name, seedHex: midnightSeedOf(cfg.master, Number(i)), key: cfg.nightgateKey, cfg, index: Number(i),
    onProgress: (p) => { if (p.seconds - shown >= 15) { shown = p.seconds; log(`${name}: syncing, ${p.seconds}s`); } },
  });
  log(`${name}: wallet synced in ${seconds(t0)}s`);
  return w;
}

async function typeOf(cfg, pure, spec) {
  const [issuer, name, amount] = spec.split(":");
  const [t] = await tokenTypes(cfg, pure, [`${issuer}:${name}`]);
  return { type: t.type, value: BigInt(amount), label: `${amount} ${issuer}:${name}` };
}

async function wallet(cfg, pkg, index) {
  const name = `trader-${index}`;
  const w = await open(cfg, index);
  try {
    const known = Object.fromEntries((await tokenTypes(cfg, pkg.pureCircuits)).map((t) => [t.type, t.token]));
    const short = (type) => known[type] ?? `${type.slice(0, 12)}…`;
    const h = await w.holdings();
    if (!h.tokens.length) log(`${name}: no shielded coins`);
    for (const t of h.tokens) log(`${name}: ${String(t.balance).padStart(8)} ${short(t.tokenType)} in ${t.coins} coin(s); one half gives at most ${t.spendable} (${h.maxInputs} coins)`);
  } finally {
    await w.close();
  }
}

/** Both halves built and proven by the traders' servers, then handed to the sponsor by the taker's. */
async function swap(cfg, pkg, [makerIdx = "0", giveSpec = "market:tBTC:70000", wantSpec = "market:tUSD:4700", takerIdx = "1"] = []) {
  const give = await typeOf(cfg, pkg.pureCircuits, giveSpec);
  const want = await typeOf(cfg, pkg.pureCircuits, wantSpec);
  const [maker, taker] = [await open(cfg, makerIdx), await open(cfg, takerIdx)];
  try {
    log(`trader-${makerIdx} offers ${give.label} for ${want.label}`);
    const offer = await maker.makeOffer({ give, want });
    log(`offer proven in ${Math.round(offer.provingMs / 1000)}s: ${offer.text.slice(0, 24)}…`);
    log(`trader-${takerIdx} checks the offer against what was agreed and adds its half`);
    const taken = await taker.takeOffer({ text: offer.text, expect: { gives: { [give.type]: give.value }, wants: { [want.type]: want.value } } });
    log(`counter-half proven in ${Math.round(taken.provingMs / 1000)}s; handing both halves to the sponsor (sponsorSwap)`);
    const e = await taker.submitSwap({ takerHalf: taken.takerHalf });
    journalSwap(e, { jobId: e.jobId, by: `trader-${takerIdx}`, maker: `trader-${makerIdx}`, taker: `trader-${takerIdx}`, gives: give.label, wants: want.label });
    said("swap", e);
    if (e.status !== "succeeded") {
      await maker.revert(offer.half);
      await taker.revert(taken.takerHalf);
      process.exitCode = 1;
    }
  } finally {
    await maker.close();
    await taker.close();
  }
}

/** A maker half on the server's board. */
async function post(cfg, pkg, [makerIdx, giveSpec, wantSpec, ...tags]) {
  if (!makerIdx || !giveSpec || !wantSpec) throw new Error("usage: post <maker> give:amount want:amount [tag ...]");
  const give = await typeOf(cfg, pkg.pureCircuits, giveSpec);
  const want = await typeOf(cfg, pkg.pureCircuits, wantSpec);
  const maker = await open(cfg, makerIdx);
  try {
    const offer = await maker.makeOffer({ give, want });
    log(`offer proven in ${Math.round(offer.provingMs / 1000)}s; posting it on ${cfg.nightgateUrl}`);
    const posted = await maker.post({ offer: offer.text, tags });
    journal({ circuit: "post", maker: `trader-${makerIdx}`, gives: give.label, wants: want.label, offerId: posted.offerId, status: posted.status });
    log(`posted ${posted.offerId}: ${posted.status}, gives ${posted.givesAmount} wants ${posted.wantsAmount}`);
    log("the coins stay reserved in the maker's wallet until the swap lands; retire + revert frees them");
  } finally {
    await maker.close();
  }
}

/** Take a board offer: the mirror half, then sponsorSwap by offer id. */
async function take(cfg, [takerIdx, offerId]) {
  if (!takerIdx || !offerId) throw new Error("usage: take <taker> <offerId>");
  const row = await board.get(cfg, offerId);
  if (row.status !== "open") throw new Error(`offer ${offerId} is ${row.status}, not open`);
  const taker = await open(cfg, takerIdx);
  try {
    log(`trader-${takerIdx} takes ${offerId}: gives ${row.wantsAmount} of ${row.wantsType.slice(0, 12)}… for ${row.givesAmount} of ${row.givesType.slice(0, 12)}…`);
    const taken = await taker.takeOffer({ text: row.offer, offerId, expect: { gives: { [row.givesType]: BigInt(row.givesAmount) }, wants: { [row.wantsType]: BigInt(row.wantsAmount) } } });
    const e = await taker.submitSwap({ offerId, takerHalf: taken.takerHalf });
    journalSwap(e, { jobId: e.jobId, by: `trader-${takerIdx}`, offerId, taker: `trader-${takerIdx}` });
    said("swap", e);
    if (e.status !== "succeeded") { await taker.revert(taken.takerHalf); process.exitCode = 1; }
  } finally {
    await taker.close();
  }
}

async function merge(cfg, pkg, index) {
  const name = `trader-${index}`;
  const types = await tokenTypes(cfg, pkg.pureCircuits);
  const w = await open(cfg, index);
  try {
    const done = await w.consolidate(types.map((t) => t.type));
    if (!done) return log(`${name}: nothing to merge (one coin per token, or only one of the tokens)`);
    log(`${name}: both halves proven in ${Math.round(done.provingMs / 1000)}s; handing them to the sponsor`);
    const e = await w.submitSwap({ takerHalf: done.takerHalf });
    journalSwap(e, { jobId: e.jobId, by: name, consolidate: name });
    said("consolidate", e);
    if (e.status !== "succeeded") { await done.revert(); process.exitCode = 1; }
  } finally {
    await w.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    const cfg = settings();
    const pkg = await loadFactory({ log });
    if (cmd === "types") {
      console.log(JSON.stringify(await tokenTypes(cfg, pkg.pureCircuits, rest.length ? rest : DEMO_TOKENS), null, 2));
    } else if (cmd === "status") {
      const s = await factoryState(cfg, pkg);
      log(`factory ${s.address}${s.missing ? " (not on the chain)" : ""}: ${s.tokens.length} token(s), ${s.mints ?? 0} mint(s)`);
      for (const t of s.tokens) log(`  ${t.name.padEnd(12)} supply ${t.supply}  issuer ${t.issuer.slice(0, 12)}…  domain ${t.domain.slice(0, 12)}…`);
    } else if (cmd === "mint" && rest.length === 3) {
      const e = await mintTo(cfg, pkg, ...rest);
      said(`mint ${rest[1]} ${rest[0]} to trader ${rest[2]}`, e);
      if (e.status !== "succeeded") process.exitCode = 1;
    } else if (cmd === "wallet" && rest.length === 1) {
      await wallet(cfg, pkg, rest[0]);
    } else if (cmd === "swap") {
      await swap(cfg, pkg, rest);
    } else if (cmd === "consolidate" && rest.length === 1) {
      await merge(cfg, pkg, rest[0]);
    } else if (cmd === "board") {
      const offers = await board.list(cfg, { limit: 50 });
      if (!offers.length) log("the board is empty");
      for (const o of offers) log(`${o.offerId}  gives ${o.givesAmount} ${o.givesType.slice(0, 10)}…  wants ${o.wantsAmount} ${o.wantsType.slice(0, 10)}…  tags ${o.tags}  ${o.expiresAt ?? "no expiry"}`);
    } else if (cmd === "post") {
      await post(cfg, pkg, rest);
    } else if (cmd === "take") {
      await take(cfg, rest);
    } else {
      throw new Error("usage: live.mjs types | status | mint <issuer>:<name> <amount> <trader> | wallet <trader> | swap | consolidate <trader> | board | post <maker> give want [tags] | take <taker> <offerId>");
    }
  } catch (err) {
    log(`failed: ${err.message}`);
    process.exitCode = 1;
  }
  process.exit();
}
