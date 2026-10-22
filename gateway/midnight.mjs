/**
 * One agent's Midnight venue over its NIGHTGATE MCP server: quotes are swap
 * halves posted to a board, a fill is the quote's row turning `filled` with
 * the swap's txHash, retiring a quote frees its coins. The board is the
 * server's offer board or the one inside the gateway (`gateway/desk.mjs`);
 * the swap itself is the same.
 *
 * A venue serves one or more pairs (tBTC/tUSD, tADA/tUSD, tSOL/tUSD). The
 * base token is counted in its smallest unit (satoshi, lovelace, lamports),
 * tUSD in cents; the gateway speaks base units and USD, and calls a size
 * `sizeBtc` whatever the base asset is. A quote's price is USD per unit.
 */

import { serverBoard } from "./desk.mjs";

export const SATS = 100_000_000;
export const CENTS = 100;
export const TAG = "flint";

const cents = (usd) => BigInt(Math.round(usd * CENTS));
const usd = (c) => Number(c) / CENTS;

/**
 * @param {object} o
 * @param {object} o.trader     a market/mcp-trader.mjs trader: makeOffer, post, retire, revert, takeOffer, submitSwap, getOffer, listOffers, holdings
 * @param {string} o.agentId
 * @param {{tBTC: string, tUSD: string}|{quote: string, bases: Record<string,{type: string, decimals: number}>}} o.types
 *   the raw token types: the old shape serves tBTC/tUSD alone, the new one lists every pair's base token
 * @param {string} [o.pair]     the pair this agent quotes on; the first of `types.bases` by default
 * @param {object} [o.board]    serverBoard(trader) by default, or a gatewayBoard shared by the process's agents
 */
