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

/**
 * @param {object} o
 * @param {Array<{ agentId, mandate, signatureOk, venue, strike?, stream?, sharedStrike?, wallets?, mind: "maker"|"citizen"|"rogue", side?: "buy"|"sell" }>} o.agents
 *   venue: a midnightVenue; strike: a strikeClient; stream: a userStream factory (onEvent, onStatus) => ({ close });
 *   sharedStrike: the Strike key serves other agents too, so account-wide events are not this agent's;
 *   wallets: { cardano, midnight } for the agent's card
 * @param {() => Promise<number>} o.mark      Strike mark price
 * @param {object} o.feed                     feedState
 * @param {(entry) => object} o.log           decisionLog.append
 * @param {() => number} [o.now]
 * @param {number} [o.pollEveryRounds]        fill poll cadence in rounds (each poll costs a gateway call per open quote)
 */
export function gateway({ agents, mark, feed, log, now = Date.now, rnd = Math.random, books: saved = {}, saveBooks = () => {}, minHedgeUsd = 0 }) {
  const PENDING_LOOKUP_MS = 10_000;
  const books = new Map(); // agentId → { h (hedger|null), actions: number[] (timestamps), day, equityNow, rogueAt }
  let lastMark = null;
  let lastFunding = null;
  const today = () => new Date(now()).toISOString().slice(0, 10);
  // the day's figures for the card and the loss stop, kept in the books so a restart does not reset them
  const freshDay = (equityStartUsd = null) => ({ date: today(), equityStartUsd, spreadCapturedUsd: 0, hedgeCostUsd: 0, strikeVolumeUsd: 0, builderFeesUsd: 0, fills: 0, strikeFills: 0 });
  const persist = (a) => { const b = books.get(a.agentId); if (b) saveBooks(a.agentId, { ...(b.h?.snapshot() ?? {}), day: b.day }); };

  for (const a of agents) {
    const { day: savedDay, ...savedBooks } = saved[a.agentId] ?? {};
    const h = a.strike ? hedger({
      mandate: a.mandate, symbol: a.mandate.strike.markets[0] ?? "BTC-USD",
      strike: { mark: () => lastMark ?? 0, placeOrder: (o) => a.strike.placeOrder(o.type === "limit" ? o : { ...o, type: "market", slippage: a.mandate.strike.priceBandPct / 100 }), cancel: (o) => a.strike.cancel(o) },
      log: (e) => entry(a, e), now,
      state: savedBooks, onChange: () => persist(a), minNotionalUsd: minHedgeUsd,
      onHedged: (x) => feed.fillHedged(x.fill.id, hedgeCard(x)), ownAccount: a.sharedStrike !== true,
    }) : null;
    books.set(a.agentId, { h, actions: [], day: savedDay?.date === today() ? savedDay : freshDay(), equityNow: null, rogueAt: 0 });
    if (h && a.stream) {
      let opens = 0;
      a.streamHandle = a.stream(
        (e) => { h.onStrikeEvent(e).catch((err) => entry(a, { kind: "stream.error", error: err.message })); if (e.kind === "fill" && ownOrder(a, e.clientOrderId)) { feed.fill(fillCard(a, e)); countStrikeFill(a, e); } },
        // the stream replays nothing: after a reconnect, what the pending orders did meanwhile comes from REST
        (x) => { if (x.state === "open" && opens++ > 0) resync(a, h).catch((err) => entry(a, { kind: "stream.resync.failed", error: err.message })); },
      );
    }
    feed.agent(a.agentId, { agentId: a.agentId, name: a.name ?? a.agentId, type: a.mind === "maker" ? "mm" : a.mind, status: "starting", mandate: mandateCard(a.mandate), wallets: a.wallets ?? null });
  }

  const entry = (a, e) => log({ agent: a.agentId, ...e });
  const ownOrder = (a, clientOrderId) => typeof clientOrderId === "string" && clientOrderId.startsWith(`${a.agentId}-`);
  const fillCard = (a, e) => ({ ts: new Date(now()).toISOString(), agentId: a.agentId, strikeFill: { side: e.side, size: e.size, price: e.price, clientOrderId: e.clientOrderId } });
  const hedgeCard = (x) => ({ how: x.hedge.how, clientOrderIds: x.hedge.clientOrderIds, price: x.hedge.price, latencySec: Math.round(x.latencyMs / 100) / 10, at: new Date(x.hedge.at).toISOString() });

  /** A Strike fill of this agent: volume, fees and slippage against the mark go to the day's figures. */
  function countStrikeFill(a, e) {
    const b = books.get(a.agentId);
    const size = Number(e.size), price = Number(e.price);
    const slippage = lastMark ? (e.side === "BUY" ? price - lastMark : lastMark - price) * size : 0;
    const fee = Number(e.fee ?? 0), builder = Number(e.builderFee ?? 0);
    b.day.strikeFills += 1;
    b.day.strikeVolumeUsd = round2(b.day.strikeVolumeUsd + size * price);
    b.day.builderFeesUsd = round2(b.day.builderFeesUsd + builder);
    b.day.hedgeCostUsd = round2(b.day.hedgeCostUsd + fee + builder + slippage);
    persist(a);
  }

  /** Pending hedges older than `olderThanMs` looked up over REST: a fill or a close the stream missed is applied. */
  async function syncPending(a, h, olderThanMs = 0) {
    const symbol = a.mandate.strike.markets[0] ?? "BTC-USD";
    for (const p of h.pending.filter((p) => now() - p.placedAt >= olderThanMs)) {
      const o = await a.strike.order({ symbol, clientOrderId: p.clientOrderId });
      await h.syncOrder({ clientOrderId: p.clientOrderId, status: String(o.Status ?? "").toUpperCase(), filledBtc: Number(o.Filled ?? 0), price: Number(o.Filled) > 0 ? Number(o.Price) : null, closeReason: o.CloseReason || null, at: now() });
    }
  }

  /** After a stream reconnect: each pending order looked up over REST, then the position Strike reports. */
  async function resync(a, h) {
    const symbol = a.mandate.strike.markets[0] ?? "BTC-USD";
    await syncPending(a, h);
    if (a.sharedStrike !== true) {
      const pos = (await a.strike.positions()).positions?.find((x) => x.symbol === symbol);
      await h.onStrikeEvent({ kind: "position", symbol, size: pos ? pos.size : "0", at: now() });
    }
    entry(a, { kind: "stream.resynced", pending: h.pending.length, strikePositionBtc: h.state.strikePositionBtc });
  }

  /** The checker's view of one agent right now. */
  async function stateOf(a, b) {
    const h = b.h?.state;
    const holdings = await a.venue.holdings();
    const open = a.venue.openQuotes;
    return {
      mandate: a.mandate, signatureOk: a.signatureOk !== false, frozen: h?.frozen ?? false, now: now(), mark: lastMark,
      strikePositionBtc: h?.strikePositionBtc ?? 0, leverage: a.leverage ?? a.mandate.strike.maxLeverage,
      midnightInventoryBtc: h ? h.midnightInventoryBtc : 0, unhedgedBtc: h?.unhedgedBtc ?? 0,
      openQuotes: open.length, equityStartUsd: b.day.equityStartUsd ?? 0, equityNowUsd: b.equityNow ?? b.day.equityStartUsd ?? 0,
      actionsLastMinute: b.actions.filter((t) => now() - t < 60_000).length,
      holdings, open,
    };
  }

  /** One action through the checks and, if it passes, to its venue. */
  async function act(a, b, action, reason, run) {
    const s = await stateOf(a, b);
    const refused = check(action, s);
    const ts = new Date(now()).toISOString();
    if (refused) {
      entry(a, { kind: "refusal", action, ...refused, reason });
      feed.refusal({ ts, agentId: a.agentId, venue: action.venue, rule: refused.rule, limit: refused.limit, attempted: refused.attempted, action: action.kind });
      return { refused };
    }
    b.actions.push(now());
    entry(a, { kind: "decision", action, reason, mark: lastMark });
    feed.decision({ ts, agentId: a.agentId, action: `${action.venue}.${action.kind}`, side: action.side, sizeBtc: action.sizeBtc, price: action.price ?? null, ...(action.quoteId ? { quoteId: action.quoteId } : {}), reason });
    try {
      const result = await run();
      return { result };
    } catch (err) {
      entry(a, { kind: "action.failed", action, error: err.message.slice(0, 200) });
      return { error: err.message };
    }
  }

  async function makerRound(a, b) {
    if (a.stopped) return;
    const s = await stateOf(a, b);
    let options = { minQuoteUsd: minHedgeUsd, ...a.options };
    let said = null;
    if (a.brain && !s.frozen) {
      const h = b.h;
      const c = await a.brain.decide({
        agentId: a.agentId, mark: lastMark, funding: lastFunding,
        books: { inventoryBtc: s.midnightInventoryBtc, strikePositionBtc: s.strikePositionBtc, unhedgedBtc: s.unhedgedBtc, netDeltaUsd: round2((s.midnightInventoryBtc + s.strikePositionBtc) * lastMark) },
        openQuotes: s.open.map(({ side, price, sizeBtc, expiresAt }) => ({ side, price, sizeBtc, expiresAt })),
        recentHedges: (h?.hedges ?? []).slice(-5).map((x) => ({ side: x.fill.side, sizeBtc: x.fill.sizeBtc, latencySec: Math.round(x.latencyMs / 100) / 10 })),
        pendingHedges: h?.pending.length ?? 0,
        mandate: { minSpreadBps: a.mandate.midnight.minSpreadBps, maxSpreadBps: a.mandate.midnight.maxSpreadBps, minQuoteUsd: minHedgeUsd, maxQuoteUsd: a.mandate.midnight.maxQuoteUsd, maxOpenQuotes: a.mandate.midnight.maxOpenQuotes, maxNetDeltaUsd: a.mandate.risk.maxNetDeltaUsd, hedgeWithinSec: a.mandate.risk.hedgeWithinSec },
        canQuote: { btc: s.holdings.spendable.btc, usd: s.holdings.spendable.usd },
      });
      if (c.fallback) entry(a, { kind: "fallback", reason: c.fallback });
      // a quote under Strike's smallest order could not be hedged: Claude's size is lifted to that floor
      else { options = { ...options, spreadBps: c.spreadBps, sizeUsd: Math.max(c.sizeUsd, minHedgeUsd), pause: c.pause }; said = c.reason; }
    }
    const d = makerDecision({ mandate: a.mandate, mark: lastMark, holdings: s.holdings, openQuotes: s.open, frozen: s.frozen, now: now(), netDeltaBtc: s.midnightInventoryBtc + s.strikePositionBtc, strikePositionBtc: s.strikePositionBtc }, options);
    if (said) d.reason = `${said} (${d.reason})`;
    for (const id of d.retire) { await a.venue.retire(id); feed.quoteGone(id); }
    for (const q of d.quotes) {
      const r = await act(a, b, { venue: "midnight", kind: "quote", pair: a.venue.pair, side: q.side, sizeBtc: q.sizeBtc, price: q.price, ttlSec: q.ttlSec }, d.reason, () => a.venue.quote(q));
      if (r.result) feed.quoteOpen({ ...r.result, agentId: a.agentId, pair: a.venue.pair });
    }
  }

  async function citizenRound(a, b) {
    const board = await a.venue.board();
    const s = await stateOf(a, b);
    const d = citizenDecision({ agentId: a.agentId, mark: lastMark, board, holdings: s.holdings, frozen: s.frozen, now: now() }, { side: a.side ?? "buy", maxUsd: a.mandate.midnight.maxQuoteUsd, rnd, ...a.options });
    entry(a, { kind: "look", reason: d.reason, board: board.length });
    if (!d.take) return;
    const q = d.take;
    const r = await act(a, b, { venue: "midnight", kind: "take", pair: a.venue.pair, side: q.side === "ask" ? "buy" : "sell", sizeBtc: q.sizeBtc, price: q.price, quoteId: q.quoteId }, d.reason, () => a.venue.take(q));
    if (r.result?.landed) feed.quoteGone(q.quoteId);
  }

  async function fillsRound(a, b) {
    const fills = await a.venue.pollFills();
    for (const f of fills) {
      feed.quoteGone(f.id);
      feed.fill({ ts: new Date(f.at).toISOString(), agentId: a.agentId, quoteId: f.id, txHash: f.txHash, midnight: { side: f.side, sizeBtc: f.sizeBtc, price: f.price } });
      // what the fill earned against the mark: a sell above it, a buy below it
      if (lastMark) b.day.spreadCapturedUsd = round2(b.day.spreadCapturedUsd + (f.side === "sell" ? f.price - lastMark : lastMark - f.price) * f.sizeBtc);
      b.day.fills += 1;
      if (b.h) await b.h.onFill(f);
      else { entry(a, { kind: "fill", ...f }); persist(a); }
    }
    if (!b.h) return;
    // a hedge the stream has said nothing about for a while is asked after over REST, so a missed fill is not a freeze
    if (a.strike?.order && b.h.pending.length) await syncPending(a, b.h, PENDING_LOOKUP_MS).catch((err) => entry(a, { kind: "hedge.lookup.error", error: err.message.slice(0, 120) }));
    b.h.tick();
  }

  /** The rogue tries one of its attempts a round; the checks refuse it, nothing is ever built. */
  async function rogueRound(a, b) {
    const attempts = liveAttempts(a.mandate, lastMark);
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
    const deltaBtc = (h?.midnightInventoryBtc ?? 0) + (h?.strikePositionBtc ?? 0);
    // coins locked in open quotes leave the wallet's balance until the quote fills or goes; they are still the agent's
    const reservedUsd = round2(s.open.reduce((sum, q) => sum + (q.side === "ask" ? q.sizeBtc * lastMark : q.sizeBtc * q.price), 0));
    const equityUsd = round2(s.holdings.btc * lastMark + s.holdings.usd + reservedUsd + (await strikeEquity(a, b)));
    if (b.day.date !== today()) b.day = freshDay(equityUsd);
    if (b.day.equityStartUsd === null) b.day.equityStartUsd = equityUsd;
    // a swap in flight leaves the wallet for up to a minute: the loss stop sees the best of the last five readings
    b.equityWindow = [...(b.equityWindow ?? []), equityUsd].slice(-5);
    b.equityNow = Math.max(...b.equityWindow);
    persist(a);
    feed.agent(a.agentId, {
      status: a.stopped ? "stopped" : h?.frozen ? (h.manual ? "paused" : "frozen") : b.h?.pending.length ? "hedging" : a.mind === "citizen" ? "watching" : a.mind === "rogue" ? "probing" : "quoting",
      midnight: { btc: s.holdings.btc, usd: s.holdings.usd, reservedUsd, openQuotes: s.open.length },
      strikePositionBtc: h?.strikePositionBtc ?? 0, netDeltaUsd: round2(deltaBtc * lastMark), unhedgedUsd: round2((h?.unhedgedBtc ?? 0) * lastMark),
      hedges: b.h?.hedges.length ?? 0, maxHedgeLatencySec: b.h ? Math.round(b.h.maxLatencyMs / 100) / 10 : null,
      pending: b.h?.pending.length ?? 0,
      equityUsd, equityStartUsd: b.day.equityStartUsd, pnlPct: b.day.equityStartUsd > 0 ? round2((equityUsd - b.day.equityStartUsd) / b.day.equityStartUsd * 100) : 0,
      spreadCapturedUsd: b.day.spreadCapturedUsd, hedgeCostUsd: b.day.hedgeCostUsd, strikeVolumeUsd: b.day.strikeVolumeUsd, builderFeesUsd: b.day.builderFeesUsd,
      day: b.day.date,
    });
  }

  async function round() {
    const m = await mark();
    if (typeof m === "object") { lastMark = m.mark; lastFunding = m.funding ?? null; } else lastMark = m;
    feed.setMark(lastMark);
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
    async stop() {
      running = false;
      clearTimeout(timer);
      await current;
      for (const a of agents) { await a.venue.retireAll().catch(() => {}); a.streamHandle?.close(); }
    },
    /** Hedge what every maker carries from the last run; call once after the mark is known. */
    async rehedge() {
      const m = await mark();
      lastMark = typeof m === "object" ? m.mark : m;
      for (const a of agents) { const h = books.get(a.agentId)?.h; if (h) await h.rehedge(); }
    },
    hedgerOf: (agentId) => books.get(agentId)?.h ?? null,
    /** One agent's port for the MCP tools: every write goes through the checks like the gateway's own minds. */
    portFor(agentId) {
      const a = agents.find((x) => x.agentId === agentId);
      const b = books.get(agentId);
      if (!a) throw new Error(`no agent ${agentId}`);
      const m = a.mandate;
      return {
        async mandate() {
          const s = await stateOf(a, b);
          const deltaUsd = Math.abs(s.midnightInventoryBtc + s.strikePositionBtc) * lastMark;
          return { mandate: m, hash: mandateHash(m), room: { netDeltaUsd: round2(m.risk.maxNetDeltaUsd - deltaUsd), positionUsd: round2(m.strike.maxPositionUsd - Math.abs(s.strikePositionBtc) * lastMark), openQuotes: m.midnight.maxOpenQuotes - s.openQuotes, actionsThisMinute: m.risk.maxActionsPerMin - s.actionsLastMinute } };
        },
        async market() { return { mark: lastMark, funding: lastFunding, board: await a.venue.board() }; },
        async account() {
          const s = await stateOf(a, b);
          return { midnight: s.holdings, openQuotes: s.open, strikePositionBtc: s.strikePositionBtc, netDeltaUsd: round2((s.midnightInventoryBtc + s.strikePositionBtc) * lastMark), unhedgedBtc: s.unhedgedBtc, frozen: s.frozen, frozenReason: b.h?.state.frozenReason ?? null, pendingHedges: b.h?.pending ?? [] };
        },
        async preview(action) {
          const full = { ...action, symbol: m.strike.markets[0], pair: a.venue.pair };
          const refused = check(full, await stateOf(a, b));
          return refused ? { ok: false, refused } : { ok: true };
        },
        async postQuote(q, why) {
          const r = await act(a, b, { venue: "midnight", kind: "quote", pair: a.venue.pair, side: q.side, sizeBtc: q.sizeBtc, price: q.price, ttlSec: q.ttlSec ?? m.midnight.quoteTtlSec }, why, () => a.venue.quote({ ...q, ttlSec: q.ttlSec ?? m.midnight.quoteTtlSec }));
          if (r.result) feed.quoteOpen({ ...r.result, agentId, pair: a.venue.pair });
          return r.refused ? { refused: r.refused } : r.error ? { error: r.error } : r.result;
        },
        async takeQuote(quoteId, why) {
          const q = (await a.venue.board()).find((x) => x.quoteId === quoteId);
          if (!q) return { error: `no open quote ${quoteId}` };
          const r = await act(a, b, { venue: "midnight", kind: "take", pair: a.venue.pair, side: q.side === "ask" ? "buy" : "sell", sizeBtc: q.sizeBtc, price: q.price }, why, () => a.venue.take(q));
          if (r.result?.landed) feed.quoteGone(quoteId);
          return r.refused ? { refused: r.refused } : r.error ? { error: r.error } : r.result;
        },
        async placeOrder(o, why) {
          if (!a.strike) return { error: "this agent has no Strike account" };
          const r = await act(a, b, { venue: "strike", kind: "order", symbol: m.strike.markets[0], side: o.side, sizeBtc: o.sizeBtc, price: o.price }, why, () => a.strike.placeOrder({ symbol: m.strike.markets[0], side: o.side, size: o.sizeBtc, ...(o.price ? { type: "limit", price: o.price } : { type: "market", slippage: m.strike.priceBandPct / 100 }), clientOrderId: `${agentId}-tool-${now()}` }));
          return r.refused ? { refused: r.refused } : r.error ? { error: r.error } : r.result;
        },
        async hedge() { return b.h ? b.h.rehedge() : { placed: false, error: "no hedger" }; },
        async cancelAll() {
          const quotes = a.venue.openQuotes.length;
          await a.venue.retireAll();
          for (const q of a.venue.openQuotes) feed.quoteGone(q.quoteId);
          let strike = 0;
          if (a.strike) { strike = (await a.strike.openOrders(m.strike.markets[0])).count ?? 0; if (strike) await a.strike.cancelAll(m.strike.markets[0]); }
          entry(a, { kind: "cancel_all", quotes, strike });
          return { quotes, strike };
        },
        async closePosition(why) {
          if (!a.strike) return { error: "this agent has no Strike account" };
          const s = await stateOf(a, b);
          if (Math.abs(s.strikePositionBtc) < 1e-9) return { closed: 0 };
          const side = s.strikePositionBtc > 0 ? "sell" : "buy";
          const r = await act(a, b, { venue: "strike", kind: "order", symbol: m.strike.markets[0], side, sizeBtc: Math.abs(s.strikePositionBtc), reduceOnly: true }, why, () => a.strike.placeOrder({ symbol: m.strike.markets[0], side, type: "market", size: Math.abs(s.strikePositionBtc), reduceOnly: true, slippage: m.strike.priceBandPct / 100, clientOrderId: `${agentId}-close-${now()}` }));
          return r.refused ? { refused: r.refused } : r.error ? { error: r.error } : r.result;
        },
      };
    },
    freeze: (agentId, reason, opts) => books.get(agentId)?.h?.freeze(reason, opts),
    resume: (agentId) => books.get(agentId)?.h?.resume(),
    /** The owner stops an agent: frozen by hand, quotes and Strike orders pulled, nothing new until a mandate is signed again. */
    async stop(agentId, reason = "stopped by the owner") {
      const a = agents.find((x) => x.agentId === agentId);
      if (!a) return null;
      a.stopped = true;
      books.get(agentId)?.h?.freeze(reason, { manual: true });
      const r = await this_.portFor(agentId).cancelAll();
      entry(a, { kind: "stopped", reason, ...r });
      await card(a, books.get(agentId));
      return r;
    },
    close: (agentId, why = "closed by the owner") => this_.portFor(agentId).closePosition(why),
    /** A mandate the owner signed anew: in force from the next round; a stop or a hand freeze ends with it. */
    setMandate(agentId, mandate) {
      const a = agents.find((x) => x.agentId === agentId);
      if (!a) return null;
      a.mandate = mandate;
      a.signatureOk = true;
      a.stopped = false;
      const h = books.get(agentId)?.h;
      if (h?.state.frozen && h.state.manual) h.resume();
      entry(a, { kind: "mandate.signed", hash: mandateHash(mandate), expiry: mandate.expiry });
      feed.agent(agentId, { mandate: mandateCard(mandate) });
      return mandateHash(mandate);
    },
    stateOf: (agentId) => { const h = books.get(agentId)?.h?.state; return { frozen: h?.frozen ?? false, frozenReason: h?.frozenReason ?? null }; },
  };
  return this_;
}

const round2 = (x) => Math.round(x * 100) / 100;
const mandateCard = (m) => ({ hash: mandateHash(m), maxNetDeltaUsd: m.risk.maxNetDeltaUsd, hedgeWithinSec: m.risk.hedgeWithinSec, maxQuoteUsd: m.midnight.maxQuoteUsd, maxPositionUsd: m.strike.maxPositionUsd, full: m });
