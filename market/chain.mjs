/**
 * The token factory and the offer board on Midnight through NIGHTGATE: mints
 * are built and proven here, the sponsor pays; swaps go through the traders'
 * own servers (market/mcp-trader.mjs). Shared by the CLI (cli/live.mjs) and
 * the market (market/otc-market-env.mjs).
 *
 * Every transaction in data/otc-live.jsonl. Issuer secrets are derived from
 * the master seed (data/master-seed) and never written down.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureFactoryKeys, factoryPackage, hex, nameOf, shieldedKeysOf, tokenName, tokenOf, witnesses } from "./factory.mjs";
import { midnightSeedOf, secretFor } from "../lib/identity.mjs";

const LOG_FILE = path.join("data", "otc-live.jsonl");
// the two tokens the agents trade, both issued by the market
export const DEMO_TOKENS = ["market:tBTC", "market:tUSD"];

// the market lives on preprod, on one token factory deployed there once; every market mints its own tokens on it
const NETWORK = "preprod";
export const NIGHTGATE_URL = "https://api.preprod.odatano.dev";
export const FACTORY_ADDRESS = "d96fcca18b3ca748af0c0934d88a47113bb52e586afe334f3d9f5e66e5aea02c";
const PROOF_SERVER_URL = "http://localhost:6300";
// 32 bytes every trader, the builder and the issuers derive from; made on the first start, never shown
export const SEED_FILE = path.join("data", "master-seed");

function masterSeed() {
  if (fs.existsSync(SEED_FILE)) return fs.readFileSync(SEED_FILE, "utf8").trim();
  const seed = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  fs.writeFileSync(SEED_FILE, `${seed}\n`, { mode: 0o600 });
  return seed;
}

/**
 * The settings: the key from the environment (.env.example), the master seed
 * from data/, the proof server on this machine. Gateway, network, factory and
 * sponsor are the same for every market.
 */
export function settings(env = process.env) {
  if (!env.NIGHTGATE_KEY) throw new Error("NIGHTGATE_KEY is not set");
  const proofServerUrls = proofServersOf(env.PROOF_SERVER_URL);
  return {
    nightgateUrl: NIGHTGATE_URL,
    nightgateKey: env.NIGHTGATE_KEY,
    master: masterSeed(),
    network: NETWORK,
    // the wallets' chain reads; an own indexer and node when set, the public ones otherwise
    indexerHttpUrl: env.INDEXER_HTTP_URL || `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`,
    indexerWsUrl: env.INDEXER_WS_URL || `wss://indexer.${NETWORK}.midnight.network/api/v4/graphql/ws`,
    nodeUrl: env.NODE_URL || `wss://rpc.${NETWORK}.midnight.network/`,
    // the market's own proofs go to the first; the traders' servers are spread over all of them
    proofServerUrl: proofServerUrls[0],
    proofServerUrls,
  };
}

/** The proof servers in PROOF_SERVER_URL, comma-separated, each on this machine; the default one when unset. */
export function proofServersOf(value) {
  const urls = String(value || PROOF_SERVER_URL).split(",").map((s) => s.trim()).filter(Boolean);
  for (const u of urls) {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(u)) throw new Error(`PROOF_SERVER_URL must name proof servers on this machine, not ${u}: they receive the witnesses`);
  }
  return urls;
}

export { secretFor };

