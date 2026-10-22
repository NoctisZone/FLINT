/**
 * The agents' tools as an MCP server: what any outside mind (Claude, Hermes,
 * a script) gets to do, and nothing more. Every tool runs through the
 * gateway's port for one agent, so every action meets the same checks as
 * the gateway's own minds. Owner tools (set_mandate, kill, resume) are not
 * here on purpose.
 *
 * A port is what gateway.mjs `portFor(agentId)` returns; the test hands in
 * a stand-in and talks to the server over an in-memory transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const text = (x) => ({ content: [{ type: "text", text: JSON.stringify(x, null, 2) }] });
const reason = z.string().min(3).max(200).describe("one sentence why");

/** @param {object} port  the agent's port: mandate(), market(), account(), preview(a), postQuote(q, reason), takeQuote(id, reason), placeOrder(o, reason), hedge(), cancelAll(), closePosition(reason) */
export function toolServer(port, { name = "flint-agent", version = "0.1.0" } = {}) {
  const server = new McpServer({ name, version });
  const run = (fn) => async (args) => { try { return text(await fn(args)); } catch (err) { return { ...text({ error: err.message }), isError: true }; } };

  server.registerTool("get_mandate", { description: "The mandate the owner signed for this agent and the room left under each limit, on both venues." }, run(() => port.mandate()));
  server.registerTool("get_market", { description: "Strike mark price and funding of the agent's market (or of `symbol`), every market it trades, and the open quotes on the Midnight board.", inputSchema: { symbol: z.string().optional() } }, run((x) => port.market(x)));
  server.registerTool("get_account", { description: "Midnight holdings and free coins, Strike position, net delta, what is unhedged, whether the agent is frozen." }, run(() => port.account()));
  server.registerTool("preview_action", {
    description: "Dry run: would this action pass the mandate? Returns the refusal with rule, limit and attempted value, or ok.",
    inputSchema: { venue: z.enum(["strike", "midnight"]), kind: z.enum(["order", "quote", "take"]), side: z.enum(["buy", "sell", "bid", "ask"]), sizeBtc: z.number().positive(), price: z.number().positive().optional(), ttlSec: z.number().int().positive().optional(), symbol: z.string().optional(), pair: z.string().optional() },
  }, run((a) => port.preview(a)));
  server.registerTool("post_quote", {
    description: "Build and post a quote on the Midnight board: a bid buys the base asset, an ask sells it. Size in the base asset, price in USD per unit; `pair` picks the market for an agent on several. Refused outside the mandate.",
    inputSchema: { side: z.enum(["bid", "ask"]), sizeBtc: z.number().positive(), price: z.number().positive(), ttlSec: z.number().int().positive().optional(), pair: z.string().optional(), reason },
  }, run(({ reason: why, ...q }) => port.postQuote(q, why)));
  server.registerTool("take_quote", {
    description: "Take a quote off the Midnight board by id and hand the swap to the sponsor; resolves when it lands or fails.",
    inputSchema: { quoteId: z.string().min(8), reason },
  }, run(({ quoteId, reason: why }) => port.takeQuote(quoteId, why)));
  server.registerTool("place_order", {
    description: "A Strike order on the mandate's market (`symbol` picks one for an agent on several): limit with a price, market without. Accepted is not filled; watch get_account.",
    inputSchema: { side: z.enum(["buy", "sell"]), sizeBtc: z.number().positive(), price: z.number().positive().optional(), symbol: z.string().optional(), reason },
  }, run(({ reason: why, ...o }) => port.placeOrder(o, why)));
  server.registerTool("hedge", { description: "Hedge everything the agent holds unhedged with one Strike order that reduces net delta. Always allowed." }, run(() => port.hedge()));
  server.registerTool("cancel_all", { description: "Cancel the agent's open Strike orders and retire its open quotes." }, run(() => port.cancelAll()));
  server.registerTool("close_position", { description: "Close the agent's whole Strike position with a reduce-only market order. Always allowed.", inputSchema: { reason } }, run(({ reason: why }) => port.closePosition(why)));
  return server;
}
