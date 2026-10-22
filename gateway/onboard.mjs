/**
 * An agent's way onto Strike, as functions: its Cardano wallet from the
 * master seed, builder connect saved to the accounts file, the deposit, the
 * wait for the credit; and the steps of an order from the page, where the
 * owner pays the fee and the deposit from their own wallet. cli/onboard.mjs
 * does the pieces by hand for the project's own agents.
 *
 * Chain-free through `chain` (the Koios or ODATANO client) and the Strike
 * client; the tests hand in stand-ins.
 */
import fs from "node:fs";
import path from "node:path";
import { secretFor } from "../lib/identity.mjs";
import { buildTransfer, buildUnsignedTransfer, cardanoWallet, cborDecode, decodeUtxoHex, signTransaction, txHashOf, withWitnesses } from "./cardano.mjs";
import { builderConnect, depositAda } from "./strike-connect.mjs";
import { MARKETS } from "./markets.mjs";

export const ACCOUNTS_FILE = path.join("data", "strike-accounts.json");
const hex = (u8) => Buffer.from(u8).toString("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** An agent's Cardano wallet: a base address (payment plus stake key), the form wallet apps give Strike. */
export const agentWallet = (master, agentId) => cardanoWallet(hex(secretFor(master, "cardano", agentId)), { stakeSeedHex: hex(secretFor(master, "cardano-stake", agentId)) });
/** The treasury wallet that funds the agents: an enterprise address. */
export const treasuryWallet = (master) => cardanoWallet(hex(secretFor(master, "cardano", "treasury")));

/** The Strike accounts and API wallet keys the agents made for themselves (key material, mode 600). */
export function accountsFile(file = ACCOUNTS_FILE) {
  return {
    read: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}),
    save(accounts) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(accounts, null, 1), { mode: 0o600 }); },
  };
}

/**
 * Builder connect for one agent: a fresh API wallet seeded from the master
 * seed and the time, the account Strike makes or finds, saved under the
 * agent's id. An earlier account of the same agent goes to `previous`.
 */
export async function connectStrike({ agentId, wallet, master, accounts, baseUrl, code, feeShareBps = 10, fetch = globalThis.fetch, now = Date.now }) {
  if (!code) throw new Error("STRIKE_BUILDER_CODE is not set");
  const r = await builderConnect({ baseUrl, code, feeShareBps, wallet, apiWalletSeedHex: hex(secretFor(master, "strike-api", agentId, String(now()))), fetch });
  const all = accounts.read();
  if (all[agentId]) (all.previous ??= []).push({ agentId, ...all[agentId] });
  all[agentId] = { accountId: r.accountId, apiWalletPrivateKeyHex: r.apiWalletPrivateKeyHex, apiWalletPublicKeyHex: r.apiWalletPublicKeyHex, address: r.address, builderCode: r.builderCode, feeShareBps: r.feeShareBps, connectedAt: new Date(now()).toISOString() };
  accounts.save(all);
  return all[agentId];
}

/**
 * tADA from the treasury to an address, then wait until the indexer shows
 * the transaction: the next transfer must not spend the same inputs.
 */
export async function fundFromTreasury({ chain, treasury, to, lovelace, tries = 40, everyMs = 10_000, sleep = wait, log = () => {} }) {
  let signed;
  if (chain.kind === "odatano") signed = signTransaction((await chain.buildTransfer({ from: treasury.address, to, lovelace })).unsignedTxCbor, treasury);
  else signed = buildTransfer({ wallet: treasury, utxos: await chain.utxos(treasury.address), to, lovelace });
  const txHash = await chain.submit(signed.cborHex);
  log({ kind: "fund.submitted", to, lovelace: String(lovelace), txHash });
  for (let i = 0; i < tries; i++) {
    if ((await chain.txInfo([txHash])).length) { log({ kind: "fund.landed", txHash }); return { txHash, landed: true }; }
    await sleep(everyMs);
  }
  return { txHash, landed: false };
}

/** The agent's ADA into its Strike account through Strike's quote, build-tx, our signature and the submit. */
export const depositToStrike = ({ strike, wallet, chain, lovelace, log }) => depositAda({ strike, wallet, koios: chain, lovelace, log });

