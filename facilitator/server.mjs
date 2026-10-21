// x402 facilitator for Flint: verifies and settles Cardano x402 payments for the gateway's
// tools endpoint. @odatano/core (preprod) does the chain work with the ODATANO API as its
// backend (config in package.json); @odatano/x402 is the reference facilitator router.
//   PORT                 4040
//   ODATANO_ACCESS_URL   the gateway, default https://api.preprod.odatano.dev
//   ODATANO_ACCESS_KEY   an oda_ key with the odatano product
//   FACILITATOR_API_KEY  bearer on /v1; unset = open (local use only)
import express from "express";

if (!process.env.ODATANO_ACCESS_KEY) throw new Error("ODATANO_ACCESS_KEY is required: the facilitator reads the chain through the ODATANO API");
process.env.ODATANO_URL = process.env.ODATANO_ACCESS_URL || "https://api.preprod.odatano.dev";
process.env.ODATANO_API_KEY = process.env.ODATANO_ACCESS_KEY;
const { createFacilitatorRouter } = await import("@odatano/x402");

const PORT = Number(process.env.PORT ?? 4040);
const API_KEY = process.env.FACILITATOR_API_KEY ?? "";

const app = express();
app.disable("x-powered-by");
app.use("/v1", createFacilitatorRouter({
  auth: API_KEY ? (req) => req.headers.authorization === `Bearer ${API_KEY}` : undefined,
  onSettle: (r) => console.log(`${r.success ? "settled" : `not settled (${r.errorReason})`} ${r.transaction ?? ""}`),
}));
app.listen(PORT, "127.0.0.1", () => console.log(`x402 facilitator on 127.0.0.1:${PORT}/v1${API_KEY ? "" : " (open)"}`));
