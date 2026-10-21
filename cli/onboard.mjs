#!/usr/bin/env node
/**
 * Agents onboard themselves to Strike. Every agent has a Cardano wallet of
 * its own, derived from the master seed; the treasury wallet is derived the
 * same way and holds the tADA a person sends once.
 *
 *   npm run onboard -- addresses                 # treasury and agent addresses, with their tADA
 *   npm run onboard -- connect <agent>           # builder connect: Strike account + API wallet, saved to data/strike-accounts.json
 *   npm run onboard -- fund <agent> <ada>        # tADA from the treasury to the agent's wallet
 *   npm run onboard -- deposit <agent> <ada>     # the agent's ADA into its Strike account
 *   npm run onboard -- status <agent>            # chain balance, Strike balance, positions
 *   npm run onboard -- send <addr_test1…> <ada>  # tADA from the treasury to any preprod address
 *
 * Needs STRIKE_BUILDER_CODE (and STRIKE_BUILDER_FEE_BPS, default 10). With
 * ODATANO_ACCESS_KEY the transfer is built by ODATANO and every read and
 * submit goes through the gateway; without it Koios serves and the
 * transfer is built here.
 */
import fs from "node:fs";
import path from "node:path";
import { settings } from "../market/chain.mjs";
import { secretFor } from "../lib/identity.mjs";
import { cardanoWallet, buildTransfer, koios, signTransaction } from "../gateway/cardano.mjs";
import { odatano } from "../gateway/odatano.mjs";
import { strikeClient, TESTNET } from "../gateway/strike.mjs";
import { builderConnect, depositAda } from "../gateway/strike-connect.mjs";
import { profiles } from "../agents/profiles.mjs";

const ACCOUNTS = path.join("data", "strike-accounts.json");
const log = (...x) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...x);
const [cmd, agentId, amount] = process.argv.slice(2);
const cfg = settings();
const hex = (u8) => Buffer.from(u8).toString("hex");
// agents use base addresses (payment plus stake key), the form wallet apps give Strike; the treasury stays an enterprise address
const walletOf = (label) => (label === "treasury" ? cardanoWallet(hex(secretFor(cfg.master, "cardano", label))) : cardanoWallet(hex(secretFor(cfg.master, "cardano", label)), { stakeSeedHex: hex(secretFor(cfg.master, "cardano-stake", label)) }));
const treasury = walletOf("treasury");
// chain reads and writes go through ODATANO when a key with the odatano product is set, else through Koios
const chain = process.env.ODATANO_ACCESS_KEY ? odatano({ key: process.env.ODATANO_ACCESS_KEY, baseUrl: process.env.ODATANO_ACCESS_URL || undefined }) : koios();
const base = process.env.STRIKE_API_URL || TESTNET;
const accounts = fs.existsSync(ACCOUNTS) ? JSON.parse(fs.readFileSync(ACCOUNTS, "utf8")) : {};
const save = () => { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync(ACCOUNTS, JSON.stringify(accounts, null, 1), { mode: 0o600 }); };
const ada = (lovelace) => `${(Number(lovelace) / 1e6).toFixed(2)} ADA`;
const known = Object.keys(profiles({ owner: "x", expiry: new Date().toISOString() }));
if (accounts.previous) delete accounts.previous_; // keeps the file shape explicit
const need = (a) => { if (!known.includes(a)) throw new Error(`unknown agent ${a}; one of ${known.join(", ")}`); return walletOf(a); };