/** One NIGHTGATE action as JSON over the gateway; `key` is the caller's when it is not the market's own. */
export async function ng(cfg, name, params, { timeoutMs = 60_000, key = cfg.nightgateKey } = {}) {
  const res = await fetch(`${cfg.nightgateUrl}/api/v1/nightgate/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(errorText(body) || `HTTP ${res.status}: ${text.slice(0, 200)}`), { status: res.status, code: body?.error?.code });
  return body;
}

// the server answers { error: { code, message } }, the gateway { error: "<text>" }
const errorText = (body) => (typeof body?.error === "string" ? body.error : body?.error?.message);

/** A literal that goes into a function call as it is: a UUID, a timestamp. */
export const bare = (value) => {
  if (!/^[A-Za-z0-9:.+-]+$/.test(String(value))) throw new Error(`not a bare OData literal: ${value}`);
  return { bare: String(value) };
};

/** One NIGHTGATE function (GET) with OData literals; null marks an unused declared parameter. */
export async function ngFunction(cfg, name, params, { timeoutMs = 30_000, key = cfg.nightgateKey } = {}) {
  const literal = (v) => (v === null ? "null" : typeof v === "number" || typeof v === "boolean" ? String(v) : v?.bare ?? `'${encodeURIComponent(String(v).replace(/'/g, "''"))}'`);
  const args = Object.entries(params).map(([k, v]) => `${k}=${literal(v)}`).join(",");
  const res = await fetch(`${cfg.nightgateUrl}/api/v1/nightgate/${name}(${args})`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(errorText(body) || `HTTP ${res.status}`), { status: res.status, code: body?.error?.code });
  return body.value ?? body;
}

