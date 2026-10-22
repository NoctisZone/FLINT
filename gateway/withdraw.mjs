/**
 * A payout to the owner: Strike pays only to the wallet it registered at
 * builder connect, the agent's own Cardano wallet; from there the ADA goes
 * on to the owner's address. One job (onboard-job.mjs) with the steps
 * quote, sign, confirm, settle, forward, written to data/withdrawals/.
 */
import { buildTransfer, signData, signTransaction } from "./cardano.mjs";

export const WITHDRAW_STEPS = ["quote", "sign", "confirm", "settle", "forward"];
/** What the agent's wallet keeps: Strike funds a withdrawal request from about 2 ADA plus the network fee. */
export const WALLET_KEEP_LOVELACE = 3_000_000n;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cents = (x) => Math.floor(Number(x) * 100) / 100;

/**
 * What a payout may take right now: the balance Strike lets go against its withdrawal limits (ADA per hour and
 * per day), in USD at Strike's ADA mark with a haircut for the rate the quote will use. `limitUsd` is null without limits.
 * @returns {{ adaUsd, availableUsd, limitUsd: number|null, nowUsd, hour, day, tightest, largeAboveAda, largeDelaySec, asOf }}
 */
export async function withdrawRoom({ strike, haircut = 0.98, now = Date.now }) {
  const [bal, lim, px] = await Promise.all([strike.balances(), strike.withdrawLimits({ chain: "cardano", asset: "ADA" }), strike.markPrice("ADA-USD")]);
  const b = bal[0] ?? {};
  const availableUsd = cents(b.maxWithdrawAmount ?? b.availableBalance ?? b.walletBalance ?? 0);
  const adaUsd = Number(px.p);
  const bucket = (k) => {
    const x = lim.buckets?.[k];
    return x ? { limitAda: Number(x.limit), usedAda: Number(x.used), remainingAda: Number(x.remaining), resetsAt: new Date((Number(x.window_start) + Number(x.window_seconds)) * 1000).toISOString() } : null;
  };
  const hour = bucket("per_asset_1h"), day = bucket("per_asset_24h");
  const windows = [hour, day, bucket("global_1h"), bucket("global_24h")].filter(Boolean);
  const tightest = windows.reduce((m, x) => (!m || x.remainingAda < m.remainingAda ? x : m), null);
  const limitUsd = tightest && adaUsd > 0 ? cents(Math.max(0, tightest.remainingAda) * adaUsd * haircut) : null;
  const large = lim.large_withdrawal ?? {};
  return {
    asset: "ADA", adaUsd, availableUsd, limitUsd, nowUsd: limitUsd === null ? availableUsd : Math.min(availableUsd, limitUsd),
    hour, day, tightest,
    largeAboveAda: large.threshold != null ? Number(large.threshold) : null, largeDelaySec: large.estimated_total_delay_seconds ?? large.queue_delay_seconds ?? null,
    asOf: new Date(now()).toISOString(),
  };
}

/**
 * @param {object} d
 * @param {string} d.agentId
 * @param {object} d.wallet          the agent's Cardano wallet (Strike's registered one)
 * @param {string} d.owner           where the ADA goes in the end
 * @param {object} d.strike          the agent's Strike client
 * @param {object} d.chain           Koios or ODATANO client
 * @param {number|"all"} d.usd       what to take off Strike, in USD; "all" = what Strike lets go
 * @param {bigint} [d.keepLovelace]  what stays on the agent's wallet for fees
 */
