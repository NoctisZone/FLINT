/**
 * One agent's Midnight venue over its NIGHTGATE MCP server: quotes are swap
 * halves posted to a board, a fill is the quote's row turning `filled` with
 * the swap's txHash, retiring a quote frees its coins. The board is the
 * server's offer board or the one inside the gateway (`gateway/desk.mjs`);
 * the swap itself is the same.
 *
 * tBTC is counted in satoshi (1e-8), tUSD in cents; the gateway speaks BTC
 * and USD. A quote's price is USD per BTC.
 */

import { serverBoard } from "./desk.mjs";

export const SATS = 100_000_000;
export const CENTS = 100;
export const TAG = "flint";

const sats = (btc) => BigInt(Math.round(btc * SATS));
const cents = (usd) => BigInt(Math.round(usd * CENTS));
const btc = (s) => Number(s) / SATS;
const usd = (c) => Number(c) / CENTS;

/**
 * @param {object} o
 * @param {object} o.trader     a market/mcp-trader.mjs trader: makeOffer, post, retire, revert, takeOffer, submitSwap, getOffer, listOffers, holdings
 * @param {string} o.agentId
 * @param {{tBTC: string, tUSD: string}} o.types   raw token types on the factory
 * @param {object} [o.board]    serverBoard(trader) by default, or a gatewayBoard shared by the process's agents
 */
export function midnightVenue({ trader, agentId, types, board = serverBoard(trader), pair = "tBTC/tUSD", tag = TAG, now = Date.now, log = () => {} }) {
  const open = new Map(); // quoteId → quote
  // the server's board records the fill against the offer itself; the gateway's board is told here
  const onServer = board.kind === "server";

  /** A row of the board as a quote: side from the maker's view, size in BTC, price in USD per BTC. */
  function rowToQuote(r) {
    if (r.givesType === types.tBTC && r.wantsType === types.tUSD) return { quoteId: r.offerId, side: "ask", sizeBtc: btc(r.givesAmount), price: usd(r.wantsAmount) / btc(r.givesAmount), expiresAt: r.expiresAt ?? null, maker: tagsOf(r)[1] ?? null, offer: r.offer };
    if (r.givesType === types.tUSD && r.wantsType === types.tBTC) return { quoteId: r.offerId, side: "bid", sizeBtc: btc(r.wantsAmount), price: usd(r.givesAmount) / btc(r.wantsAmount), expiresAt: r.expiresAt ?? null, maker: tagsOf(r)[1] ?? null, offer: r.offer };
    return null;
  }

  return {
    pair,
    get openQuotes() { return [...open.values()].map(({ half, ...q }) => q); },

    /** Build and post one quote; its coins stay reserved until it fills, expires or is retired. */
    async quote({ side, sizeBtc, price, ttlSec }) {
      const give = side === "ask" ? { type: types.tBTC, value: sats(sizeBtc) } : { type: types.tUSD, value: cents(sizeBtc * price) };
      const want = side === "ask" ? { type: types.tUSD, value: cents(sizeBtc * price) } : { type: types.tBTC, value: sats(sizeBtc) };
      const made = await trader.makeOffer({ give, want });
      const expiresAt = new Date(now() + ttlSec * 1000).toISOString();
      let posted;
      try {
        posted = await board.post({ offer: made.text, tags: [tag, agentId, side], expiresAt, gives: give, wants: want });
      } catch (err) {
        await trader.revert(made.half).catch(() => {});
        throw err;
      }
      const q = { quoteId: posted.offerId, side, sizeBtc, price, expiresAt, half: made.half, at: now(), provingMs: made.provingMs };
      open.set(q.quoteId, q);
      log({ kind: "quote.posted", agent: agentId, quoteId: q.quoteId, side, sizeBtc, price, expiresAt, provingMs: made.provingMs });
      return { quoteId: q.quoteId, side, sizeBtc, price, expiresAt };
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

    /** The taker's side: mirror half against the board row, then the sponsor. */
    async take(q) {
      const expect = q.side === "ask"
        ? { gives: { [types.tBTC]: String(sats(q.sizeBtc)) }, wants: { [types.tUSD]: String(cents(q.sizeBtc * q.price)) } }
        : { gives: { [types.tUSD]: String(cents(q.sizeBtc * q.price)) }, wants: { [types.tBTC]: String(sats(q.sizeBtc)) } };
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
      log({ kind: "take", agent: agentId, quoteId: q.quoteId, side: q.side === "ask" ? "buy" : "sell", sizeBtc: q.sizeBtc, price: q.price, status: result.status, txHash: result.txHash, provingMs: taken.provingMs, sponsorMs: now() - t0 });
      return { ...result, landed };
    },

    /**
     * Read every open quote's row: a filled row is a fill of this agent
     * (an ask filled means it sold BTC), an expired or retired one leaves
     * the books. Returns the fills.
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
          fills.push({ id: q.quoteId, pair, side: q.side === "ask" ? "sell" : "buy", sizeBtc: q.sizeBtc, price: q.price, txHash, at: now() });
        } else {
          await trader.revert(q.half).catch(() => {});
          log({ kind: `quote.${status}`, agent: agentId, quoteId: q.quoteId });
        }
      }
      return fills;
    },

    /** Open quotes on the board for this pair, both sides, newest first. */
    async board() {
      const rows = [...await board.listOffers({ givesType: types.tBTC, wantsType: types.tUSD }), ...await board.listOffers({ givesType: types.tUSD, wantsType: types.tBTC })];
      return rows.map(rowToQuote).filter(Boolean);
    },

    /** What the wallet holds: BTC and USD as numbers, plus coins and what one half can give. */
    async holdings() {
      const h = await trader.holdings();
      const t = (type) => h.tokens.find((x) => x.tokenType === type) ?? { balance: 0n, coins: 0, spendable: 0n };
      const b = t(types.tBTC), u = t(types.tUSD);
      return { btc: btc(b.balance), usd: usd(u.balance), coins: { tBTC: b.coins, tUSD: u.coins }, spendable: { btc: btc(b.spendable), usd: usd(u.spendable) }, maxInputs: h.maxInputs };
    },

    rowToQuote,
    get boardKind() { return board.kind; },
  };
}

const tagsOf = (r) => { try { return typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags ?? []; } catch { return []; } };