export function midnightVenue({ trader, agentId, types, board = serverBoard(trader), pair, tag = TAG, now = Date.now, log = () => {} }) {
  const quoteType = types.quote ?? types.tUSD;
  const bases = types.bases ?? { "tBTC/tUSD": { type: types.tBTC, decimals: 8 } };
  pair ??= Object.keys(bases)[0];
  if (!bases[pair]) throw new Error(`${agentId}: no token types for the pair ${pair}`);
  const open = new Map(); // quoteId → quote
  // the server's board records the fill against the offer itself; the gateway's board is told here
  const onServer = board.kind === "server";
  const baseOf = (p) => { const b = bases[p]; if (!b) throw new Error(`no token types for the pair ${p}`); return b; };
  const unit = (p) => 10 ** baseOf(p).decimals;
  const atoms = (p, size) => BigInt(Math.round(size * unit(p)));
  const size = (p, a) => Number(a) / unit(p);
  const pairOfType = (type) => Object.keys(bases).find((p) => bases[p].type === type) ?? null;

  /** A row of the board as a quote: side from the maker's view, size in the base asset, price in USD per unit; null for a foreign pair. */
  function rowToQuote(r) {
    if (r.wantsType === quoteType && pairOfType(r.givesType)) { const p = pairOfType(r.givesType); return { quoteId: r.offerId, pair: p, side: "ask", sizeBtc: size(p, r.givesAmount), price: usd(r.wantsAmount) / size(p, r.givesAmount), expiresAt: r.expiresAt ?? null, maker: tagsOf(r)[1] ?? null, offer: r.offer }; }
    if (r.givesType === quoteType && pairOfType(r.wantsType)) { const p = pairOfType(r.wantsType); return { quoteId: r.offerId, pair: p, side: "bid", sizeBtc: size(p, r.wantsAmount), price: usd(r.givesAmount) / size(p, r.wantsAmount), expiresAt: r.expiresAt ?? null, maker: tagsOf(r)[1] ?? null, offer: r.offer }; }
    return null;
  }
  const legs = (p, side, sizeBtc, price) => {
    const base = { type: baseOf(p).type, value: atoms(p, sizeBtc) };
    const quote = { type: quoteType, value: cents(sizeBtc * price) };
    return side === "ask" ? { give: base, want: quote } : { give: quote, want: base };
  };

  return {
    pair,
    pairs: Object.keys(bases),
    get openQuotes() { return [...open.values()].map(({ half, ...q }) => q); },

    /** Build and post one quote, on the agent's pair unless `pair` names another it serves; its coins stay reserved until it fills, expires or is retired. */
    async quote({ side, sizeBtc, price, ttlSec, pair: onPair = pair }) {
      const { give, want } = legs(onPair, side, sizeBtc, price);
      const made = await trader.makeOffer({ give, want });
      const expiresAt = new Date(now() + ttlSec * 1000).toISOString();
      let posted;
      try {
        posted = await board.post({ offer: made.text, tags: [tag, agentId, side], expiresAt, gives: give, wants: want });
      } catch (err) {
        await trader.revert(made.half).catch(() => {});
        throw err;
      }
      const q = { quoteId: posted.offerId, pair: onPair, side, sizeBtc, price, expiresAt, half: made.half, at: now(), provingMs: made.provingMs };
      open.set(q.quoteId, q);
      log({ kind: "quote.posted", agent: agentId, quoteId: q.quoteId, pair: onPair, side, sizeBtc, price, expiresAt, provingMs: made.provingMs });
      return { quoteId: q.quoteId, pair: onPair, side, sizeBtc, price, expiresAt };
    },

    /** Take a quote off the board and hand the swap to the sponsor; resolves when it lands or fails. */
    async retire(quoteId) {
      const q = open.get(quoteId);
      if (!q) return false;
      open.delete(quoteId);
      await board.retire(quoteId).catch((err) => { if (!/expired|filled|taken/i.test(err.message)) throw err; });
      await trader.revert(q.half).catch(() => {});
      log({ kind: "quote.retired", agent: agentId, quoteId });
      return true;
    },

    async retireAll() {
      for (const id of [...open.keys()]) await this.retire(id);
    },

    /** The taker's side: mirror half against the board row, then the sponsor. The quote's own pair decides the tokens. */
    async take(q) {
      const p = q.pair ?? pair;
      const { give, want } = legs(p, q.side, q.sizeBtc, q.price);
      const expect = { gives: { [give.type]: String(give.value) }, wants: { [want.type]: String(want.value) } };
      if (!onServer) board.claim(q.quoteId, agentId);
      const ref = onServer ? { offerId: q.quoteId } : {};
      const t0 = now();
      let taken, result;
      try {
        taken = await trader.takeOffer({ text: q.offer, ...ref, expect });
        try {
          result = await trader.submitSwap({ ...ref, takerHalf: taken.takerHalf });
        } catch (err) {
          await trader.revert(taken.takerHalf).catch(() => {});
          throw err;
        }
      } catch (err) {
        if (!onServer) board.release(q.quoteId);
        throw err;
      }
      const landed = result.status === "succeeded" || (result.status === "reconciliation_required" && !!result.txHash);
      if (!landed) await trader.revert(taken.takerHalf).catch(() => {});
      if (!onServer) { if (landed) board.settled(q.quoteId, result.txHash); else board.release(q.quoteId); }
      log({ kind: "take", agent: agentId, quoteId: q.quoteId, pair: p, side: q.side === "ask" ? "buy" : "sell", sizeBtc: q.sizeBtc, price: q.price, status: result.status, txHash: result.txHash, provingMs: taken.provingMs, sponsorMs: now() - t0 });
      return { ...result, landed };
    },

    /**
     * Read every open quote's row: a filled row is a fill of this agent
     * (an ask filled means it sold the base asset), an expired or retired
     * one leaves the books. Returns the fills.
     */
    async pollFills() {
      const fills = [];
      for (const q of [...open.values()]) {
        let row;
        try { row = await board.getOffer(q.quoteId); } catch (err) { log({ kind: "poll.error", agent: agentId, quoteId: q.quoteId, error: err.message }); continue; }
        const status = row?.status ?? row?.value?.status;
        if (!status || status === "open") continue;
        open.delete(q.quoteId);
        if (status === "filled") {
          const txHash = row.filledTxHash ?? row.value?.filledTxHash ?? null;
          fills.push({ id: q.quoteId, pair: q.pair ?? pair, side: q.side === "ask" ? "sell" : "buy", sizeBtc: q.sizeBtc, price: q.price, txHash, at: now() });
        } else {
          await trader.revert(q.half).catch(() => {});
          log({ kind: `quote.${status}`, agent: agentId, quoteId: q.quoteId });
        }
      }
      return fills;
    },

    /** Open quotes on the board, both sides, newest first: the agent's pair, or every pair the venue serves with `all`. */
    async board({ all = false } = {}) {
      const ps = all ? Object.keys(bases) : [pair];
      const rows = [];
      for (const p of ps) rows.push(...await board.listOffers({ givesType: baseOf(p).type, wantsType: quoteType }), ...await board.listOffers({ givesType: quoteType, wantsType: baseOf(p).type }));
      return rows.map(rowToQuote).filter(Boolean);
    },

    /**
     * What the wallet holds: the base asset of `forPair` (the agent's pair by
     * default) and USD as numbers, coins and what one half can give; `bases`
     * says the same for every pair the venue serves.
     */
    async holdings(forPair = pair) {
      const h = await trader.holdings();
      const t = (type) => h.tokens.find((x) => x.tokenType === type) ?? { balance: 0n, coins: 0, spendable: 0n };
      const u = t(quoteType);
      const all = Object.fromEntries(Object.keys(bases).map((p) => { const b = t(baseOf(p).type); return [p, { btc: size(p, b.balance), coins: b.coins, spendable: size(p, b.spendable) }]; }));
      const mine = all[forPair] ?? { btc: 0, coins: 0, spendable: 0 };
      return { btc: mine.btc, usd: usd(u.balance), coins: { tBTC: mine.coins, tUSD: u.coins }, spendable: { btc: mine.spendable, usd: usd(u.spendable) }, maxInputs: h.maxInputs, bases: all };
    },

    rowToQuote,
    get boardKind() { return board.kind; },
  };
}

const tagsOf = (r) => { try { return typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags ?? []; } catch { return []; } };
