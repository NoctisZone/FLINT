/**
 * Claude as a market maker's mind: once a round it sees the mark, funding,
 * its books, its open quotes and the mandate, and answers with the spread
 * and size it wants to quote, or a pause, plus one sentence why. The
 * gateway turns that into quotes through the same checks as every other
 * action; a spent budget or a failed request hands the round to the rules.
 */
import crypto from "node:crypto";
import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";

export const MAKER_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", description: "one short sentence, at most 25 words, naming the spread you chose" },
    pause: { type: "boolean", description: "true pulls every quote this round and posts none" },
    spreadBps: { type: "integer", description: "each side's distance from the mark in basis points, inside the mandate's band" },
    sizeUsd: { type: "integer", description: "each quote's size in USD, from minQuoteUsd (the smallest hedge Strike accepts) to maxQuoteUsd" },
  },
  required: ["reason", "pause", "spreadBps", "sizeUsd"],
  additionalProperties: false,
};

export const MAKER_PROMPT = `You are a market maker on a private venue. You quote a bid and an ask on one pair (your view names it as pair, a test coin against tUSD) around the Strike mark price of its market (your view names it as symbol); every fill you get is hedged on that Strike market within seconds, so your profit is the spread you capture minus the hedge's taker fee and slippage, roughly 8 basis points per fill. You never hold a directional view: a fill is a round trip, not a position. An agent on several markets is asked once per market; each answer is for the pair in that view.

You see: the pair and its Strike market, the mark and the funding rate, your books on that market (inventory in the base coin, Strike position, net delta), your open quotes, recent fills with their hedge latency, the mandate (spread band, size cap, open quote cap, net delta limit), and what the wallet can still quote.

Choose the spread per side in basis points (how far your bid and your ask each sit from the mark) and the size in USD, at least minQuoteUsd (the smallest hedge Strike accepts) and at most maxQuoteUsd. Quote tighter when fills are landing and hedges are fast, wider when the mark moves a lot or the hedge was slow. Pause only when something is wrong: a hedge is late or the sponsor is down. Net delta near its limit is no reason to pause: the gateway then quotes only the side that brings it back, and a carried exposure under Strike's minimum order is hedged together with the next fill. Stay inside the mandate; anything outside is refused by the gateway, not by you.

Decide first, then write the reason: one plain sentence in English, at most 25 words, naming the spread.`;

/**
 * @param {object} o
 * @param {object} o.client   an Anthropic client
 * @param {string} [o.model]
 * @param {string} [o.effort]
 * @param {{limit:number, left:(name)=>number, spend:(name)=>void}} o.budget
 * @param {(entry)=>void} o.journal
 */
export function claudeMaker({ client, model = "claude-haiku-5-5", effort = "low", budget, journal = () => {}, now = () => Date.now() }) {
  const format = betaJSONSchemaOutputFormat(MAKER_SCHEMA);

  async function decide(view) {
    const base = { id: crypto.randomUUID(), ts: new Date(now()).toISOString(), agent: view.agentId, model };
    if (budget.left(view.agentId) <= 0) {
      const why = `its daily budget of ${budget.limit} decisions is spent`;
      journal({ ...base, fallback: why });
      return { fallback: why };
    }
    const user = JSON.stringify(view, null, 2);
    const promptHash = crypto.createHash("sha256").update(JSON.stringify({ model, effort, system: MAKER_PROMPT, user })).digest("hex");
    budget.spend(view.agentId);
    let res;
    try {
      res = await client.beta.messages.parse({
        model, max_tokens: 4000,
        ...(/^claude-haiku/.test(model) ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
        output_config: { effort, format },
        system: MAKER_PROMPT,
        messages: [{ role: "user", content: user }],
      });
    } catch (err) {
      const why = `Claude did not answer: ${err.message.slice(0, 200)}`;
      journal({ ...base, promptHash, fallback: why });
      return { fallback: why };
    }
    const usage = { input: res.usage?.input_tokens ?? null, output: res.usage?.output_tokens ?? null };
    const d = res.stop_reason === "end_turn" ? res.parsed_output : null;
    if (!d || typeof d.reason !== "string" || typeof d.spreadBps !== "number" || typeof d.sizeUsd !== "number") {
      const why = res.stop_reason === "refusal" ? "Claude declined to decide" : `Claude's answer was not a decision (${res.stop_reason})`;
      journal({ ...base, promptHash, stopReason: res.stop_reason, usage, fallback: why });
      return { fallback: why };
    }
    const decision = { pause: d.pause === true, spreadBps: Math.round(d.spreadBps), sizeUsd: Math.round(d.sizeUsd), reason: d.reason.trim() };
    journal({ ...base, servedBy: res.model ?? model, promptHash, usage, decision });
    return decision;
  }

  return { decide };
}
