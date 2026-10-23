/**
 * The Mandate Gateway assembled: every agent is a Midnight venue (its own
 * NIGHTGATE MCP server) and, for a market maker, a Strike account with a
 * hedger. One round every `roundMs`: read the mark, let each mind decide,
 * pass every action through the checks, poll fills, hedge, tick the
 * watchdog, update the feed. Nothing reaches a venue without a check.
 *
 * Chain-free through `deps`: the tests hand in stand-in venues and Strike
 * clients; cli/gateway.mjs opens the real ones.
 */
import { check } from "./checks.mjs";
import { mandateHash } from "./mandate.mjs";
import { hedger } from "./hedge.mjs";
import { citizenDecision, makerDecision } from "../agents/rule-maker.mjs";
import { liveAttempts } from "../agents/rogue.mjs";
import { MARKETS, marketOfPair } from "./markets.mjs";

/**
 * @param {object} o
 * @param {Array<{ agentId, mandate, signatureOk, venue, strike?, stream?, sharedStrike?, wallets?, mind: "maker"|"citizen"|"rogue", side?: "buy"|"sell", stopped?, stoppedReason? }>} o.agents
 *   venue: a midnightVenue; strike: a strikeClient; stream: a userStream factory (onEvent, onStatus) => ({ close });
 *   sharedStrike: the Strike key serves other agents too, so account-wide events are not this agent's;
 *   wallets: { cardano, midnight } for the agent's card; stoppedReason: why it waits ("deposit needed"), for the card
 * @param {() => Promise<number>} o.mark      Strike mark price
 * @param {object} o.feed                     feedState
 * @param {(entry) => object} o.log           decisionLog.append
 * @param {() => number} [o.now]
 * @param {number} [o.pollEveryRounds]        fill poll cadence in rounds (each poll costs a gateway call per open quote)
 */
