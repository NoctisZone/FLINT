/**
 * A fetch that pays x402 invoices on Cardano from a mnemonic wallet: the
 * official client (@x402/fetch with @x402/cardano). What an outside agent
 * uses against the tools endpoint and the owner API's paid calls.
 */
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { toClientCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";

/** @returns {{ fetch: typeof fetch, address: string }} */
export function paidFetch({ mnemonic, network = "cardano:preprod", koiosUrl = "https://preprod.koios.rest/api/v1" }) {
  if (!mnemonic) throw new Error("BUYER_MNEMONIC is not set");
  const signer = toClientCardanoSigner({ mnemonic, network, provider: { koios: { baseUrl: koiosUrl } } });
  // lovelace is not one of the client's USD-pegged default assets: spend controls off
  const client = x402Client.fromConfig({ schemes: [{ network: "cardano:*", client: new ExactCardanoScheme(signer) }], spendControls: false });
  return { fetch: wrapFetchWithPayment(fetch, client), address: signer.getAddress() };
}

/** The receipt an x402 answer carries, decoded; null without one. */
export function receiptOf(res) {
  const r = res.headers.get("payment-response");
  if (!r) return null;
  try { return JSON.parse(Buffer.from(r, "base64").toString("utf8")); } catch { return null; }
}
