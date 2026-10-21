/**
 * The token factory as a package: the compiled class from
 * @odatano/contract-token-factory, names, domains, types and witnesses from
 * @odatano/contract-kit, and the prover keys from the package's release
 * assets, fetched once into the installed package and verified against its
 * manifest.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveContractPackage, readProverKeyManifest, verifierCircuits, missingProverKeys, keyMatchesManifest, proverKeyUrl } from "@odatano/contract-kit/node";
import { tokenName, nameOf, tokenTypeOf, tokenFactoryWitnesses, bytesToHex } from "@odatano/contract-kit";

export { tokenName, nameOf, bytesToHex as hex };

const PACKAGE = "@odatano/contract-token-factory";
const here = path.dirname(fileURLToPath(import.meta.url));

/** The installed package: contract class, pure circuits, paths, contract.json. */
export async function factoryPackage() {
  const pkg = resolveContractPackage(PACKAGE, path.join(here, ".."));
  const mod = await import(PACKAGE);
  return { ...pkg, mod, Contract: mod.Contract, pureCircuits: mod.pureCircuits, ledger: mod.ledger };
}

/**
 * Prover keys are release assets, not npm content: fetch the missing ones
 * into the package's keys directory and verify each against keys/manifest.json.
 */
export async function ensureFactoryKeys(pkg, { log = () => {} } = {}) {
  const missing = missingProverKeys(pkg.zkConfigPath);
  if (missing.length === 0) return [];
  const manifest = readProverKeyManifest(pkg.zkConfigPath);
  if (!manifest) throw new Error(`${pkg.name}: keys/manifest.json is missing, cannot verify a download`);
  const keysDir = path.join(pkg.zkConfigPath, "keys");
  for (const circuit of missing) {
    const expected = manifest.prover[circuit];
    if (!expected) throw new Error(`${pkg.name}: the manifest lists no prover key for ${circuit}`);
    const url = proverKeyUrl(pkg.manifest.zkAssetUrl, pkg.manifest.zkAssetLayout, circuit);
    log(`fetching ${circuit}.prover from ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (!keyMatchesManifest(body, expected)) throw new Error(`${circuit}.prover does not match keys/manifest.json (sha256 ${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}…)`);
    const dest = path.join(keysDir, `${circuit}.prover`);
    fs.writeFileSync(`${dest}.part`, body);
    fs.renameSync(`${dest}.part`, dest);
  }
  if (missingProverKeys(pkg.zkConfigPath).length) throw new Error(`${pkg.name}: prover keys still missing after the fetch`);
  return missing;
}

export const factoryCircuits = (pkg) => verifierCircuits(pkg.zkConfigPath);

/** The witnesses over a mutable bag, one Contract instance for every call. */
export const witnesses = (bag) => tokenFactoryWitnesses(bag);

/** "<issuer>:<name>" with the issuer's secret → { issuer, domain, type } (hex) on the deployed factory. */
export function tokenOf(pure, { issuerSecret, issuerKey, name, contractAddress }) {
  return tokenTypeOf(pure, {
    ...(issuerSecret ? { issuerSecret: Buffer.from(issuerSecret).toString("hex") } : { issuerKey }),
    name,
    contractAddress,
  });
}

/**
 * The shielded keys of a Midnight seed (128 hex), derived the way the wallet
 * SDK and the transaction builder derive them, so coins minted to
 * `coinPublicKey` show up in that wallet.
 */
export async function shieldedKeysOf(seedHex) {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const hd = require(require.resolve("@odatano/nightgate-tx/package.json").replace(/package\.json$/, "srv/utils/wallet-hd.js"));
  const ledger = await import("@midnight-ntwrk/ledger-v8");
  const { zswap } = await hd.deriveRoleSeeds(Uint8Array.from(Buffer.from(seedHex, "hex")), 0);
  const keys = ledger.ZswapSecretKeys.fromSeed(zswap);
  return { keys, coinPublicKey: keys.coinPublicKey, encryptionPublicKey: keys.encryptionPublicKey };
}