/** Poll until the job leaves the queue. A slow or failing poll is not a verdict. */
export async function waitForJob(cfg, jobId, sessionId, { timeoutMs = 600_000, everyMs = 5_000, key } = {}) {
  const t0 = Date.now();
  let job = null;
  for (;;) {
    try {
      job = await ng(cfg, "getJobStatus", { jobId, sessionId }, { key });
      if (["succeeded", "failed"].includes(job.status)) return job;
      if (job.status === "reconciliation_required" && job.txHash) return job;
    } catch (e) {
      if (!/HTTP 5\d\d|fetch failed|timeout|ECONNRESET/i.test(e.message)) throw e;
    }
    if (Date.now() - t0 > timeoutMs) return job;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export function journal(entry) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

/** The factory package with its prover keys in place. */
export async function loadFactory({ log } = {}) {
  const pkg = await factoryPackage();
  await ensureFactoryKeys(pkg, { log });
  return pkg;
}

/** The market's own builder wallet: it builds mints, and holds nothing. */
export async function builderFor(cfg, pkg, seedHex = Buffer.concat([secretFor(cfg.master, "builder", "a"), secretFor(cfg.master, "builder", "b")]).toString("hex")) {
  const { createTxBuilder } = await import("@odatano/nightgate-tx/txbuilder");
  return createTxBuilder({
    seedHex,
    networkId: cfg.network,
    indexerHttpUrl: cfg.indexerHttpUrl, indexerWsUrl: cfg.indexerWsUrl, nodeUrl: cfg.nodeUrl,
    contractClass: pkg.Contract, contractName: pkg.manifest.name, privateStateId: pkg.manifest.privateStateId,
    zkConfigDir: pkg.zkConfigPath,
    walletSync: false,
    ...(cfg.proofServerUrl ? { provingMode: "server", proofServerUrl: cfg.proofServerUrl, proofTimeoutMs: 900_000 } : {}),
  });
}

const entryOf = (job, extra) => ({ ...extra, status: job?.status ?? "unknown", txHash: job?.txHash ?? null, error: job?.errorMessage ?? job?.errorCode ?? null });

/** "<issuer>:<name>" → the raw token type on the factory, for this market's issuer. */
export async function tokenTypes(cfg, pure, specs = DEMO_TOKENS) {
  const out = [];
  for (const spec of specs) {
    const [issuer, name] = spec.split(":");
    const t = await tokenOf(pure, { issuerSecret: secretFor(cfg.master, "issuer", issuer), name, contractAddress: FACTORY_ADDRESS });
    out.push({ token: spec, name, domain: t.domain, type: t.type });
  }
  return out;
}

/**
 * Mint `amount` of an issuer's token to trader `index`'s shielded wallet. The
 * market's builder builds the call; the trader's public keys go in as
 * `recipients`, so the new coin is encrypted to it. Returns the journal entry.
 */
export async function mintTo(cfg, pkg, spec, amount, index) {
  const [issuer, name] = spec.split(":");
  if (!issuer || !name) throw new Error(`token must be <issuer>:<name>, not "${spec}"`);
  const { coinPublicKey, encryptionPublicKey } = await shieldedKeysOf(midnightSeedOf(cfg.master, Number(index)));
  const builder = await builderFor(cfg, pkg);
  const t0 = Date.now();
  try {
    const built = await builder.buildSponsorable({
      contractAddress: FACTORY_ADDRESS,
      call: {
        circuitId: "mint",
        args: [tokenName(name), BigInt(amount), { bytes: Uint8Array.from(Buffer.from(coinPublicKey, "hex")) }],
        witnesses: witnesses(() => ({ issuerSecret: secretFor(cfg.master, "issuer", issuer) })),
      },
      recipients: [{ coinPublicKey, encryptionPublicKey }],
      bind: false,
    });
    const provingMs = Date.now() - t0;
    const sub = await ng(cfg, "sponsorUnboundTransaction", { unboundTxB64: built.unboundTxB64, idempotencyKey: `otc-mint-${Date.now()}` });
    const entry = entryOf(await waitForJob(cfg, sub.jobId, sub.sessionId), { circuit: "mint", token: spec, amount: String(amount), agent: Number(index), jobId: sub.jobId, provingMs, bytes: built.serializedBytes });
    journal(entry);
    return entry;
  } finally {
    await builder.close?.();
  }
}

/** The journal entry of a swap a trader's own server handed in and waited for. */
export function journalSwap(result, label = {}) {
  const entry = { circuit: "swap", ...label, status: result.status, txHash: result.txHash ?? null, error: result.error ?? null };
  journal(entry);
  return entry;
}

/** The server's offer board. `key` is the caller's: an offer is retired by the key that posted it. */
export const board = {
  post: (cfg, { offer, expiresAt, tags }, { key } = {}) => ng(cfg, "postSwapOffer", { offer, expiresAt, tags: tags ? JSON.stringify(tags) : undefined }, { key }),
  /** Open offers newest first; `status` reads the closed ones (filled | retired | expired | all), `mine` only the caller's. */
  list: (cfg, { givesType = null, wantsType = null, tag = null, limit = null, status = null, since = null, mine = null } = {}, { key } = {}) =>
    ngFunction(cfg, "listSwapOffers", { givesType, wantsType, tag, limit, status, since: since ? bare(since) : null, mine }, { key }),
  /** One offer by id, open or closed. */
  get: (cfg, offerId, { key } = {}) => ngFunction(cfg, "getSwapOffer", { offerId: bare(offerId) }, { key }),
  retire: (cfg, offerId, { key } = {}) => ng(cfg, "retireSwapOffer", { offerId }, { key }),
};

/** The board's counts and its sponsors, a free read: { openOffers, swapsToday, sponsorsConfigured, sponsorsReady, ... }. */
export async function boardStatus(cfg, { timeoutMs = 15_000 } = {}) {
  const res = await fetch(`${cfg.nightgateUrl}/api/v1/indexer/getBoardStatus()`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(errorText(body) || `HTTP ${res.status}`), { status: res.status });
  return body;
}

/** The factory's tokens as the chain has them. */
export async function factoryState(cfg, pkg) {
  const { indexerPublicDataProvider } = await import("@midnight-ntwrk/midnight-js-indexer-public-data-provider");
  const cs = await indexerPublicDataProvider(cfg.indexerHttpUrl, cfg.indexerWsUrl).queryContractState(FACTORY_ADDRESS);
  if (!cs) return { address: FACTORY_ADDRESS, tokens: [], missing: true };
  const l = pkg.ledger(cs.data ?? cs);
  return {
    address: FACTORY_ADDRESS,
    mints: l.round,
    tokens: [...l.tokens].map(([domain, t]) => ({ name: nameOf(t.name), supply: t.supply, issuer: hex(t.issuer), domain: hex(domain) })),
  };
}
