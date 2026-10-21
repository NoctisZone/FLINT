/**
 * Claude as a trader's mind. Each round a Claude trader gets one request: its
 * goal, its wallet, the board and the last fills; the answer is one decision
 * (take an offer, post one, retire its own, or wait) with one sentence why.
 * The market carries the decision out through the trader's own MCP server,
 * the same tools a rule trader uses, so nothing the model decides is
 * privileged or unchecked: offers, amounts and the trader's coins are
 * validated by the market before anything is built.
 *
 * Every decision goes to data/llm-decisions.jsonl: prompt hash, the decision,
 * tokens, and what the market made of it. A trader whose daily budget is
 * spent, or whose request fails or is declined, is run by the rules for that
 * round.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";

export const LLM_JOURNAL = path.join("data", "llm-decisions.jsonl");
export const LLM_BUDGET_FILE = path.join("data", "llm-budget.json");

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

/** What the model answers. Unused fields are null. */
export const DECISION_SCHEMA = {
  type: "object",
  // the model writes the fields in this order: the reason first, so the action follows from it
  properties: {
    reason: { type: "string", description: "one short sentence, at most 25 words" },
    plan: nullable({ type: "string", description: "your plan over the next rounds, at most 25 words; null keeps the one you have" }),
    action: { type: "string", enum: ["take", "post", "retire", "wait"] },
    curve: nullable({ type: "string", enum: ["buy", "buy_with_data", "sell"] }),
    curveToken: nullable({ type: "string" }),
    curveAmount: nullable({ type: "integer", description: "launch batch only: tokens in your order for curveToken" }),
    curveLimit: nullable({ type: "number", description: "launch batch only: CREDIT per token, the most you pay or the least you take" }),
    orders: nullable({
      type: "array",
      description: "sealed batch only: at most one order per token, each in that token's batch",
      items: {
        type: "object",
        properties: {
          token: { type: "string" },
          side: { type: "string", enum: ["buy", "sell"] },
          amount: nullable({ type: "integer" }),
          limit: nullable({ type: "number" }),
          rounds: nullable({ type: "integer", description: "how many rounds the order stands; null for this round only" }),
          afterSales: nullable({ type: "boolean", description: "a buy paid from what your sells this round bring in" }),
        },
        required: ["token", "side", "amount", "limit", "rounds", "afterSales"],
        additionalProperties: false,
      },
    }),
    cancel: nullable({ type: "array", items: { type: "string" }, description: "tokens whose standing order you take back" }),
    launch: nullable({
      type: "object",
      description: "only when your view's launch.canLaunch is true: a new token of yours on a bonding curve",
      properties: {
        token: { type: "string" },
        supply: { type: "integer" },
        base: { type: "integer" },
        max: { type: "integer" },
        pitch: { type: "string", description: "one sentence the other traders read" },
      },
      required: ["token", "supply", "base", "max", "pitch"],
      additionalProperties: false,
    }),
    offerId: nullable({ type: "string" }),
    give: nullable({ type: "string", enum: ["CREDIT", "DATA"] }),
    giveAmount: nullable({ type: "integer" }),
    wantAmount: nullable({ type: "integer" }),
  },
  required: ["reason", "plan", "action", "curve", "curveToken", "curveAmount", "curveLimit", "orders", "cancel", "launch", "offerId", "give", "giveAmount", "wantAmount"],
  additionalProperties: false,
};

