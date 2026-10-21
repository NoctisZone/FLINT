/**
 * The read-only feed the arena polls: one in-memory state the gateway
 * updates, served as JSON on a few GET routes. Lists are newest first and
 * take `?since=<ISO timestamp>`; nothing here changes anything.
 */
import http from "node:http";

const KEEP = 2000;

export function feedState({ runStart = new Date().toISOString(), networks = { midnight: "preprod", strike: "testnet" } } = {}) {
  const s = {
    meta: { runStart, networks, strikeMark: null, sponsorReady: null, serverTime: null },
    agents: new Map(),  // agentId → card
    quotes: new Map(),  // quoteId → open quote
    fills: [], decisions: [], refusals: [], proofs: new Map(),
    capital: null, revenue: null,
  };
  const push = (list, item) => { list.unshift(item); if (list.length > KEEP) list.length = KEEP; };
  return {
    setMark: (mark) => { s.meta.strikeMark = mark; },
    setSponsor: (ready) => { s.meta.sponsorReady = ready; },
    agent: (agentId, card) => { s.agents.set(agentId, { agentId, ...(s.agents.get(agentId) ?? {}), ...card }); },
    quoteOpen: (q) => { s.quotes.set(q.quoteId, q); },
    quoteGone: (quoteId) => { s.quotes.delete(quoteId); },
    fill: (f) => push(s.fills, f),
    decision: (d) => push(s.decisions, d),
    refusal: (r) => push(s.refusals, r),
    proof: (agentId, p) => { s.proofs.set(agentId, { agentId, ...(s.proofs.get(agentId) ?? {}), ...p }); },
    capital: (c) => { s.capital = c; },
    revenue: (r) => { s.revenue = r; },
    /** The JSON of one route; `since` filters the lists. */
    get(route, since) {
      const after = since ? Date.parse(since) : null;
      const recent = (list) => (after ? list.filter((x) => Date.parse(x.ts) > after) : list);
      switch (route) {
        case "meta": return { ...s.meta, serverTime: new Date().toISOString() };
        case "agents": return { agents: [...s.agents.values()] };
        case "quotes": return { quotes: [...s.quotes.values()].sort((a, b) => (a.expiresAt < b.expiresAt ? 1 : -1)) };
        case "fills": return { fills: recent(s.fills) };
        case "decisions": return { decisions: recent(s.decisions) };
        case "refusals": return { refusals: recent(s.refusals) };
        case "proofs": return { proofs: [...s.proofs.values()] };
        case "capital": return s.capital ?? { deposits: [], asOf: null };
        case "revenue": return s.revenue ?? { calls: 0, lovelace: "0" };
        default: return null;
      }
    },
  };
}

/** Serve `state` on /feed/<route>; resolves to the server, `port` 0 picks a free one. */
export function feedServer(state, { port = 4481, host = "127.0.0.1" } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const m = url.pathname.match(/^\/feed\/([a-z]+)$/);
    const body = req.method === "GET" && m ? state.get(m[1], url.searchParams.get("since")) : null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