async function main() {
  switch (cmd) {
    case "addresses": {
      console.log(`treasury  ${treasury.address}  ${ada(await chain.balance(treasury.address))}`);
      for (const a of known) { const w = walletOf(a); console.log(`${a.padEnd(9)} ${w.address}  ${ada(await chain.balance(w.address))}${accounts[a] ? `  Strike ${accounts[a].accountId}` : ""}`); }
      return;
    }
    case "connect": {
      const w = need(agentId);
      if (!process.env.STRIKE_BUILDER_CODE) throw new Error("STRIKE_BUILDER_CODE is not set");
      const r = await builderConnect({ baseUrl: base, code: process.env.STRIKE_BUILDER_CODE, feeShareBps: Number(process.env.STRIKE_BUILDER_FEE_BPS || 10), wallet: w, apiWalletSeedHex: hex(secretFor(cfg.master, "strike-api", agentId, String(Date.now()))) });
      if (accounts[agentId]) (accounts.previous ??= []).push({ agentId, ...accounts[agentId] });
      accounts[agentId] = { accountId: r.accountId, apiWalletPrivateKeyHex: r.apiWalletPrivateKeyHex, apiWalletPublicKeyHex: r.apiWalletPublicKeyHex, address: r.address, builderCode: r.builderCode, feeShareBps: r.feeShareBps, connectedAt: new Date().toISOString() };
      save();
      log(`${agentId}: Strike account ${r.accountId}, API wallet ${r.apiWalletPublicKeyHex.slice(0, 12)}…, builder ${r.builderCode} at ${r.feeShareBps} bps; saved to ${ACCOUNTS}`);
      return;
    }
    case "fund": {
      const w = need(agentId);
      const lovelace = BigInt(Math.round(Number(amount) * 1e6));
      let signed;
      if (chain.kind === "odatano") {
        const built = await chain.buildTransfer({ from: treasury.address, to: w.address, lovelace });
        signed = signTransaction(built.unsignedTxCbor, treasury);
        log(`${agentId}: transfer built by ODATANO, fee ${built.fee ?? "?"}, signed here`);
      } else {
        signed = buildTransfer({ wallet: treasury, utxos: await chain.utxos(treasury.address), to: w.address, lovelace });
      }
      const h = await chain.submit(signed.cborHex);
      log(`${agentId}: ${ada(lovelace)} from the treasury, tx ${h}; waiting for it to land`);
      // the next transfer must not spend the same inputs: wait until the indexer shows this one
      for (let i = 0; i < 40; i++) { if ((await chain.txInfo([h])).length) { log(`${agentId}: landed`); return; } await new Promise((r) => setTimeout(r, 10_000)); }
      log(`${agentId}: not seen by the indexer after 400s; check before the next transfer`);
      return;
    }
    case "send": {
      const to = agentId;
      if (!/^addr_test1[0-9a-z]{20,}$/.test(to ?? "")) throw new Error("send <addr_test1…> <ada>");
      const lovelace = BigInt(Math.round(Number(amount) * 1e6));
      let signed;
      if (chain.kind === "odatano") signed = signTransaction((await chain.buildTransfer({ from: treasury.address, to, lovelace })).unsignedTxCbor, treasury);
      else signed = buildTransfer({ wallet: treasury, utxos: await chain.utxos(treasury.address), to, lovelace });
      const h = await chain.submit(signed.cborHex);
      log(`${ada(lovelace)} from the treasury to ${to.slice(0, 20)}…, tx ${h}; waiting for it to land`);
      for (let i = 0; i < 40; i++) { if ((await chain.txInfo([h])).length) { log("landed"); return; } await new Promise((r) => setTimeout(r, 10_000)); }
      return;
    }
    case "deposit": {
      const w = need(agentId);
      const acc = accounts[agentId];
      if (!acc) throw new Error(`${agentId} has no Strike account yet: connect first`);
      const strike = strikeClient({ baseUrl: base, privateKeyHex: acc.apiWalletPrivateKeyHex });
      await strike.syncClock();
      const r = await depositAda({ strike, wallet: w, koios: chain, lovelace: BigInt(Math.round(Number(amount) * 1e6)), log: (e) => log(JSON.stringify(e)) });
      log(`${agentId}: deposit ${r.requestId} ${r.status}, ${ada(r.lovelace)} ≈ ${r.usd} USD, tx ${r.txHash}`);
      return;
    }
    case "status": {
      const w = need(agentId);
      console.log(`${agentId}: ${w.address} holds ${ada(await chain.balance(w.address))}`);
      const acc = accounts[agentId];
      if (!acc) return console.log("no Strike account yet");
      const strike = strikeClient({ baseUrl: base, privateKeyHex: acc.apiWalletPrivateKeyHex });
      await strike.syncClock();
      const a = await strike.account();
      const p = await strike.positions();
      console.log(`Strike ${a.account_id}: balance ${a.wallet_balance} USD, available ${a.available_balance}, wallet ${a.blockchain}:${(a.blockchain_address ?? "").slice(0, 16)}…, positions ${p.count}`);
      return;
    }
    default: throw new Error(`usage: addresses | connect <agent> | fund <agent> <ada> | deposit <agent> <ada> | status <agent>`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