export const SYSTEM_PROMPT = `You are one trader in a small over-the-counter market on the Midnight blockchain. Two shielded tokens are traded against each other: CREDIT and DATA. Prices are quoted in CREDIT per DATA.

Each round you see your goal, your last decision and what became of it, whether the sponsor that settles swaps is ready (when it is not, a take cannot settle this round), what you hold, the most one swap half of yours can give per token, the open offers on the shared offer board, your own open offer if you have one, and the last fills. You make exactly one decision for this round:

- take: accept one open offer from somebody else, by its offerId. You give what the offer wants and receive what it gives. Only take an offer you can pay (its wantAmount within what one half of yours can give and within maxPerOffer) and whose price serves your goal; an offer that expires in less than 90 seconds cannot settle in time.
  When curves are in your view, their buyFromCurve, buyWithData and sellToCurve offers are taken the same way: buying gives CREDIT (or DATA, with buyWithData) for the launched token, selling gives the token back for CREDIT. Each curve trades once per round, and a wallet may hold only so much of each token.
- post: put up one offer of your own. give is the token you hand over, giveAmount how much of it, wantAmount how much of the other token you ask in return. Only when you have no open offer and the board has room (canPost is true).
- retire: take your own open offer off the board, by its offerId, when its price no longer serves you.
- wait: do nothing this round.

Next to that decision you may trade one launched token in the same round: curveToken names it, curve "buy" takes its buyFromCurve offer, "buy_with_data" its buyWithData offer (you pay DATA instead of CREDIT), "sell" its sellToCurve offer; null leaves the curves alone. It does not cost you your main decision. Your temperament and rules in the view are yours: the market refuses anything outside the rules, and inside them you decide like the trader your temperament describes.

When your view has a sealedBatch, the round is a sealed batch auction instead: post hands in your one order for it (see sealedBatch.how), and every order that clears fills at one common price.

When your view has assets, every token trades in a sealed batch of its own against CREDIT, DATA included: orders holds one entry per token you trade this round, { token, side "buy" or "sell", amount tokens, limit CREDIT a token, rounds, afterSales }. Every order goes there, DATA too: action is post when orders has an entry, wait when it is empty, and curve, curveToken, give, giveAmount and wantAmount stay null. One entry per token: two tokens to trade are two entries, the same token twice is refused. For a launched token, null amount and limit take one tranche at the curve's first rung; other traders' orders meet yours before the curve does, so a limit between the curve's buy-back and its sell price can fill. Your portfolio lists every token by its share of your value next to your target: weigh all of them each round, not only DATA.
- rounds lets an order stand up to the number the rules allow; what is not filled carries over, shown in yourStandingOrders. A new order for a token replaces the standing one; cancel takes standing orders back by token. bestOtherSideLastRound is the best limit the other side handed in for that token last round, gapPct how far yours lay from it: a standing order with a gap does not fill until one side moves, so re-price it when the gap is small and the trade still serves you, rather than let it stand unchanged.
- afterSales on a buy pays it from this round's sells: after the first call of the round settles, the buy goes into a second call, cut to the CREDIT you then hold. Selling NOCT and buying ZONE with afterSales changes one for the other in one round. Only where the rules allow it: when your goal says buys are paid from CREDIT you hold, afterSales is refused; then sell first and buy in a later round. A buy you cannot pay from the CREDIT you hold is refused, so with little CREDIT, sell.
- A batch clears only where the sides cross. bestBuyLimitLastRound and bestSellLimitLastRound show where the others stood last round: a limit at or past them fills, one at lastPrice usually does not. When you want the trade this round, price at the other side's best limit inside your band. A standing order of yours with a gapPct under 5 did not fill and will not while it stands unchanged: when the trade still serves you, hand it in again at bestOtherSideLastRound this round rather than keep it; "near the last price" is not a fill.

When your view has launch, you may also start a token of your own: launch names it, sets its supply and its curve's first and last price, and pitches it in one sentence (see launch.how). It is issued by the market and sold on a bonding curve like the others; you get a share of the supply, to hold or to sell. A launch costs you nothing: the market mints the supply into the curve's wallet, and you get the founder's share on top (launch.founderShareWorth says what it is worth at the first price); every token the curve sells after that raises the price of yours. So when launch.canLaunch is true and you have founded no token yet, launch this round or the next, next to your orders: pick a theme no live token covers and say in the pitch what it is for. Leave launch null only when canLaunch is false.

plan is your intent over the next few rounds (what you build up or reduce, and at what prices). yourPlan in the view is the one you set last; keep to it unless the market gave you a reason to change it, and when you trade against it, say why in reason. Last round's crowd is not a reason by itself: when everyone sold, the next batch is full of sellers again.

Amounts are whole token units. giveAmount may not exceed what one half of yours can give for that token, nor maxPerOffer. A swap is settled on chain by a sponsor in one transaction and cannot be undone. Trade toward your goal. An open offer from somebody else that gives what you want at a price inside your band is a good trade: take it rather than wait for a better one. When you post, price near your value, not at the edge of your band: an offer far from the last price rarely fills. If your last offer expired without a taker, its price was too far from the market: move toward the last price. Stay inside your band.

Decide first, then write reason: one short plain sentence in English, at most 25 words, that says why and names the price; then the action that sentence argues for. The reason states the decision; no questions, no second thoughts, no "no, ..." corrections. Taking an offer means giving what it wants: take only offers that give you what you need. Fill unused fields with null.`;

const today = (now) => new Date(now()).toISOString().slice(0, 10);

