/**
 * x402 on Cardano, the way ODATANO's gateway speaks it: a paid call without
 * a payment answers 402 with the requirements (base64 in `PAYMENT-REQUIRED`
 * and as JSON); the caller pays lovelace to `payTo` and repeats the call
 * with `PAYMENT-SIGNATURE`; the facilitator checks it (`POST /verify`) and
 * puts it on chain (`POST /settle`), both with the x402 v2 body; the answer
 * carries the receipt in `PAYMENT-RESPONSE`. Replay protection is the
 * chain's: the envelope's nonce is a UTxO the payment spends.
 */

/** @typedef {{ facilitatorUrl: string, facilitatorKey?: string, payTo: string, network?: string, asset?: string, maxTimeoutSeconds?: number }} X402Config */

export function requirement(resourceUrl, description, amount, x, extra) {
  return {
    scheme: "exact", network: x.network ?? "cardano:preprod", asset: x.asset ?? "lovelace", amount: String(amount), payTo: x.payTo,
    resource: { url: resourceUrl, description, mimeType: "application/json" },
    assetTransferMethod: "default", maxTimeoutSeconds: x.maxTimeoutSeconds ?? 600,
    ...(extra ? { extra } : {}),
  };
}

export function requirementsBody(accepts, error) {
  const resource = accepts[0]?.resource;
  return { x402Version: 2, ...(error ? { error } : {}), ...(resource ? { resource } : {}), accepts };
}

/** Answer a node:http response with 402: the header for x402 v2 clients, the body for scripts. */
export function send402(res, body, extra = {}) {
  res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(body), "utf8").toString("base64"), "cache-control": "no-store" });
  res.end(JSON.stringify({ ...body, ...extra }));
}

export function paymentHeader(headers) {
  const v = headers["payment-signature"];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length > 0 ? normalizeEnvelope(s.slice(0, 64 * 1024)) : null;
}

/** The v2 clients put scheme and network under `accepted`; the facilitator wants them at the top. */
export function normalizeEnvelope(headerB64) {
  let raw;
  try { raw = JSON.parse(Buffer.from(headerB64, "base64").toString("utf8")); } catch { return headerB64; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return headerB64;
  const acc = raw.accepted;
  if (!acc || typeof acc !== "object" || ("scheme" in raw && "network" in raw)) return headerB64;
  return Buffer.from(JSON.stringify({ ...raw, ...("scheme" in raw ? {} : { scheme: acc.scheme }), ...("network" in raw ? {} : { network: acc.network }) }), "utf8").toString("base64");
}

export class FacilitatorError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Verify, then settle, against `body.accepts[0]`; `accepted`, `rejected` or `pending`. */
export async function verifySettle(paymentHeaderB64, body, x, { fetch = globalThis.fetch } = {}) {
  let paymentPayload;
  try { paymentPayload = JSON.parse(Buffer.from(paymentHeaderB64, "base64").toString("utf8")); } catch { return { kind: "rejected", code: "invalid_base64", reason: "PAYMENT-SIGNATURE is not base64 JSON" }; }
  const paymentRequirements = body.accepts[0];
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (x.facilitatorKey) headers.authorization = `Bearer ${x.facilitatorKey}`;
  const post = async (route) => {
    let res;
    try {
      res = await fetch(`${x.facilitatorUrl}${route}`, { method: "POST", headers, body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }), signal: AbortSignal.timeout(90_000) });
    } catch (err) {
      throw new FacilitatorError(503, err?.name === "TimeoutError" ? "facilitator timeout" : `facilitator unreachable: ${err?.message ?? err}`);
    }
    const text = await res.text();
    if (!res.ok) throw new FacilitatorError(502, `facilitator ${res.status} on ${route}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { throw new FacilitatorError(502, "facilitator answered no JSON"); }
  };
  const v = await post("/verify");
  if (!v.isValid) return { kind: "rejected", code: String(v.invalidReason ?? "invalid"), reason: String(v.invalidReason ?? "") };
  const s = await post("/settle");
  if (!s.success) {
    const reason = String(s.errorReason ?? "settle failed");
    return /pending|not yet|confirm/i.test(reason) ? { kind: "pending", code: reason, txHash: s.transaction, reason } : { kind: "rejected", code: reason, reason };
  }
  const payment = { txHash: s.transaction, amountUnits: paymentRequirements.amount, network: s.network ?? paymentRequirements.network, asset: paymentRequirements.asset, payTo: paymentRequirements.payTo, resourceUrl: paymentRequirements.resource?.url ?? "", payerAddr: s.payer ?? v.payer ?? null };
  return { kind: "accepted", txHash: s.transaction, payment, paymentResponseB64: Buffer.from(JSON.stringify(s), "utf8").toString("base64") };
}

/**
 * Charge one call: null when paid (the receipt is set on `res`), else the
 * 402 or error has been sent and the caller stops. `onPaid` gets the payment.
 */
export async function charge(req, res, { url, description, amount, x, extra, fetch, onPaid = () => {} }) {
  const accept = requirement(url, description, amount, x, extra);
  const header = paymentHeader(req.headers);
  const hint = { note: `pay ${amount} ${accept.asset} on ${accept.network} for this one call; the payment is not refunded if the call is then refused by the mandate` };
  if (!header) { send402(res, requirementsBody([accept], "PAYMENT-SIGNATURE header is required"), hint); return { paid: false }; }
  let settled;
  try { settled = await verifySettle(header, requirementsBody([accept]), x, { fetch }); } catch (err) {
    if (err instanceof FacilitatorError) { res.writeHead(err.status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: err.message })); return { paid: false }; }
    throw err;
  }
  if (settled.kind === "pending") { send402(res, requirementsBody([accept], `payment pending (${settled.code})${settled.reason ? `: ${settled.reason}` : ""}`), { pending: true, transaction: settled.txHash ?? null, ...hint }); return { paid: false }; }
  if (settled.kind === "rejected") { send402(res, requirementsBody([accept], `payment rejected (${settled.code})${settled.reason ? `: ${settled.reason}` : ""}`), hint); return { paid: false }; }
  if (settled.paymentResponseB64) { res.setHeader("PAYMENT-RESPONSE", settled.paymentResponseB64); res.setHeader("X-PAYMENT-RESPONSE", settled.paymentResponseB64); }
  onPaid(settled.payment);
  return { paid: true, payment: settled.payment };
}