export function withdrawSteps({ agentId, wallet, owner, strike, chain, usd, keepLovelace = WALLET_KEEP_LOVELACE, settleMs = 2 * 3600_000, sleep = wait, now = Date.now, log = () => {} }) {
  const when = (iso) => { const min = Math.max(1, Math.round((Date.parse(iso) - now()) / 60_000)); return min < 90 ? `in about ${min} min` : `at ${iso.slice(11, 16)} UTC`; };
  return {
    /** The amount, capped at what Strike's withdrawal limits leave this hour and day; the owner reads why on the step. */
    async quote(ctx) {
      const room = await withdrawRoom({ strike, now });
      let amount = usd === "all" ? room.availableUsd : cents(usd);
      if (!(amount > 0)) throw new Error("nothing to withdraw: the available balance is 0");
      const w = room.tightest;
      if (room.limitUsd !== null && room.limitUsd <= 0) throw new Error(`Strike's withdrawal limit is used up: ${w.usedAda.toFixed(2)} of ${w.limitAda} ADA; the next payout can go ${when(w.resetsAt)}`);
      const capped = room.limitUsd !== null && amount > room.limitUsd ? amount : null;
      if (capped !== null) amount = room.limitUsd;
      const q = await strike.withdrawQuote({ blockchain: "cardano", mode: "balance", usd_value: String(amount), asset: "ADA" });
      if (!q.withdraw_id || !q.message_to_sign) throw new Error(`Strike's withdraw quote lacks withdraw_id or message_to_sign: ${JSON.stringify(q).slice(0, 200)}`);
      ctx.set("quote", { withdrawId: q.withdraw_id, fee: q.fee ?? null, txCbor: q.tx_cbor ?? null, message: q.message_to_sign, usd: amount });
      ctx.set("pub", { ...(ctx.data.pub ?? {}), usd: amount, askedUsd: usd, cappedFromUsd: capped, feeUsd: q.fee ?? null, limit: w ? { limitAda: w.limitAda, usedAda: w.usedAda, remainingAda: w.remainingAda, resetsAt: w.resetsAt, adaUsd: room.adaUsd } : null });
      ctx.set("before", String(await chain.balance(wallet.address)));
      const fee = `Strike fee ${q.fee ?? "?"} USD`;
      if (capped === null) return `${amount} USD quoted, ${fee}`;
      return `${amount} USD quoted of the ${capped} asked: Strike allows ${w.limitAda} ADA ${w.limitAda === room.hour?.limitAda && w.resetsAt === room.hour?.resetsAt ? "an hour" : "a day"} and ${w.remainingAda.toFixed(2)} were left; the rest can follow ${when(w.resetsAt)}. ${fee}`;
    },
    /** The registered wallet signs Strike's message (CIP-30 style) and, on Cardano, the transaction Strike built. */
    async sign(ctx) {
      const q = ctx.data.quote;
      // Strike hands the message as hex-encoded UTF-8 for signData; our wallet signs the same bytes
      const bytes = /^[0-9a-f]+$/i.test(q.message) && q.message.length % 2 === 0 ? Buffer.from(q.message, "hex") : Buffer.from(q.message, "utf8");
      const s = signData(wallet, bytes);
      ctx.set("signature", s.combined);
      if (q.txCbor) ctx.set("signedTx", signTransaction(q.txCbor, wallet).cborHex);
      return "signed by the agent's wallet";
    },
    async confirm(ctx) {
      if (ctx.data.requestId) return `requested: ${ctx.data.requestId}`;
      const q = ctx.data.quote;
      const r = await strike.withdrawConfirm({ withdraw_id: q.withdrawId, wallet_signature: ctx.data.signature, ...(ctx.data.signedTx ? { signed_tx_cbor: ctx.data.signedTx } : {}) });
      ctx.set("requestId", r.request_id ?? null);
      ctx.set("pub", { ...(ctx.data.pub ?? {}), requestId: r.request_id ?? null, strikeStatus: r.status ?? null });
      log({ kind: "withdraw.requested", agent: agentId, requestId: r.request_id ?? null, usd: q.usd, status: r.status ?? null });
      return `Strike accepted the request, status ${r.status ?? "pending"}`;
    },
    /** Strike's validators approve and pay out: the agent's wallet balance rises. */
    async settle(ctx) {
      const before = BigInt(ctx.data.before ?? 0);
      const t0 = now();
      for (;;) {
        let have = before;
        try { have = await chain.balance(wallet.address); } catch { /* asked again */ }
        if (have > before + 1_000_000n) { ctx.set("landed", String(have - before)); return `${(Number(have - before) / 1e6).toFixed(2)} tADA arrived on the agent's wallet`; }
        if (now() - t0 > settleMs) throw new Error("Strike has not paid out yet; retry waits again");
        ctx.note("waiting for Strike's validators to pay out");
        await sleep(30_000);
      }
    },
    /** Everything above what the wallet keeps for fees goes to the owner. */
    async forward(ctx) {
      const utxos = await chain.utxos(wallet.address);
      const have = utxos.reduce((s, u) => s + BigInt(u.value), 0n);
      const lovelace = have - keepLovelace - 200_000n;
      if (lovelace <= 1_000_000n) throw new Error(`only ${(Number(have) / 1e6).toFixed(2)} tADA on the wallet, nothing to forward`);
      const signed = buildTransfer({ wallet, utxos, to: owner, lovelace });
      const txHash = await chain.submit(signed.cborHex);
      ctx.set("pub", { ...(ctx.data.pub ?? {}), paidOut: String(lovelace), txHash });
      log({ kind: "withdraw.forwarded", agent: agentId, to: owner, lovelace: String(lovelace), txHash });
      return `${(Number(lovelace) / 1e6).toFixed(2)} tADA sent to your wallet, tx ${String(txHash).slice(0, 16)}…`;
    },
  };
}
