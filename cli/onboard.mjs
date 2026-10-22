#!/usr/bin/env node
/**
 * Agents onboard themselves to Strike. Every agent has a Cardano wallet of
 * its own, derived from the master seed; the treasury wallet is derived the
 * same way and holds the tADA a person sends once. The functions live in
 * gateway/onboard.mjs; the gateway runs them in a row for an agent made
 * from the page.
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
import { settings } from "../market/chain.mjs";
import { koios } from "../gateway/cardano.mjs";
import { odatano } from "../gateway/odatano.mjs";
import { strikeClient, TESTNET } from "../gateway/strike.mjs";
import { accountsFile, ACCOUNTS_FILE, agentWallet, connectStrike, depositToStrike, fundFromTreasury, treasuryWallet } from "../gateway/onboard.mjs";
import { registry } from "../gateway/registry.mjs";
import { profiles } from "../agents/profiles.mjs";

const log = (...x) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...x);
const [cmd, agentId, amount] = process.argv.slice(2);
const cfg = settings();
const treasury = treasuryWallet(cfg.master);
// chain reads and writes go through ODATANO when a key with the odatano product is set, else through Koios
const chain = process.env.ODATANO_ACCESS_KEY ? odatano({ key: process.env.ODATANO_ACCESS_KEY, baseUrl: process.env.ODATANO_ACCESS_URL || undefined }) : koios();
const base = process.env.STRIKE_API_URL || TESTNET;
const accounts = accountsFile();
const ada = (lovelace) => `${(Number(lovelace) / 1e6).toFixed(2)} ADA`;
// the built-in agents and the ones made from the page
const known = [...Object.keys(profiles({ owner: "x", expiry: new Date().toISOString() })), ...registry().list().map((e) => e.agentId)];
const need = (a) => { if (!known.includes(a)) throw new Error(`unknown agent ${a}; one of ${known.join(", ")}`); return agentWallet(cfg.master, a); };
const lovelaceOf = (x) => BigInt(Math.round(Number(x) * 1e6));

async function main() {
  switch (cmd) {
    case "addresses": {
      const all = accounts.read();
      console.log(`treasury  ${treasury.address}  ${ada(await chain.balance(treasury.address))}`);
      for (const a of known) { const w = agentWallet(cfg.master, a); console.log(`${a.padEnd(9)} ${w.address}  ${ada(await chain.balance(w.address))}${all[a] ? `  Strike ${all[a].accountId}` : ""}`); }
      return;
    }
    case "connect": {
      const w = need(agentId);
      const r = await connectStrike({ agentId, wallet: w, master: cfg.master, accounts, baseUrl: base, code: process.env.STRIKE_BUILDER_CODE, feeShareBps: Number(process.env.STRIKE_BUILDER_FEE_BPS || 10) });
      log(`${agentId}: Strike account ${r.accountId}, API wallet ${r.apiWalletPublicKeyHex.slice(0, 12)}…, builder ${r.builderCode} at ${r.feeShareBps} bps; saved to ${ACCOUNTS_FILE}`);
      return;
    }
    case "fund": {
      const w = need(agentId);
      const r = await fundFromTreasury({ chain, treasury, to: w.address, lovelace: lovelaceOf(amount), log: (e) => log(`${agentId}: ${e.kind}${e.txHash ? ` ${e.txHash}` : ""}`) });
      if (!r.landed) log(`${agentId}: ${r.txHash} not seen by the indexer after 400s; check before the next transfer`);
      return;
    }
    case "send": {
      const to = agentId;
      if (!/^addr_test1[0-9a-z]{20,}$/.test(to ?? "")) throw new Error("send <addr_test1…> <ada>");
      const r = await fundFromTreasury({ chain, treasury, to, lovelace: lovelaceOf(amount), log: (e) => log(`${e.kind}${e.txHash ? ` ${e.txHash}` : ""}`) });
      if (!r.landed) log(`${r.txHash} not seen by the indexer after 400s`);
      return;
    }
    case "deposit": {
      const w = need(agentId);
      const acc = accounts.read()[agentId];
      if (!acc) throw new Error(`${agentId} has no Strike account yet: connect first`);
      const strike = strikeClient({ baseUrl: base, privateKeyHex: acc.apiWalletPrivateKeyHex });
      await strike.syncClock();
      const r = await depositToStrike({ strike, wallet: w, chain, lovelace: lovelaceOf(amount), log: (e) => log(JSON.stringify(e)) });
      log(`${agentId}: deposit ${r.requestId} ${r.status}, ${ada(r.lovelace)} ≈ ${r.usd} USD, tx ${r.txHash}`);
      return;
    }
    case "status": {
      const w = need(agentId);
      console.log(`${agentId}: ${w.address} holds ${ada(await chain.balance(w.address))}`);
      const acc = accounts.read()[agentId];
      if (!acc) return console.log("no Strike account yet");
      const strike = strikeClient({ baseUrl: base, privateKeyHex: acc.apiWalletPrivateKeyHex });
      await strike.syncClock();
      const a = await strike.account();
      const p = await strike.positions();
      console.log(`Strike ${a.account_id}: balance ${a.wallet_balance} USD, available ${a.available_balance}, wallet ${a.blockchain}:${(a.blockchain_address ?? "").slice(0, 16)}…, positions ${p.count}`);
      return;
    }
    default: throw new Error(`usage: addresses | connect <agent> | fund <agent> <ada> | deposit <agent> <ada> | status <agent> | send <addr> <ada>`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
