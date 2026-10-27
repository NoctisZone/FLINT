/**
 * Where a maker's proven swap half waits for its taker. `serverBoard` is
 * NIGHTGATE's offer board, reached through the agent's own server.
 * `gatewayBoard` keeps the rows in this process instead, for a network
 * where the offer board is not live: the half is handed to the taker here
 * and the swap settles on chain exactly as it would from the board. Both
 * answer rows in the board's shape, so the venue does not care which.
 */
import { randomUUID } from "node:crypto";

/** The offer board behind the trader's server tools. */
export function serverBoard(trader) {
  return {
    kind: "server",
    post: ({ offer, tags, expiresAt }) => trader.post({ offer, tags, expiresAt }),
    listOffers: (filter) => trader.listOffers(filter),
    myOffers: (filter) => trader.myOffers(filter),
    getOffer: (offerId) => trader.getOffer(offerId),
    retire: (offerId) => trader.retire(offerId),
  };
}

/**
 * The board inside the gateway, one for every agent of the process. A row
 * is `open` until it is filled, expired or retired; a taker claims it while
 * its half proves, so a second taker is refused.
 */
export function gatewayBoard({ now = Date.now } = {}) {
  const rows = new Map();
  const expire = () => { for (const r of rows.values()) if (r.status === "open" && r.expiresAt && Date.parse(r.expiresAt) <= now()) r.status = "expired"; };
  const row = (offerId) => {
    const r = rows.get(offerId);
    if (!r) throw new Error(`no offer ${offerId} on the gateway board`);
    return r;
  };
  const busy = (r) => { if (r.status !== "open") throw new Error(`offer ${r.offerId} is ${r.status}`); if (r.takenBy) throw new Error(`offer ${r.offerId} is being taken`); };
  return {
    kind: "gateway",
    async post({ offer, tags, expiresAt, gives, wants }) {
      const offerId = randomUUID();
      rows.set(offerId, { offerId, offer, tags, expiresAt, givesType: gives.type, givesAmount: String(gives.value), wantsType: wants.type, wantsAmount: String(wants.value), status: "open", takenBy: null, filledTxHash: null, postedAt: new Date(now()).toISOString() });
      return { offerId };
    },
    async listOffers({ givesType, wantsType } = {}) {
      expire();
      return [...rows.values()]
        .filter((r) => r.status === "open" && !r.takenBy && (!givesType || r.givesType === givesType) && (!wantsType || r.wantsType === wantsType))
        .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
        .map(({ takenBy, ...r }) => r);
    },
    async getOffer(offerId) { expire(); const { takenBy, ...r } = row(offerId); return r; },
    async retire(offerId) { const r = row(offerId); busy(r); r.status = "retired"; },
    /** The taker's claim before it proves; refused when the row is gone or claimed. */
    claim(offerId, takerId) { expire(); const r = row(offerId); busy(r); r.takenBy = takerId; },
    settled(offerId, txHash) { const r = row(offerId); r.status = "filled"; r.filledTxHash = txHash; r.takenBy = null; },
    release(offerId) { row(offerId).takenBy = null; },
    get size() { return rows.size; },
  };
}
