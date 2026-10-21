/**
 * A trader's hands: its own NIGHTGATE MCP server (@odatano/nightgate-mcp) as
 * a child process over stdio, with the trader's seed, its key and its wallet
 * state file. Everything a trader does on the market goes through the
 * server's tools, the ones any outside agent has: get_swap_wallet,
 * build_swap_offer, post_swap_offer, list_swap_offers, get_swap_offer,
 * take_swap_offer, sponsor_swap, retire_swap_offer, revert_swap_offer,
 * get_job_status.
 *
 * `mcpTrader` maps the market's shapes onto the tools and runs on any
 * `call(tool, args)`; `openMcpTrader` starts the process and waits for the
 * wallet's first sync.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { badRequest } from "../lib/errors.mjs";

// a half proven without a proof server takes minutes
const CALL_TIMEOUT_MS = 15 * 60_000;
const SYNC_TIMEOUT_MS = 20 * 60_000;

/** Where the traders' servers keep their wallet state; the state holds the wallet's coins, like a key. */
export const WALLET_DIR = path.join("data", "wallets");
export const stateFileOf = (name) => path.resolve(WALLET_DIR, `${name}.state`);

/**
 * The environment of one trader's server. The seed and the key go nowhere
 * else. Network and the input cap are the server's defaults (preprod, 4 coins
 * a half); indexer and node are the market's. With several proof servers
 * the wallet at `index` takes the one its index points to, so the proving
 * spreads over them.
 */
export function traderEnv({ seedHex, key, cfg, stateFile, index = 0 }) {
  const servers = cfg.proofServerUrls?.length ? cfg.proofServerUrls : [cfg.proofServerUrl];
  return {
    ODATANO_ACCESS_URL: cfg.nightgateUrl,
    ODATANO_ACCESS_KEY: key,
    NIGHTGATE_SEED_HEX: seedHex,
    NIGHTGATE_SWAP_STATE_FILE: stateFile,
    NIGHTGATE_PROOF_SERVER_URL: servers[index % servers.length],
    NIGHTGATE_INDEXER_HTTP_URL: cfg.indexerHttpUrl,
    NIGHTGATE_INDEXER_WS_URL: cfg.indexerWsUrl,
    NIGHTGATE_NODE_URL: cfg.nodeUrl,
  };
}

const leg = ({ type, value }) => ({ tokenType: type, amount: String(value) });
const legOf = (side, what) => {
  const entries = Object.entries(side ?? {});
  if (entries.length !== 1) throw badRequest(`${what} names one token type, not ${entries.length}`);
  return { tokenType: entries[0][0], amount: String(entries[0][1]) };
};
const rowsOf = (answer) => (Array.isArray(answer) ? answer : answer?.value ?? []);

/**
 * The market's view of one trader over the MCP tools.
 * @param {object} o
 * @param {(tool: string, args?: object) => Promise<any>} o.call   answers the tool's JSON, throws its error
 */