/** Decisions per trader per UTC day, kept in a file so a restart does not reset them. */
export function fileBudget({ limit, file = LLM_BUDGET_FILE, now = () => Date.now() }) {
  const read = () => {
    try {
      const b = JSON.parse(fs.readFileSync(file, "utf8"));
      return b.day === today(now) ? b : { day: today(now), used: {} };
    } catch { return { day: today(now), used: {} }; }
  };
  return {
    limit,
    left: (name) => limit - (read().used[name] ?? 0),
    spend(name) {
      const b = read();
      b.used[name] = (b.used[name] ?? 0) + 1;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(b));
    },
  };
}

export function fileJournal(file = LLM_JOURNAL) {
  return (entry) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  };
}

/**
 * @param {object} o
 * @param {object} o.client     an Anthropic client (`new Anthropic()`)
 * @param {string} o.model
 * @param {string} o.effort     low | medium | high | xhigh | max
 * @param {{ left(name): number, spend(name): void }} o.budget
 * @param {(entry: object) => void} o.journal
 * @returns {{ decide(view): Promise<object> }}
 *   decide answers `{ id, action, offerId, give, giveAmount, wantAmount, reason, settle(outcome) }`,
 *   or `{ fallback: why }` when the rules run this trader this round.
 */
export function llmBrain({ client, model, effort, budget, journal, now = () => Date.now() }) {
  const format = betaJSONSchemaOutputFormat(DECISION_SCHEMA);

  async function decide(view) {
    const id = crypto.randomUUID();
    const base = { id, ts: new Date(now()).toISOString(), trader: view.name, model };
    if (budget.left(view.name) <= 0) {
      const why = `its daily budget of ${budget.limit} decisions is spent`;
      journal({ ...base, fallback: why });
      return { fallback: why };
    }
    const user = JSON.stringify(view, null, 2);
    const promptHash = crypto.createHash("sha256").update(JSON.stringify({ model, effort, system: SYSTEM_PROMPT, user })).digest("hex");
    budget.spend(view.name);
    let res;
    try {
      res = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        // a declined request is re-run on Anthropic's recommended model instead of returning the refusal; Haiku has no such fallback
        ...(/^claude-haiku/.test(model) ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
        output_config: { effort, format },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
      });
    } catch (err) {
      const why = `Claude did not answer: ${err.message.slice(0, 200)}`;
      journal({ ...base, promptHash, fallback: why });
      return { fallback: why };
    }
    const usage = { input: res.usage?.input_tokens ?? null, output: res.usage?.output_tokens ?? null };
    const served = res.model ?? model;
    const d = res.stop_reason === "end_turn" ? res.parsed_output : null;
    if (!d || !["take", "post", "retire", "wait"].includes(d.action) || typeof d.reason !== "string") {
      const why = res.stop_reason === "refusal" ? "Claude declined to decide" : `Claude's answer was not a decision (${res.stop_reason})`;
      journal({ ...base, servedBy: served, promptHash, stopReason: res.stop_reason, usage, fallback: why });
      return { fallback: why };
    }
    // the sentence sometimes ends in a stray closing brace of the JSON around it, or a line-break tag
    const tail = d.reason.includes("{") ? /\s*(?:<\/?br\s*\/?>\s*)+$/i : /\s*(?:\}|<\/?br\s*\/?>)(?:\s*(?:\}|<\/?br\s*\/?>))*\s*$/i;
    const reason = d.reason.replace(tail, "").trim();
    const orders = Array.isArray(d.orders) ? d.orders.filter((x) => x && typeof x.token === "string" && ["buy", "sell"].includes(x.side)) : null;
    const cancel = Array.isArray(d.cancel) ? d.cancel.filter((t) => typeof t === "string") : null;
    const decision = { action: d.action, plan: typeof d.plan === "string" ? d.plan : null, orders, cancel, curve: ["buy", "buy_with_data", "sell"].includes(d.curve) ? d.curve : null, curveToken: d.curve ? d.curveToken ?? null : null, curveAmount: d.curve ? d.curveAmount ?? null : null, curveLimit: d.curve ? d.curveLimit ?? null : null, offerId: d.offerId ?? null, give: d.give ?? null, giveAmount: d.giveAmount ?? null, wantAmount: d.wantAmount ?? null, launch: d.launch && typeof d.launch === "object" ? d.launch : null, reason };
    return {
      id, ...decision, servedBy: served,
      /** The market reports what it did with the decision; one journal line per decision. */
      settle: (outcome) => journal({ ...base, servedBy: served, promptHash, usage, decision, outcome }),
    };
  }

  return { decide };
}