/** Poll the account until Strike has credited at least `minUsd`; the balance, or null when the time ran out. */
export async function waitForCredit({ strike, minUsd = 1, timeoutMs = 600_000, everyMs = 15_000, sleep = wait, now = Date.now }) {
  const t0 = now();
  for (;;) {
    let bal = 0;
    try { bal = Number((await strike.balances())[0]?.walletBalance ?? 0); } catch { /* Strike's testnet answers 503 now and then */ }
    if (bal >= minUsd) return bal;
    if (now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

/** A sponsored call again after "Retry after N s", a few times. */
export async function sponsoredRetry(fn, { tries = 4, sleep = wait } = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      const m = /Retry after (\d+)\s*s/i.exec(err.message ?? "");
      if (!m || i >= tries) throw err;
      await sleep((Number(m[1]) + 2) * 1000);
    }
  }
}

/** Poll an address until it holds at least `minLovelace`; the balance, or null when the time ran out. */
export async function waitForBalance({ chain, address, minLovelace, timeoutMs = 45 * 60_000, everyMs = 20_000, sleep = wait, now = Date.now }) {
  const t0 = now();
  for (;;) {
    let have = 0n;
    try { have = await chain.balance(address); } catch { /* a chain read that fails is asked again */ }
    if (have >= BigInt(minLovelace)) return have;
    if (now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

/** A call again after a 5xx from Strike or ODATANO, a few times with a pause; any other error is final. */
export async function serverRetry(fn, { tries = 6, waitMs = 30_000, sleep = wait, onRetry = () => {} } = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      const m = /(?:Strike|ODATANO) (5\d\d)/.exec(err.message ?? "");
      if (!m || i >= tries) throw err;
      onRetry(err.message.slice(0, 120));
      await sleep(waitMs);
    }
  }
}

/** Quote-sized coins for a maker: `usd` of each token, in satoshi and cents, with headroom for the mark to move. */
export function coinSizes({ quoteUsd, mark, headroom = 1.05, decimals = 8 }) {
  const usd = quoteUsd * headroom;
  return { sats: Math.ceil((usd / mark) * 10 ** decimals), cents: Math.round(usd * 100), usd: Math.round(usd * 100) / 100 };
}

/** The steps of an order, in their order: what the page and the job agree on. */
export const ORDER_STEPS = ["wallet", "pay", "account", "deposit", "mint", "credit", "open", "register", "quote"];
/** What the agent's wallet keeps on top of the deposit: Strike's intake margin, the deposit's fee, a change output. */
export const DEPOSIT_MARGIN = 5_000_000n;

/**
 * The steps of an order for a new agent, over the pieces the gateway hands
 * in. The owner pays once from their own wallet: one transaction with the
 * set-up fee to the project address and the deposit to the agent's own
 * Cardano wallet, signed in their wallet and handed in through the owner
 * API (the `pay` step waits for it). The agent's wallet then makes the
 * Strike deposit itself: Strike builds deposits only for the wallet it
 * registered at builder connect. Every step can run again after a failure:
 * it looks at what is there before it acts.
 *
 * @param {object} d
 * @param {string} d.agentId
 * @param {number} d.index                       Midnight wallet index
 * @param {object} d.mandate
 * @param {object} d.wallet                      the agent's Cardano wallet
 * @param {string} d.owner                       the owner's Cardano address
 * @param {{ lovelace: bigint|string, to: string, paid?: object|null }} d.fee   the set-up fee; `paid` is the x402 receipt when it came that way
 * @param {bigint|string} d.depositLovelace      the Strike deposit the owner ordered
 * @param {(spec: string, amount: number|bigint, index: number) => Promise<{status, error?}>} d.mint
 * @param {object} [d.market]                   the agent's market (markets.mjs): its base token and decimals for the mints
 * @param {object[]} [d.markets]                every market the agent trades, `[market]` by default; each may carry its own `minNotionalUsd`
 * @param {() => Promise<Record<string,{mark:number}>>} [d.marks]   every market's mark at once; `mark` alone serves one market
 * @param {() => Promise<number>} d.mark
 * @param {number} [d.minQuoteUsd]               Strike's minimum hedge notional
 * @param {number} [d.coins]                     coins of each token
 * @param {object} d.strike                      { baseUrl, code, feeShareBps, accounts, chain, clientOf(privateKeyHex), master }
 * @param {() => Promise<object>} d.open         the agent's MCP server, wallet synced
 * @param {(trader, ctx) => Promise<void>} d.register  the agent into the loop and the registry; `ctx.set` keeps what the owner reads once (its tools key)
 * @param {() => boolean} d.quoted               true once the agent has an offer out
 * @param {number} [d.waitMs]                    how long the pay step waits for the owner's transaction
 */
export function onboardSteps({ agentId, index, mandate, wallet, owner, fee, depositLovelace, mint, market = MARKETS["BTC-USD"], markets = [market], mark, marks, minQuoteUsd = 0, coins = 4, strike, open, register, quoted, waitMs = 45 * 60_000, sleep = wait, now = Date.now, log = () => {} }) {
  const ada = (lovelace) => `${(Number(lovelace) / 1e6).toFixed(0)} tADA`;
  const toAgent = BigInt(depositLovelace) + DEPOSIT_MARGIN;
  return {
    async wallet(ctx) {
      ctx.set("cardano", wallet.address);
      ctx.set("pub", { ...(ctx.data.pub ?? {}), feeLovelace: String(fee.lovelace), feeTo: fee.to, depositLovelace: String(depositLovelace), toAgentLovelace: String(toAgent), owner, paidByX402: Boolean(fee.paid) });
      return `Cardano wallet ${wallet.address.slice(0, 16)}…, Midnight wallet ${index}`;
    },
    /** The owner's one transaction: the fee (unless x402 paid it) and the deposit money, waited for, then seen on chain. */
    async pay(ctx) {
      await ownerTransaction(ctx, { chain: strike.chain, wallet, minLovelace: depositLovelace, waitMs, sleep, asking: `waiting for your payment of ${ada((fee.paid ? 0n : BigInt(fee.lovelace)) + toAgent)}, signed in your wallet` });
      return `${fee.paid ? "deposit money" : `fee ${ada(fee.lovelace)} and deposit money`} paid, tx ${ctx.data.payTx.slice(0, 16)}…`;
    },
    async account(ctx) {
      let account = strike.accounts.read()[agentId];
      if (!account) {
        account = await connectStrike({ agentId, wallet, master: strike.master, accounts: strike.accounts, baseUrl: strike.baseUrl, code: strike.code, feeShareBps: strike.feeShareBps, now });
        log({ kind: "onboard.strike.connected", agent: agentId, accountId: account.accountId });
      }
      ctx.set("strikeAccountId", account.accountId);
      return `Strike account ${account.accountId}, builder fee ${strike.feeShareBps} bps`;
    },
    /** The agent's wallet deposits at Strike: quote, Strike's transaction over its UTxOs, its signature, the submit. */
    async deposit(ctx) {
      const client = strike.clientOf(strike.accounts.read()[agentId].apiWalletPrivateKeyHex);
      await client.syncClock();
      const credited = Number((await client.balances())[0]?.walletBalance ?? 0);
      if (credited > 0) return `already credited: ${credited.toFixed(2)} USD`;
      if (!ctx.data.depositTx) {
        ctx.note(`depositing ${ada(depositLovelace)} at Strike from the agent's wallet`);
        // Strike builds the deposit over the wallet's UTxOs and answers 500 until its own chain view has the fresh one
        const d = await serverRetry(() => depositToStrike({ strike: client, wallet, chain: strike.chain, lovelace: BigInt(depositLovelace), log: (e) => log({ agent: agentId, ...e }) }), { sleep, onRetry: (why) => ctx.note(`Strike could not build the deposit yet (${why}); trying again`) });
        ctx.set("depositTx", d.txHash);
        ctx.set("depositUsd", d.usd);
      }
      return `deposit ${ada(depositLovelace)} submitted, tx ${ctx.data.depositTx.slice(0, 16)}…`;
    },
    async mint(ctx) {
      // per market: coins of its base token and of tUSD, each big enough for one quote at that market's mark
      const ms = marks ? await marks() : { [market.symbol]: { mark: await mark() } };
      const plan = [];
      const says = [];
      for (const mk of markets) {
        const m = ms[mk.symbol]?.mark;
        if (!m) throw new Error(`no mark for ${mk.symbol}; retry later`);
        const size = coinSizes({ quoteUsd: Math.max(mandate.midnight.maxQuoteUsd, mk.minNotionalUsd ?? minQuoteUsd), mark: m, decimals: mk.decimals });
        plan.push(...Array(coins).fill([mk.token, size.sats]), ...Array(coins).fill(["market:tUSD", size.cents]));
        says.push(`${coins} coins of ${(size.sats / 10 ** mk.decimals).toFixed(Math.min(5, mk.decimals)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")} ${mk.token.split(":")[1]} and ${coins} of ${size.usd} tUSD`);
      }
      let done = ctx.data.mints ?? 0;
      for (const [spec, amount] of plan.slice(done)) {
        ctx.note(`${done} of ${plan.length} coins minted`);
        const e = await sponsoredRetry(() => mint(spec, amount, index), { sleep });
        if (e.status !== "succeeded") throw new Error(`mint of ${amount} ${spec} ${e.status}${e.error ? `: ${e.error}` : ""}`);
        ctx.set("mints", ++done);
        log({ kind: "onboard.mint", agent: agentId, token: spec, amount: String(amount), txHash: e.txHash ?? null });
      }
      return says.join("; ");
    },
    async credit(ctx) {
      const client = strike.clientOf(strike.accounts.read()[agentId].apiWalletPrivateKeyHex);
      await client.syncClock();
      ctx.note("waiting for Strike to credit the deposit");
      const bal = await waitForCredit({ strike: client, sleep, now });
      if (bal === null) throw new Error(`deposit ${ctx.data.depositTx} not credited by Strike yet; retry waits again`);
      return `${bal.toFixed(2)} USD credited on Strike`;
    },
    async open(ctx) {
      if (!ctx.trader) ctx.trader = await open();
      return "Midnight wallet synced, its server up";
    },
    async register(ctx) {
      if (!ctx.trader) ctx.trader = await open();
      await register(ctx.trader, ctx);
      return "in the loop with the other agents";
    },
    async quote(ctx) {
      const t0 = now();
      while (!quoted()) {
        if (now() - t0 > 600_000) throw new Error("no offer on the board after ten minutes");
        ctx.note("waiting for its first offer");
        await sleep(5_000);
      }
      return "first offer on the board";
    },
  };
}

/** A transaction the owner signs, delivered to the job as "pay", then seen on chain and on the agent's wallet. */
async function ownerTransaction(ctx, { chain, wallet, minLovelace, waitMs, sleep, asking }) {
  if (!ctx.data.payTx) {
    ctx.note(asking);
    const got = await ctx.waitFor("pay", waitMs);
    if (!got) throw new Error("your payment was not signed in time; sign it and retry");
    ctx.set("payTx", got.txHash);
  }
  ctx.note("payment sent, waiting for the chain");
  for (let i = 0; i < 40; i++) { if ((await chain.txInfo([ctx.data.payTx])).length) break; if (i === 39) throw new Error(`payment ${ctx.data.payTx} not seen on chain in time; retry waits again`); await sleep(10_000); }
  // the wallet's view of the chain may lag the indexer by a moment
  for (let i = 0; i < 12 && (await chain.balance(wallet.address)) < BigInt(minLovelace); i++) await sleep(10_000);
  return ctx.data.payTx;
}

/** The steps of a further deposit into a running agent. */
export const TOPUP_STEPS = ["pay", "deposit", "credit"];

/**
 * A further deposit into a running agent: the owner's transfer to the agent's wallet (signed and handed in as for
 * an order), the agent's deposit at Strike, the wait for the credit. Every step can run again.
 *
 * @param {object} d
 * @param {string} d.agentId
 * @param {object} d.wallet                      the agent's Cardano wallet
 * @param {string} d.owner                       the owner's Cardano address
 * @param {bigint|string} d.lovelace             the deposit
 * @param {object} d.strike                      the agent's own Strike client
 * @param {object} d.chain                       Koios or ODATANO client
 */
export function topUpSteps({ agentId, wallet, owner, lovelace, strike, chain, waitMs = 45 * 60_000, sleep = wait, now = Date.now, log = () => {} }) {
  const ada = (x) => `${(Number(x) / 1e6).toFixed(0)} tADA`;
  const toAgent = BigInt(lovelace) + DEPOSIT_MARGIN;
  return {
    async pay(ctx) {
      ctx.set("cardano", wallet.address);
      ctx.set("pub", { ...(ctx.data.pub ?? {}), feeLovelace: "0", feeTo: null, depositLovelace: String(lovelace), toAgentLovelace: String(toAgent), owner, paidByX402: false });
      await ownerTransaction(ctx, { chain, wallet, minLovelace: lovelace, waitMs, sleep, asking: `waiting for your transfer of ${ada(toAgent)}, signed in your wallet` });
      return `${ada(toAgent)} on the agent's wallet, tx ${ctx.data.payTx.slice(0, 16)}…`;
    },
    /** The agent's wallet deposits at Strike; the balance before is kept so the credit step knows what to wait for. */
    async deposit(ctx) {
      await strike.syncClock();
      if (ctx.data.before === undefined) ctx.set("before", String(Number((await strike.balances())[0]?.walletBalance ?? 0)));
      if (!ctx.data.depositTx) {
        ctx.note(`depositing ${ada(lovelace)} at Strike from the agent's wallet`);
        const d = await serverRetry(() => depositToStrike({ strike, wallet, chain, lovelace: BigInt(lovelace), log: (e) => log({ agent: agentId, ...e }) }), { sleep, onRetry: (why) => ctx.note(`Strike could not build the deposit yet (${why}); trying again`) });
        ctx.set("depositTx", d.txHash);
        ctx.set("depositUsd", d.usd);
        ctx.set("pub", { ...(ctx.data.pub ?? {}), depositTx: d.txHash, depositUsd: d.usd });
      }
      return `deposit ${ada(lovelace)} submitted, tx ${ctx.data.depositTx.slice(0, 16)}…`;
    },
    async credit(ctx) {
      await strike.syncClock();
      const before = Number(ctx.data.before ?? 0);
      const want = before + Math.max(1, Number(ctx.data.depositUsd ?? 0) * 0.9);
      ctx.note("waiting for Strike to credit the deposit");
      const bal = await waitForCredit({ strike, minUsd: want, sleep, now });
      if (bal === null) throw new Error(`deposit ${ctx.data.depositTx} not credited by Strike yet; retry waits again`);
      ctx.set("pub", { ...(ctx.data.pub ?? {}), creditedUsd: Math.round((bal - before) * 100) / 100 });
      return `${(bal - before).toFixed(2)} USD credited on Strike, ${bal.toFixed(2)} USD now`;
    },
  };
}

/**
 * The owner's one payment of an order, built for their wallet and handed
 * back signed: a transfer with the set-up fee to the project address and
 * the deposit money to the agent's wallet. It comes back as a CIP-30
 * witness set (the page) or as a whole signed transaction (a headless
 * wallet); submitted here, then delivered to the waiting job step. A
 * further deposit is paid the same way, with no fee output.
 *
 * @param {object} o
 * @param {(agentId) => object|null} o.jobOf       the running job (deliver, job.data): an order, or a deposit
 * @param {object} o.chain                          Koios or ODATANO client
 */
export function orderPayments({ jobOf, chain, log = () => {} }) {
  const need = (agentId) => { const j = jobOf(agentId); if (!j) throw Object.assign(new Error("nothing to pay under that name"), { status: 404 }); return j; };
  const utxosOf = async (owner, given) => {
    if (given?.length) return given.map(decodeUtxoHex).filter((u) => !u.assets && u.address === owner);
    return chain.utxos(owner);
  };
  const signed = (body) => {
    if (body?.signedTxCbor) { const tx = cborDecode(Buffer.from(String(body.signedTxCbor), "hex")); return { cborHex: String(body.signedTxCbor), txHash: txHashOf(tx.items[0].raw) }; }
    if (body?.witnessSetHex && body?.unsignedTxCbor) return withWitnesses(String(body.unsignedTxCbor), String(body.witnessSetHex));
    throw Object.assign(new Error("send signedTxCbor, or unsignedTxCbor with witnessSetHex"), { status: 400 });
  };
  return {
    /** The payment, unsigned, over the owner's UTxOs (CIP-30 hex when the page sends them, else the chain's). */
    async build(agentId, { utxos } = {}) {
      const j = need(agentId);
      const { pub, cardano } = j.job.data;
      if (!pub?.toAgentLovelace) throw Object.assign(new Error("nothing to pay yet"), { status: 409 });
      const outputs = [...(pub.paidByX402 || BigInt(pub.feeLovelace) === 0n ? [] : [{ to: pub.feeTo, lovelace: BigInt(pub.feeLovelace) }]), { to: cardano, lovelace: BigInt(pub.toAgentLovelace) }];
      const list = await utxosOf(pub.owner, utxos);
      if (!list.length) throw Object.assign(new Error("no ADA-only UTxOs on the owner's address"), { status: 400 });
      const t = buildUnsignedTransfer({ from: pub.owner, utxos: list, outputs });
      return { unsignedTxCbor: t.cborHex, txHash: t.txHash, outputs: outputs.map((o) => ({ to: o.to, lovelace: String(o.lovelace) })), total: String(outputs.reduce((s, o) => s + o.lovelace, 0n)) };
    },
    async submit(agentId, body) {
      const j = need(agentId);
      const tx = signed(body);
      const submitted = await chain.submit(tx.cborHex);
      const txHash = /^[0-9a-f]{64}$/.test(submitted) ? submitted : tx.txHash;
      log({ kind: j.job.kind === "deposit" ? "deposit.paid" : "order.paid", agent: agentId, txHash });
      j.deliver("pay", { txHash });
      return { txHash };
    },
  };
}