export function mcpTrader({ name, call, close = async () => {}, pollMs = 5_000, jobTimeoutMs = 600_000 }) {
  const wallet = async () => {
    const w = await call("get_swap_wallet");
    if (!w.synced) throw new Error(`${name}'s wallet is still syncing (${w.syncingSeconds ?? "?"} s)`);
    return w;
  };

  /** Poll until the job leaves the queue; a failing poll is not a verdict. */
  async function waitForJob(jobId, sessionId) {
    const t0 = Date.now();
    let job = null;
    for (;;) {
      try {
        job = await call("get_job_status", { jobId, sessionId });
        if (["succeeded", "failed"].includes(job.status)) return job;
        if (job.status === "reconciliation_required" && job.txHash) return job;
      } catch (err) {
        if (err.status && err.status < 500 && err.status !== 429) throw err;
      }
      if (Date.now() - t0 > jobTimeoutMs) return job;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  const revert = (half) => call("revert_swap_offer", { id: half.id });

  return {
    name,

    /** Shielded balance per raw token type, in atoms. */
    async balances() {
      return Object.fromEntries((await wallet()).tokens.map((t) => [t.tokenType, BigInt(t.balance)]));
    },

    /** What the wallet holds per token type: balance, coins, what one half can give; and the input cap. */
    async holdings() {
      const w = await wallet();
      return { maxInputs: w.maxInputs, tokens: w.tokens.map((t) => ({ tokenType: t.tokenType, balance: BigInt(t.balance), coins: t.coins, spendable: BigInt(t.spendable) })) };
    },

    /** The most one half can give of a token type. */
    async spendable(type) {
      return BigInt((await wallet()).tokens.find((t) => t.tokenType === type)?.spendable ?? 0);
    },

    /** The maker's half; its coins stay reserved until the swap lands or `revert(half)`. */
    async makeOffer({ give, want, bind = true }) {
      const t0 = Date.now();
      const built = await call("build_swap_offer", { give: leg(give), want: leg(want), bind });
      return { text: built.offer ?? built.halfB64, half: { id: built.id }, provingMs: Date.now() - t0 };
    },

    /** The mirror half of an offer, after the server compared its terms with `expect`; with `offerId` the board entry is checked first. */
    async takeOffer({ text, expect, offerId }) {
      const t0 = Date.now();
      const taken = await call("take_swap_offer", {
        offer: text,
        ...(offerId ? { offerId } : {}),
        ...(expect ? { expect: { gives: legOf(expect.gives, "the agreed gives"), wants: legOf(expect.wants, "the agreed wants") } } : {}),
      });
      return { makerHalfB64: taken.makerHalfB64, takerHalfB64: taken.takerHalfB64, takerHalf: { id: taken.id }, bound: taken.bound, provingMs: Date.now() - t0 };
    },

    /** A taken offer to the sponsor: by the half's id, the maker half from the board when `offerId` names it. Waits for the job. */
    async submitSwap({ offerId, takerHalf }) {
      const job = await call("sponsor_swap", {
        halfId: takerHalf.id, ...(offerId ? { offerId } : {}), idempotencyKey: `otc-swap-${takerHalf.id}`,
      });
      const done = await waitForJob(job.jobId, job.sessionId);
      return { jobId: job.jobId, status: done?.status ?? "unknown", txHash: done?.txHash ?? null, error: done?.errorMessage ?? done?.errorCode ?? null };
    },

    /**
     * Merge coins: a swap of the wallet with itself. Each half spends the most
     * one half can give of a type (its largest coins, up to the cap) and gets
     * the sum back as one coin. Null when no type has more coins than one half
     * spends, or the wallet holds only one of the two.
     */
    async consolidate([typeA, typeB], { bind = true } = {}) {
      const w = await wallet();
      const [a, b] = [typeA, typeB].map((type) => w.tokens.find((t) => t.tokenType === type));
      if (!a || !b || BigInt(a.spendable) <= 0n || BigInt(b.spendable) <= 0n) return null;
      if (a.coins <= w.maxInputs && b.coins <= w.maxInputs) return null;
      const t0 = Date.now();
      const give = { tokenType: typeA, amount: String(a.spendable) };
      const want = { tokenType: typeB, amount: String(b.spendable) };
      const built = await call("build_swap_offer", { give, want, bind });
      let taken;
      try {
        taken = await call("take_swap_offer", { offer: built.offer ?? built.halfB64, expect: { gives: give, wants: want } });
      } catch (err) {
        await revert(built).catch(() => {});
        throw err;
      }
      return {
        makerHalfB64: taken.makerHalfB64, takerHalfB64: taken.takerHalfB64, takerHalf: { id: taken.id }, provingMs: Date.now() - t0,
        revert: async () => { await revert(taken); await revert(built); },
      };
    },

    revert,

    post: ({ offer, tags, expiresAt }) => call("post_swap_offer", { offer, tags, expiresAt }),
    listOffers: async (filter = {}) => rowsOf(await call("list_swap_offers", filter)),
    getOffer: (offerId) => call("get_swap_offer", { offerId }),
    retire: (offerId) => call("retire_swap_offer", { offerId }),

    /** Any other tool of the server, by name: attestations, proofs, identity. */
    call,
    close,
  };
}

/**
 * Start a trader's MCP server and wait until its shielded wallet has caught
 * up: minutes on the first open, seconds once `stateFile` exists.
 * `onProgress({ seconds })` while it syncs.
 */
export async function openMcpTrader({ name, seedHex, key, cfg, index = 0, stateFile = stateFileOf(name), onProgress = () => {} }) {
  const server = fileURLToPath(import.meta.resolve("@odatano/nightgate-mcp"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: traderEnv({ seedHex, key, cfg, stateFile, index }),
    stderr: "pipe",
  });
  // what the server said last, for the error when it does not come up
  let said = "";
  transport.stderr?.on("data", (chunk) => { said = (said + chunk).slice(-600); });
  const client = new Client({ name: `otc-market-${name}`, version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    throw new Error(`${name}: its MCP server did not start: ${err.message}${said ? ` (${said.trim().split("\n").at(-1)})` : ""}`);
  }

  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (res.isError) throw Object.assign(new Error(body?.message ?? text.slice(0, 300)), { status: body?.httpStatus, code: body?.code, detail: body });
    return body ?? text;
  };
  const close = () => client.close();

  try {
    const t0 = Date.now();
    for (;;) {
      // answers within 20 s, synced or not
      const w = await call("get_swap_wallet");
      if (w.synced) break;
      onProgress({ seconds: w.syncingSeconds ?? Math.round((Date.now() - t0) / 1000) });
      if (Date.now() - t0 > SYNC_TIMEOUT_MS) throw new Error(`${name}: its wallet did not sync in ${SYNC_TIMEOUT_MS / 60_000} minutes`);
    }
  } catch (err) {
    await close().catch(() => {});
    throw err;
  }
  return mcpTrader({ name, call, close });
}