export function gateway({ agents, mark, feed, log, now = Date.now, rnd = Math.random, books: saved = {}, saveBooks = () => {}, minHedgeUsd = 0 }) {
  const PENDING_LOOKUP_MS = 10_000;
  // agentId → { legs: Map(symbol → leg), h: the first leg's hedger or null, actions: number[] (timestamps), day, equityNow, rogueAt }
  // a leg is one market the agent trades: { symbol, pair, h (hedger|null), rules: { step, tick, minNotionalUsd } }
  const books = new Map();
  // the marks per Strike market, from the last round
  let marks = {}; // symbol → { mark, funding }
  const symbolsOf = (a) => a.mandate.strike.markets.length ? a.mandate.strike.markets : [marketOfPair(a.venue?.pair)?.symbol ?? "BTC-USD"];
  const symbolOf = (a) => symbolsOf(a)[0];
  const markAt = (symbol) => marks[symbol]?.mark ?? null;
  const markOf = (a) => markAt(symbolOf(a));
  const fundingOf = (a) => marks[symbolOf(a)]?.funding ?? null;
  const minAt = (a, symbol) => a.rules?.[symbol]?.minNotionalUsd ?? a.minQuoteUsd ?? minHedgeUsd;
  const minOf = (a) => minAt(a, symbolOf(a));
  const legsOf = (b) => [...(b?.legs?.values() ?? [])];
  const legOfPair = (b, pair) => legsOf(b).find((l) => l.pair === pair) ?? null;
  const legOfSymbol = (b, symbol) => b?.legs?.get(symbol) ?? null;
  const pairOfSymbol = (symbol) => MARKETS[symbol]?.pair ?? "tBTC/tUSD";
  /** What `mark()` answered, as symbol → { mark, funding }: a number or one object is BTC-USD, `markets` is every market at once. */
  const marksOf = (m) => (m && typeof m === "object" && m.markets ? m.markets : typeof m === "object" ? { "BTC-USD": { mark: m.mark, funding: m.funding ?? null } } : { "BTC-USD": { mark: m, funding: null } });
  const today = () => new Date(now()).toISOString().slice(0, 10);
  // the day's figures for the card and the loss stop, kept in the books so a restart does not reset them
  const freshDay = (equityStartUsd = null) => ({ date: today(), equityStartUsd, spreadCapturedUsd: 0, hedgeCostUsd: 0, strikeVolumeUsd: 0, builderFeesUsd: 0, fills: 0, strikeFills: 0 });
  // the first leg's books stay flat for older readers; every leg's are under `legs`
  const persist = (a) => { const b = books.get(a.agentId); if (b) saveBooks(a.agentId, { ...(b.h?.snapshot() ?? {}), legs: Object.fromEntries(legsOf(b).map((l) => [l.symbol, l.h?.snapshot() ?? {}])), day: b.day, stopped: Boolean(a.stopped), unwinding: Boolean(a.unwinding) }); };

  const entry = (a, e) => log({ agent: a.agentId, ...e });

  /** One agent into the loop: its books and hedger, its Strike stream, its card. At start for every agent, later for one made at runtime. */
  function addAgent(a) {
    if (books.has(a.agentId)) throw new Error(`agent ${a.agentId} is already in the loop`);
    if (!agents.includes(a)) agents.push(a);
    const { day: savedDay, legs: savedLegs, stopped: savedStopped = false, unwinding: savedUnwinding = false, ...savedFlat } = saved[a.agentId] ?? {};
    // an owner's stop or unwind outlives a restart
    if (savedStopped) a.stopped = true;
    if (savedUnwinding) { a.stopped = true; a.unwinding = true; }
    // a maker or rogue has one leg per market of its mandate; a citizen has none
    const legs = new Map();
    if (a.mind !== "citizen") for (const [i, symbol] of symbolsOf(a).entries()) {
      const state = savedLegs?.[symbol] ?? (i === 0 ? savedFlat : {});
      // the rogue's Strike client serves its refused attempts only: a hedger would hedge a shared account's position as its own
      const h = a.strike && a.mind !== "rogue" ? hedger({
        mandate: a.mandate, symbol, prefix: i === 0 ? `${a.agentId}-` : `${a.agentId}-${(MARKETS[symbol]?.base ?? symbol).toLowerCase()}-`,
        strike: { mark: () => markAt(symbol) ?? 0, placeOrder: (o) => a.strike.placeOrder(o.type === "limit" ? o : { ...o, type: "market", slippage: a.mandate.strike.priceBandPct / 100 }), cancel: (o) => a.strike.cancel(o) },
        log: (e) => entry(a, e), now,
        state, onChange: () => persist(a), minNotionalUsd: minAt(a, symbol), stepBtc: a.rules?.[symbol]?.step ?? a.step ?? 0.00001, tickSize: a.rules?.[symbol]?.tick ?? a.tick ?? 1,
        onHedged: (x) => feed.fillHedged(x.fill.id, hedgeCard(x)), ownAccount: a.sharedStrike !== true,
      }) : null;
      legs.set(symbol, { symbol, pair: pairOfSymbol(symbol), h, rules: a.rules?.[symbol] ?? { step: a.step, tick: a.tick, minNotionalUsd: a.minQuoteUsd } });
    }
    const h = legsOf({ legs })[0]?.h ?? null;
    books.set(a.agentId, { legs, h, actions: [], day: savedDay?.date === today() ? savedDay : freshDay(), equityNow: null, rogueAt: 0 });
    if (h && a.stream) openStream(a, legsOf({ legs }));
    feed.agent(a.agentId, { agentId: a.agentId, name: a.name ?? a.agentId, type: a.mind === "maker" ? "mm" : a.mind, mind: a.brain ? "claude" : "rules", status: "starting", mandate: mandateCard(a.mandate), wallets: a.wallets ?? null, onboarding: null });
    return a;
  }
  for (const a of [...agents]) addAgent(a);

  /** The agent's Strike user stream: fills and order updates to every leg's hedger (each keeps its market's), its own fills to the feed. */
  function openStream(a, legs) {
    let opens = 0;
    a.streamHandle = a.stream(
      (e) => { for (const l of legs) if (l.h) l.h.onStrikeEvent(e).catch((err) => entry(a, { kind: "stream.error", error: err.message })); if (e.kind === "fill" && ownOrder(a, e.clientOrderId)) { feed.fill(fillCard(a, e)); countStrikeFill(a, e); } },
      // the stream replays nothing: after a reconnect, what the pending orders did meanwhile comes from REST
      (x) => { if (x.state === "open" && opens++ > 0) resync(a, legs).catch((err) => entry(a, { kind: "stream.resync.failed", error: err.message })); },
    );
  }

  const ownOrder = (a, clientOrderId) => typeof clientOrderId === "string" && clientOrderId.startsWith(`${a.agentId}-`);
  /** Orders an outside mind placed through the tools, cancelled one by one; the hedgers' own orders stay. */
  async function cancelToolOrders(a) {
    if (!a.strike?.openOrders) return 0;
    let n = 0;
    for (const symbol of symbolsOf(a)) {
      const open = (await a.strike.openOrders(symbol)).orders ?? [];
      for (const o of open) {
        const id = o.ClientOrderID ?? o.clientOrderId ?? "";
        if (!id.startsWith(`${a.agentId}-tool-`)) continue;
        await a.strike.cancel({ symbol, clientOrderId: id }).catch((err) => entry(a, { kind: "cancel.failed", clientOrderId: id, error: err.message.slice(0, 120) }));
        n++;
      }
    }
    return n;
  }
  const fillCard = (a, e) => ({ ts: new Date(now()).toISOString(), agentId: a.agentId, strikeFill: { symbol: e.symbol ?? symbolOf(a), side: e.side, size: e.size, price: e.price, clientOrderId: e.clientOrderId } });
  const hedgeCard = (x) => ({ how: x.hedge.how, clientOrderIds: x.hedge.clientOrderIds, price: x.hedge.price, latencySec: Math.round(x.latencyMs / 100) / 10, at: new Date(x.hedge.at).toISOString() });

  /** A Strike fill of this agent: volume, fees and slippage against the mark go to the day's figures. */
  function countStrikeFill(a, e) {
    const b = books.get(a.agentId);
    const size = Number(e.size), price = Number(e.price);
    const mk = markAt(e.symbol ?? symbolOf(a)) ?? markOf(a);
    const slippage = mk ? (e.side === "BUY" ? price - mk : mk - price) * size : 0;
    const fee = Number(e.fee ?? 0), builder = Number(e.builderFee ?? 0);
    b.day.strikeFills += 1;
    b.day.strikeVolumeUsd = round2(b.day.strikeVolumeUsd + size * price);
    b.day.builderFeesUsd = round2(b.day.builderFeesUsd + builder);
    b.day.hedgeCostUsd = round2(b.day.hedgeCostUsd + fee + builder + slippage);
    persist(a);
  }

  /** Pending hedges of one leg older than `olderThanMs` looked up over REST: a fill or a close the stream missed is applied. */
  async function syncPending(a, leg, olderThanMs = 0) {
    const { symbol, h } = leg;
    for (const p of h.pending.filter((p) => now() - p.placedAt >= olderThanMs)) {
      const o = await a.strike.order({ symbol, clientOrderId: p.clientOrderId });
      await h.syncOrder({ clientOrderId: p.clientOrderId, status: String(o.Status ?? "").toUpperCase(), filledBtc: Number(o.Filled ?? 0), price: Number(o.Filled) > 0 ? Number(o.Price) : null, closeReason: o.CloseReason || null, at: now() });
    }
  }

  /** After a stream reconnect: each leg's pending orders looked up over REST, then the position Strike reports per market. */
  async function resync(a, legs) {
    const positions = a.sharedStrike !== true ? (await a.strike.positions()).positions ?? [] : null;
    for (const l of legs) {
      if (!l.h) continue;
      await syncPending(a, l);
      if (positions) { const pos = positions.find((x) => x.symbol === l.symbol); await l.h.onStrikeEvent({ kind: "position", symbol: l.symbol, size: pos ? pos.size : "0", at: now() }); }
      entry(a, { kind: "stream.resynced", symbol: l.symbol, pending: l.h.pending.length, strikePositionBtc: l.h.state.strikePositionBtc });
    }
  }

  /**
   * The checker's view of one agent right now, on one of its markets (its first by default); limits hold per market.
   * An agent without legs (a citizen) is seen on `pair`, at that pair's market's mark.
   */
  async function stateOf(a, b, leg = legsOf(b)[0] ?? null, pair = leg?.pair ?? a.venue.pair) {
    const h = leg?.h?.state ?? null;
    const holdings = await a.venue.holdings(pair);
    const open = a.venue.openQuotes.filter((q) => (q.pair ?? a.venue.pair) === pair);
    return {
      mandate: a.mandate, signatureOk: a.signatureOk !== false, frozen: legsOf(b).some((l) => l.h?.state.frozen) || (h?.frozen ?? false), now: now(), mark: leg ? markAt(leg.symbol) : (markAt(marketOfPair(pair)?.symbol) ?? markOf(a)),
      strikePositionBtc: h?.strikePositionBtc ?? 0, leverage: a.leverage ?? a.mandate.strike.maxLeverage,
      midnightInventoryBtc: h ? h.midnightInventoryBtc : 0, unhedgedBtc: h?.unhedgedBtc ?? 0,
      openQuotes: open.length, equityStartUsd: b.day.equityStartUsd ?? 0, equityNowUsd: b.equityNow ?? b.day.equityStartUsd ?? 0,
      actionsLastMinute: b.actions.filter((t) => now() - t < 60_000).length,
      holdings, open,
    };
  }

  /** One action through the checks and, if it passes, to its venue. The action's market or pair picks the leg it is checked against. */
  async function act(a, b, action, reason, run) {
    const leg = (action.symbol && legOfSymbol(b, action.symbol)) || (action.pair && legOfPair(b, action.pair)) || legsOf(b)[0] || null;
    const s = await stateOf(a, b, leg, action.pair ?? leg?.pair ?? a.venue.pair);
    // a stopped agent acts no more, whoever asks (its own mind, its tools); an owner's reduce-only close and an unwind still pass
    const refused = a.stopped && !a.unwinding && !action.reduceOnly ? { rule: "stopped", limit: "a mandate signed anew", attempted: action.kind, message: "stopped by the owner; nothing passes until the mandate is signed again" } : check(action, s);
    const ts = new Date(now()).toISOString();
    const where = { pair: action.pair ?? leg?.pair ?? null, symbol: action.symbol ?? leg?.symbol ?? marketOfPair(action.pair)?.symbol ?? null };
    if (refused) {
      entry(a, { kind: "refusal", action, ...refused, reason });
      feed.refusal({ ts, agentId: a.agentId, venue: action.venue, rule: refused.rule, limit: refused.limit, attempted: refused.attempted, action: action.kind, ...where });
      return { refused };
    }
    b.actions.push(now());
    entry(a, { kind: "decision", action, reason, mark: s.mark });
    feed.decision({ ts, agentId: a.agentId, action: `${action.venue}.${action.kind}`, side: action.side, sizeBtc: action.sizeBtc, price: action.price ?? null, ...(action.quoteId ? { quoteId: action.quoteId } : {}), ...where, reason });
    try {
      const result = await run();
      return { result };
    } catch (err) {
      entry(a, { kind: "action.failed", action, error: err.message.slice(0, 200) });
      return { error: err.message };
    }
  }

  async function makerRound(a, b) {
    if (a.stopped && !a.unwinding) return;
    if (a.unwinding && await unwindDone(a, b)) return;
    for (const leg of legsOf(b)) await makerLeg(a, b, leg);
  }

  /** The maker on one of its markets: its mind, the rules, then the quotes on that market's pair. */
  async function makerLeg(a, b, leg) {
    const s = await stateOf(a, b, leg);
    const mark = markAt(leg.symbol);
    if (!mark) { entry(a, { kind: "no.mark", symbol: leg.symbol }); return; }
    // unwinding: the rules sell the inventory down, no mind; a freeze meanwhile (a late hedge) wins over the unwind
    let options = { minQuoteUsd: minAt(a, leg.symbol), step: leg.rules?.step, tick: leg.rules?.tick, ...a.options, unwind: Boolean(a.unwinding) && !s.frozen };
    let said = null;
    if (a.brain && !s.frozen && !a.unwinding) {
      const h = leg.h;
      const c = await a.brain.decide({
        agentId: a.agentId, symbol: leg.symbol, pair: leg.pair, mark, funding: marks[leg.symbol]?.funding ?? null,
        books: { inventoryBtc: s.midnightInventoryBtc, strikePositionBtc: s.strikePositionBtc, unhedgedBtc: s.unhedgedBtc, netDeltaUsd: round2((s.midnightInventoryBtc + s.strikePositionBtc) * mark) },
        openQuotes: s.open.map(({ side, price, sizeBtc, expiresAt }) => ({ side, price, sizeBtc, expiresAt })),
        recentHedges: (h?.hedges ?? []).slice(-5).map((x) => ({ side: x.fill.side, sizeBtc: x.fill.sizeBtc, latencySec: Math.round(x.latencyMs / 100) / 10 })),
        pendingHedges: h?.pending.length ?? 0,
        mandate: { minSpreadBps: a.mandate.midnight.minSpreadBps, maxSpreadBps: a.mandate.midnight.maxSpreadBps, minQuoteUsd: minAt(a, leg.symbol), maxQuoteUsd: a.mandate.midnight.maxQuoteUsd, maxOpenQuotes: a.mandate.midnight.maxOpenQuotes, maxNetDeltaUsd: a.mandate.risk.maxNetDeltaUsd, hedgeWithinSec: a.mandate.risk.hedgeWithinSec },
        canQuote: { btc: s.holdings.spendable.btc, usd: s.holdings.spendable.usd },
      });
      if (c.fallback) entry(a, { kind: "fallback", reason: c.fallback });
      // a quote under Strike's smallest order could not be hedged: Claude's size is lifted to that floor
      else { options = { ...options, spreadBps: c.spreadBps, sizeUsd: Math.max(c.sizeUsd, minAt(a, leg.symbol)), pause: c.pause }; said = c.reason; }
    }
    const d = makerDecision({ mandate: a.mandate, mark, holdings: s.holdings, openQuotes: s.open, frozen: s.frozen, now: now(), netDeltaBtc: s.midnightInventoryBtc + s.strikePositionBtc, strikePositionBtc: s.strikePositionBtc, inventoryBtc: s.midnightInventoryBtc }, options);
    if (said) d.reason = `${said} (${d.reason})`;
    if (legsOf(b).length > 1) d.reason = `${leg.symbol}: ${d.reason}`;
    for (const id of d.retire) { await a.venue.retire(id); feed.quoteGone(id); }
    for (const q of d.quotes) {
      const r = await act(a, b, { venue: "midnight", kind: "quote", pair: leg.pair, side: q.side, sizeBtc: q.sizeBtc, price: q.price, ttlSec: q.ttlSec }, d.reason, () => a.venue.quote({ ...q, pair: leg.pair }));
      if (r.result) feed.quoteOpen({ ...r.result, agentId: a.agentId, pair: leg.pair });
    }
  }

  /** An unwind is over when every market's inventory is under Strike's smallest order and no hedge is pending: close what is still worth an order, stop again. */
  async function unwindDone(a, b) {
    const legs = legsOf(b);
    for (const l of legs) {
      const inv = l.h?.state.midnightInventoryBtc ?? 0;
      if (Math.abs(inv) * (markAt(l.symbol) ?? 0) >= minAt(a, l.symbol) || l.h?.pending.length) return false;
    }
    const inventoryBtc = legs[0]?.h?.state.midnightInventoryBtc ?? 0;
    const positionBtc = legs[0]?.h?.state.strikePositionBtc ?? 0;
    let closed = null;
    for (const l of legs) {
      const pos = l.h?.state.strikePositionBtc ?? 0;
      if (Math.abs(pos) * (markAt(l.symbol) ?? 0) >= minAt(a, l.symbol)) closed = await this_.portFor(a.agentId).closePosition("unwind: closing the hedge of the inventory sold", l.symbol);
    }
    a.unwinding = false;
    for (const q of a.venue.openQuotes) feed.quoteGone(q.quoteId);
    await a.venue.retireAll();
    for (const l of legs) l.h?.freeze("stopped by the owner, unwound", { manual: true });
    entry(a, { kind: "unwound", inventoryBtc, strikePositionBtc: positionBtc, closed: closed?.refused ? `refused: ${closed.refused.rule}` : closed?.error ? `failed: ${closed.error}` : closed ? "closing" : "nothing to close" });
    await card(a, b);
    return true;
  }

  async function citizenRound(a, b) {
    const all = await a.venue.board({ all: true });
    const s = await stateOf(a, b);
    const pairs = a.venue.pairs ?? [a.venue.pair];
    let d = { take: null, reason: "no pair with a mark" };
    const counts = [];
    for (const pair of pairs) {
      const mark = marks[marketOfPair(pair)?.symbol]?.mark;
      const board = all.filter((q) => (q.pair ?? a.venue.pair) === pair);
      counts.push(`${pair} ${board.length}`);
      if (!mark || !board.length) continue;
      const holdings = pair === a.venue.pair ? s.holdings : await a.venue.holdings(pair);
      d = citizenDecision({ agentId: a.agentId, mark, board, holdings, frozen: s.frozen, now: now(), base: marketOfPair(pair)?.base ?? "BTC" }, { side: a.side ?? "buy", maxUsd: a.mandate.midnight.maxQuoteUsd, rnd, ...a.options });
      if (d.take) break;
    }
    entry(a, { kind: "look", reason: d.reason, board: counts.join(", ") });
    if (!d.take) return;
    const q = d.take;
    const r = await act(a, b, { venue: "midnight", kind: "take", pair: q.pair ?? a.venue.pair, side: q.side === "ask" ? "buy" : "sell", sizeBtc: q.sizeBtc, price: q.price, quoteId: q.quoteId }, d.reason, () => a.venue.take(q));
    if (r.result?.landed) feed.quoteGone(q.quoteId);
  }

  async function fillsRound(a, b) {
    const fills = await a.venue.pollFills();
    for (const f of fills) {
      feed.quoteGone(f.id);
      const leg = legOfPair(b, f.pair ?? a.venue.pair) ?? legsOf(b)[0] ?? null;
      feed.fill({ ts: new Date(f.at).toISOString(), agentId: a.agentId, quoteId: f.id, txHash: f.txHash, midnight: { side: f.side, sizeBtc: f.sizeBtc, price: f.price, pair: f.pair ?? leg?.pair ?? a.venue.pair } });
      // what the fill earned against its market's mark: a sell above it, a buy below it
      const mk = leg ? markAt(leg.symbol) : markOf(a);
      if (mk) b.day.spreadCapturedUsd = round2(b.day.spreadCapturedUsd + (f.side === "sell" ? f.price - mk : mk - f.price) * f.sizeBtc);
      b.day.fills += 1;
      if (leg?.h) await leg.h.onFill(f);
      else { entry(a, { kind: "fill", ...f }); persist(a); }
    }
    for (const l of legsOf(b)) {
      if (!l.h) continue;
      // a hedge the stream has said nothing about for a while is asked after over REST, so a missed fill is not a freeze
      if (a.strike?.order && l.h.pending.length) await syncPending(a, l, PENDING_LOOKUP_MS).catch((err) => entry(a, { kind: "hedge.lookup.error", error: err.message.slice(0, 120) }));
      l.h.tick();
    }
  }

  /** The rogue tries one of its attempts a round; the checks refuse it, nothing is ever built. */
  async function rogueRound(a, b) {
    const attempts = liveAttempts(a.mandate, markOf(a));
    const t = attempts[b.rogueAt++ % attempts.length];
    const r = await act(a, b, t.action, `rogue: ${t.label}`, async () => { throw new Error("a rogue attempt is never carried out"); });
    if (!r.refused) entry(a, { kind: "rogue.passed", label: t.label, action: t.action });
  }

  /** Strike equity for a maker: margin balance, which holds realized and unrealized PnL; the last value when Strike does not answer. */
  async function strikeEquity(a, b) {
    if (!a.strike?.balances) return 0;
    try {
      const bal = (await a.strike.balances())[0];
      b.strikeEquity = Number(bal?.marginBalance ?? bal?.walletBalance ?? 0);
    } catch (err) { entry(a, { kind: "equity.stale", error: err.message.slice(0, 120) }); }
    return b.strikeEquity ?? 0;
  }

  async function card(a, b) {
    const s = await stateOf(a, b);
    const h = b.h?.state;
    const legs = legsOf(b);
    const markOfPair = (pair) => markAt(marketOfPair(pair)?.symbol) ?? null;
    // coins locked in open quotes leave the wallet's balance until the quote fills or goes; they are still the agent's
    const allOpen = a.venue.openQuotes;
    const reservedUsd = round2(allOpen.reduce((sum, q) => sum + q.sizeBtc * (q.side === "ask" ? (markOfPair(q.pair ?? a.venue.pair) ?? q.price) : q.price), 0));
    // every base asset the wallet holds, each at its market's mark; a market without a mark this round leaves the equity as it was
    const bases = Object.entries(s.holdings.bases ?? { [a.venue.pair]: { btc: s.holdings.btc } });
    const marked = bases.every(([pair]) => markOfPair(pair));
    const equityUsd = marked ? round2(bases.reduce((sum, [pair, x]) => sum + x.btc * markOfPair(pair), 0) + s.holdings.usd + reservedUsd + (await strikeEquity(a, b))) : (b.equityWindow?.at(-1) ?? b.day.equityStartUsd ?? 0);
    const legUsd = (l, f) => f(l.h?.state ?? {}) * (markAt(l.symbol) ?? 0);
    const netDeltaUsd = round2(legs.reduce((sum, l) => sum + legUsd(l, (x) => (x.midnightInventoryBtc ?? 0) + (x.strikePositionBtc ?? 0)), 0));
    const unhedgedUsd = round2(legs.reduce((sum, l) => sum + legUsd(l, (x) => x.unhedgedBtc ?? 0), 0));
    const pending = legs.reduce((n, l) => n + (l.h?.pending.length ?? 0), 0);
    const resting = legs.reduce((n, l) => n + (l.h?.pending.filter((p) => p.resting).length ?? 0), 0);
    const frozenLeg = legs.find((l) => l.h?.state.frozen) ?? null;
    if (b.day.date !== today()) b.day = freshDay(marked ? equityUsd : null);
    if (b.day.equityStartUsd === null && marked) b.day.equityStartUsd = equityUsd;
    // a swap in flight leaves the wallet for up to a minute: the loss stop sees the best of the last five readings
    if (marked) { b.equityWindow = [...(b.equityWindow ?? []), equityUsd].slice(-5); b.equityNow = Math.max(...b.equityWindow); }
    persist(a);
    feed.agent(a.agentId, {
      status: a.unwinding ? "unwinding" : a.stopped ? "stopped" : frozenLeg ? (frozenLeg.h.state.manual ? "paused" : "frozen") : pending ? "hedging" : a.mind === "citizen" ? "watching" : a.mind === "rogue" ? "probing" : "quoting",
      stoppedReason: a.stopped ? a.stoppedReason ?? null : null,
      midnight: { btc: s.holdings.btc, usd: s.holdings.usd, reservedUsd, openQuotes: allOpen.length, bases: Object.fromEntries(Object.entries(s.holdings.bases ?? {}).map(([pair, x]) => [pair, x.btc])) },
      strikePositionBtc: h?.strikePositionBtc ?? 0, netDeltaUsd, unhedgedUsd,
      hedges: legs.reduce((n, l) => n + (l.h?.hedges.length ?? 0), 0), maxHedgeLatencySec: legs.some((l) => l.h) ? Math.round(Math.max(...legs.map((l) => l.h?.maxLatencyMs ?? 0)) / 100) / 10 : null,
      pending, resting,
      // one entry per market the agent trades
      legs: Object.fromEntries(legs.map((l) => { const x = l.h?.state ?? {}; const mk = markAt(l.symbol) ?? 0; return [l.symbol, { pair: l.pair, mark: mk, inventoryBtc: x.midnightInventoryBtc ?? 0, strikePositionBtc: x.strikePositionBtc ?? 0, netDeltaUsd: round2(((x.midnightInventoryBtc ?? 0) + (x.strikePositionBtc ?? 0)) * mk), unhedgedUsd: round2((x.unhedgedBtc ?? 0) * mk), openQuotes: allOpen.filter((q) => (q.pair ?? a.venue.pair) === l.pair).length, pending: l.h?.pending.length ?? 0, resting: l.h?.pending.filter((p) => p.resting).length ?? 0, restingOrders: (l.h?.pending ?? []).filter((p) => p.resting).map((p) => ({ clientOrderId: p.clientOrderId, side: p.side, sizeBtc: p.sizeBtc, price: p.price ?? null, since: new Date(p.placedAt).toISOString() })), frozen: x.frozen ?? false }]; })),
      equityUsd, strikeEquityUsd: b.strikeEquity ?? null, equityStartUsd: b.day.equityStartUsd, pnlPct: b.day.equityStartUsd > 0 ? round2((equityUsd - b.day.equityStartUsd) / b.day.equityStartUsd * 100) : 0,
      spreadCapturedUsd: b.day.spreadCapturedUsd, hedgeCostUsd: b.day.hedgeCostUsd, strikeVolumeUsd: b.day.strikeVolumeUsd, builderFeesUsd: b.day.builderFeesUsd,
      day: b.day.date,
    });
  }

  async function round() {
    marks = marksOf(await mark());
    feed.setMarks(marks);
    // the board lets a quote lapse at its expiry; the feed follows
    for (const q of feed.get("quotes").quotes) if (q.expiresAt && Date.parse(q.expiresAt) <= now()) feed.quoteGone(q.quoteId);
    for (const a of agents) {
      const b = books.get(a.agentId);
      try {
        await fillsRound(a, b);
        if (a.mind === "maker") await makerRound(a, b);
        else if (a.mind === "citizen") await citizenRound(a, b);
        else if (a.mind === "rogue") await rogueRound(a, b);
        await card(a, b);
      } catch (err) {
        entry(a, { kind: "round.error", error: err.message.slice(0, 200) });
      }
    }
  }

  let timer = null;
  let running = false;
  let current = null; // the round in flight, so stop() does not close wallets under it
  const guarded = () => { current = round().catch((err) => log({ kind: "gateway.error", error: err.message })); return current; };
  const this_ = {
    round: guarded,
    start(roundMs = 20_000) {
      if (running) return;
      running = true;
      const loop = async () => { if (!running) return; await guarded(); timer = setTimeout(loop, roundMs); };
      loop();
    },
    /** Without an agent: the loop ends after the round in flight, every quote is retired, every stream closed. With one: that agent is stopped by its owner (below). */
    async stop(agentId, reason = "stopped by the owner") {
      if (agentId !== undefined) return this_.stopAgent(agentId, reason);
      running = false;
      clearTimeout(timer);
      await current;
      for (const a of agents) { await a.venue.retireAll().catch(() => {}); a.streamHandle?.close(); }
    },
    /** Hedge what every maker carries from the last run; call once after the mark is known. */
    async rehedge() {
      marks = marksOf(await mark());
      for (const a of agents) for (const l of legsOf(books.get(a.agentId))) if (l.h) await l.h.rehedge();
    },
    /** The hedger of an agent on one market (its first by default). */
    hedgerOf: (agentId, symbol) => (symbol ? legOfSymbol(books.get(agentId), symbol)?.h : books.get(agentId)?.h) ?? null,
    /** An agent made while the loop runs: it takes part from the next round on. */
    addAgent,
    agentIds: () => agents.map((a) => a.agentId),
    /** One agent's port for the MCP tools: every write goes through the checks like the gateway's own minds. */
    portFor(agentId) {
      const a = agents.find((x) => x.agentId === agentId);
      const b = books.get(agentId);
      if (!a) throw new Error(`no agent ${agentId}`);
      const m = a.mandate;
      return {
        // the leg an MCP call means: its `symbol` or `pair`, else the agent's first market
        legFor: (x = {}) => (x.symbol && legOfSymbol(b, x.symbol)) || (x.pair && legOfPair(b, x.pair)) || legsOf(b)[0] || null,
        async mandate() {
          const legs = legsOf(b);
          const states = legs.length ? await Promise.all(legs.map((l) => stateOf(a, b, l))) : [await stateOf(a, b)];
          // room across every market: delta is summed, the position and the open quotes take the most used market
          const deltaUsd = states.reduce((sum, s) => sum + Math.abs(s.midnightInventoryBtc + s.strikePositionBtc) * (s.mark ?? 0), 0);
          const positionUsd = Math.max(...states.map((s) => Math.abs(s.strikePositionBtc) * (s.mark ?? 0)));
          const openQuotes = Math.max(...states.map((s) => s.openQuotes));
          return { mandate: m, hash: mandateHash(m), markets: legs.map((l) => l.symbol), room: { netDeltaUsd: round2(m.risk.maxNetDeltaUsd - deltaUsd), positionUsd: round2(m.strike.maxPositionUsd - positionUsd), openQuotes: m.midnight.maxOpenQuotes - openQuotes, actionsThisMinute: m.risk.maxActionsPerMin - states[0].actionsLastMinute } };
        },
        async market(x) {
          const leg = this.legFor(x);
          const symbol = leg?.symbol ?? symbolOf(a);
          return { symbol, pair: leg?.pair ?? a.venue.pair, mark: markAt(symbol), funding: marks[symbol]?.funding ?? null, markets: Object.fromEntries(legsOf(b).map((l) => [l.symbol, { pair: l.pair, mark: markAt(l.symbol), funding: marks[l.symbol]?.funding ?? null }])), board: await a.venue.board({ all: true }) };
        },
        async account() {
          const s = await stateOf(a, b);
          const legs = await Promise.all(legsOf(b).map(async (l) => { const x = await stateOf(a, b, l); return [l.symbol, { pair: l.pair, strikePositionBtc: x.strikePositionBtc, inventoryBtc: x.midnightInventoryBtc, netDeltaUsd: round2((x.midnightInventoryBtc + x.strikePositionBtc) * (x.mark ?? 0)), unhedgedBtc: x.unhedgedBtc, openQuotes: x.open, frozen: l.h?.state.frozen ?? false, pendingHedges: l.h?.pending ?? [] }]; }));
          return { midnight: s.holdings, openQuotes: a.venue.openQuotes, strikePositionBtc: s.strikePositionBtc, netDeltaUsd: round2((s.midnightInventoryBtc + s.strikePositionBtc) * (s.mark ?? 0)), unhedgedBtc: s.unhedgedBtc, frozen: s.frozen, frozenReason: b.h?.state.frozenReason ?? null, pendingHedges: b.h?.pending ?? [], markets: Object.fromEntries(legs) };
        },
        async preview(action) {
          const leg = this.legFor(action);
          const full = { ...action, symbol: leg?.symbol ?? m.strike.markets[0], pair: leg?.pair ?? a.venue.pair };
          const refused = check(full, await stateOf(a, b, leg));
          return refused ? { ok: false, refused } : { ok: true };
        },
        async postQuote(q, why) {
          const pair = this.legFor(q)?.pair ?? a.venue.pair;
          const r = await act(a, b, { venue: "midnight", kind: "quote", pair, side: q.side, sizeBtc: q.sizeBtc, price: q.price, ttlSec: q.ttlSec ?? m.midnight.quoteTtlSec }, why, () => a.venue.quote({ side: q.side, sizeBtc: q.sizeBtc, price: q.price, pair, ttlSec: q.ttlSec ?? m.midnight.quoteTtlSec }));
          if (r.result) feed.quoteOpen({ ...r.result, agentId, pair });
          return r.refused ? { refused: r.refused } : r.error ? { error: r.error } : r.result;
        },
        async takeQuote(quoteId, why) {
          const q = (await a.venue.board({ all: true })).find((x) => x.quoteId === quoteId);
          if (!q) return { error: `no open quote ${quoteId}` };
          const r = await act(a, b, { venue: "midnight", kind: "take", pair: q.pair ?? a.venue.pair, side: q.side === "ask" ? "buy" : "sell", sizeBtc: q.sizeBtc, price: q.price, quoteId }, why, () => a.venue.take(q));
          if (r.result?.landed) feed.quoteGone(quoteId);
          return r.refused ? { refused: r.refused } : r.error ? { error: r.error } : r.result;
        },
        async placeOrder(o, why) {
          if (!a.strike) return { error: "this agent has no Strike account" };
          const symbol = this.legFor(o)?.symbol ?? m.strike.markets[0];
          // the order's id is in the logged decision, so the reconciler knows the fill it brings
          const clientOrderId = `${agentId}-tool-${now()}`;
          const r = await act(a, b, { venue: "strike", kind: "order", symbol, side: o.side, sizeBtc: o.sizeBtc, price: o.price, clientOrderId }, why, () => a.strike.placeOrder({ symbol, side: o.side, size: o.sizeBtc, ...(o.price ? { type: "limit", price: o.price } : { type: "market", slippage: m.strike.priceBandPct / 100 }), clientOrderId }));
          return r.refused ? { refused: r.refused } : r.error ? { error: r.error } : r.result;
        },
        async hedge() {
          const legs = legsOf(b).filter((l) => l.h);
          if (!legs.length) return { placed: false, error: "no hedger" };
          const out = {};
          for (const l of legs) out[l.symbol] = await l.h.rehedge();
          return legs.length === 1 ? out[legs[0].symbol] : { placed: Object.values(out).some((x) => x.placed), markets: out };
        },
        async cancelAll() {
          const quotes = a.venue.openQuotes.length;
          await a.venue.retireAll();
          for (const q of a.venue.openQuotes) feed.quoteGone(q.quoteId);
          let strike = 0;
          if (a.strike) for (const symbol of symbolsOf(a)) { const n = (await a.strike.openOrders(symbol)).count ?? 0; if (n) await a.strike.cancelAll(symbol); strike += n; }
          entry(a, { kind: "cancel_all", quotes, strike });
          return { quotes, strike };
        },
        /** The whole Strike position closed with reduce-only market orders: on one market, or on every market the agent trades. */
        async closePosition(why, symbol = null) {
          if (!a.strike) return { error: "this agent has no Strike account" };
          const legs = symbol ? [legOfSymbol(b, symbol)].filter(Boolean) : legsOf(b);
          if (symbol && !legs.length) return { error: `this agent does not trade ${symbol}` };
          let last = { closed: 0 };
          for (const leg of legs) {
            const s = await stateOf(a, b, leg);
            if (Math.abs(s.strikePositionBtc) < 1e-9) continue;
            const side = s.strikePositionBtc > 0 ? "sell" : "buy";
            const clientOrderId = `${agentId}-close-${now()}`;
            const r = await act(a, b, { venue: "strike", kind: "order", symbol: leg.symbol, side, sizeBtc: Math.abs(s.strikePositionBtc), reduceOnly: true, clientOrderId }, why, () => a.strike.placeOrder({ symbol: leg.symbol, side, type: "market", size: Math.abs(s.strikePositionBtc), reduceOnly: true, slippage: m.strike.priceBandPct / 100, clientOrderId }));
            last = r.refused ? { refused: r.refused } : r.error ? { error: r.error } : r.result;
            if (r.refused || r.error) return last;
          }
          return last;
        },
      };
    },
    freeze: (agentId, reason, opts) => { for (const l of legsOf(books.get(agentId))) l.h?.freeze(reason, opts); },
    resume: (agentId) => { for (const l of legsOf(books.get(agentId))) l.h?.resume(); },
    /**
     * The owner stops an agent: frozen by hand, its quotes and tool orders pulled, nothing new until a mandate is
     * signed again. Stop means flat: what is still unhedged goes to Strike at once as a market order (a resting limit
     * is replaced by it); when Strike cannot fill it, a limit rests again and the card says so.
     */
    async stopAgent(agentId, reason = "stopped by the owner") {
      const a = agents.find((x) => x.agentId === agentId);
      if (!a) return null;
      const b = books.get(agentId);
      a.stopped = true;
      a.unwinding = false;
      for (const l of legsOf(b)) l.h?.freeze(reason, { manual: true });
      const quotes = a.venue.openQuotes.map((q) => q.quoteId);
      await a.venue.retireAll();
      for (const id of quotes) feed.quoteGone(id);
      const hedges = {};
      for (const l of legsOf(b)) if (l.h) { const x = await l.h.flatten(); hedges[l.symbol] = x.placed ? `market order ${x.clientOrderId}` : x.refused ? `refused: ${x.refused.rule}` : x.error ? `failed: ${x.error}` : x.small ? "a remainder under Strike's minimum" : "flat"; }
      const strike = await cancelToolOrders(a);
      const r = { quotes: quotes.length, strike, hedges };
      entry(a, { kind: "stopped", reason, ...r });
      await card(a, b);
      return r;
    },
    /** A payout or a deposit moves the agent's equity without a trade: the day's baseline for the loss stop moves with it. */
    adjustEquityStart(agentId, deltaUsd, why) {
      const a = agents.find((x) => x.agentId === agentId);
      const b = books.get(agentId);
      if (!a || !b || b.day.equityStartUsd === null || !Number.isFinite(deltaUsd) || !deltaUsd) return null;
      b.day.equityStartUsd = round2(b.day.equityStartUsd + deltaUsd);
      if (b.equityWindow?.length) { b.equityWindow = b.equityWindow.map((x) => round2(x + deltaUsd)); b.equityNow = Math.max(...b.equityWindow); }
      entry(a, { kind: "equity.base", deltaUsd, why, equityStartUsd: b.day.equityStartUsd });
      persist(a);
      return b.day.equityStartUsd;
    },
    /** An owner's agent that waited for a deposit on its own Strike account trades once it is credited. */
    funded(agentId) {
      const a = agents.find((x) => x.agentId === agentId);
      if (!a?.stopped || a.stoppedReason !== "deposit needed") return false;
      a.stopped = false;
      a.stoppedReason = null;
      for (const l of legsOf(books.get(agentId))) if (l.h?.state.frozen && l.h.state.manual) l.h.resume();
      entry(a, { kind: "funded" });
      return true;
    },
    /**
     * The owner winds an agent down: stopped, then it quotes only the side that sells its inventory, hedged on fill,
     * until the rest is under Strike's smallest order; a position still worth an order is closed, the agent stopped for good.
     */
    async unwind(agentId, reason = "unwound by the owner") {
      const a = agents.find((x) => x.agentId === agentId);
      if (!a) return null;
      const b = books.get(agentId);
      if (!b?.h) throw Object.assign(new Error("this agent has no hedger: nothing to unwind"), { status: 409 });
      if (!a.stopped) await this_.stop(agentId, reason);
      a.unwinding = true;
      for (const l of legsOf(b)) if (l.h?.state.frozen && l.h.state.manual) l.h.resume();
      const h = b.h.state;
      const inventoryUsd = round2(legsOf(b).reduce((sum, l) => sum + (l.h?.state.midnightInventoryBtc ?? 0) * (markAt(l.symbol) ?? 0), 0));
      entry(a, { kind: "unwinding", reason, inventoryBtc: h.midnightInventoryBtc, strikePositionBtc: h.strikePositionBtc, inventoryUsd });
      await card(a, b);
      return { inventoryBtc: h.midnightInventoryBtc, strikePositionBtc: h.strikePositionBtc, inventoryUsd };
    },
    close: (agentId, why = "closed by the owner") => this_.portFor(agentId).closePosition(why),
    /** A fresh Strike client and stream for a running agent (a rotated API wallet): the old stream closed, the new one opened, state resynced. */
    async setStrike(agentId, { strike, stream }) {
      const a = agents.find((x) => x.agentId === agentId);
      const legs = legsOf(books.get(agentId)).filter((l) => l.h);
      if (!a || !legs.length) throw new Error(`no hedging agent ${agentId}`);
      a.strike = strike;
      a.streamHandle?.close();
      a.stream = stream;
      if (stream) openStream(a, legs);
      await resync(a, legs);
      entry(a, { kind: "strike.rotated" });
    },
    /** A mandate the owner signed anew: in force from the next round; a stop or a hand freeze ends with it. */
    setMandate(agentId, mandate) {
      const a = agents.find((x) => x.agentId === agentId);
      if (!a) return null;
      a.mandate = mandate;
      a.signatureOk = true;
      a.stopped = false;
      a.stoppedReason = null;
      a.unwinding = false;
      for (const l of legsOf(books.get(agentId))) { l.h?.setMandate(mandate); if (l.h?.state.frozen && l.h.state.manual) l.h.resume(); }
      entry(a, { kind: "mandate.signed", mandateHash: mandateHash(mandate), expiry: mandate.expiry });
      feed.agent(agentId, { mandate: mandateCard(mandate) });
      return mandateHash(mandate);
    },
    stateOf: (agentId) => { const l = legsOf(books.get(agentId)).find((x) => x.h?.state.frozen); const h = (l ?? legsOf(books.get(agentId))[0])?.h?.state; return { frozen: h?.frozen ?? false, frozenReason: h?.frozenReason ?? null }; },
  };
  return this_;
}

const round2 = (x) => Math.round(x * 100) / 100;
export const mandateCard = (m) => ({ hash: mandateHash(m), maxNetDeltaUsd: m.risk.maxNetDeltaUsd, hedgeWithinSec: m.risk.hedgeWithinSec, maxQuoteUsd: m.midnight.maxQuoteUsd, maxPositionUsd: m.strike.maxPositionUsd, full: m });
