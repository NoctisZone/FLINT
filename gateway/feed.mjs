/**
 * The read-only feed the arena polls: one in-memory state the gateway
 * updates, served as JSON on a few GET routes. Lists are newest first and
 * take `?since=<ISO timestamp>`; nothing here changes anything. The same
 * server hands out the arena page and its files from `staticDir`.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const KEEP = 2000;

/**
 * @param {object} [o]
 * @param {Record<string, Array<{t: string, p: number}>>} [o.marks]   each market's recent marks from the last run, so a chart carries on across a restart
 * @param {(marks: Record<string, Array<{t: string, p: number}>>) => void} [o.onMarks]   called after every setMarks with the rings to keep
 */
export function feedState({ runStart = new Date().toISOString(), networks = { midnight: "preprod", strike: "testnet" }, marks: savedMarks = null, onMarks = () => {} } = {}) {
  const s = {
    meta: { runStart, networks, strikeMark: null, sponsorReady: null, strikeLiquidity: null, midnightBoard: "server", attestEveryMs: null, tools: null, owner: false, orders: null, marks: [], markets: {}, serverTime: null },
    agents: new Map(),  // agentId → card
    quotes: new Map(),  // quoteId → open quote
    fills: [], decisions: [], refusals: [], proofs: new Map(),
    capital: null, revenue: null,
  };
  // the last run's marks carry on: a chart is full on the first poll and the line does not start from nothing after a restart
  if (savedMarks) for (const [sym, ring] of Object.entries(savedMarks)) if (Array.isArray(ring) && ring.length) s.meta.markets[sym] = { mark: ring[ring.length - 1].p, funding: null, marks: ring.slice(-240) };
  if (s.meta.markets["BTC-USD"]) { s.meta.strikeMark = s.meta.markets["BTC-USD"].mark; s.meta.marks = s.meta.markets["BTC-USD"].marks; }
  const push = (list, item) => { list.unshift(item); if (list.length > KEEP) list.length = KEEP; };
  return {
    /** The mark now, and the last two hours of marks for a chart that is full on the first poll. */
    setMark: (mark) => { s.meta.strikeMark = mark; if (typeof mark === "number" && mark > 0) { s.meta.marks.push({ t: new Date().toISOString(), p: mark }); if (s.meta.marks.length > 240) s.meta.marks.shift(); } },
    /** Every market's mark and funding at once (symbol → { mark, funding }); BTC-USD also fills `strikeMark` and `marks` for older readers. */
    setMarks: (marks) => {
      const t = new Date().toISOString();
      for (const [symbol, m] of Object.entries(marks)) {
        if (!(typeof m?.mark === "number" && m.mark > 0)) continue;
        const slot = s.meta.markets[symbol] ??= { mark: null, funding: null, marks: [] };
        slot.mark = m.mark; slot.funding = m.funding ?? null;
        slot.marks.push({ t, p: m.mark }); if (slot.marks.length > 240) slot.marks.shift();
      }
      if (marks["BTC-USD"]?.mark) { s.meta.strikeMark = marks["BTC-USD"].mark; s.meta.marks = s.meta.markets["BTC-USD"].marks; }
      onMarks(Object.fromEntries(Object.entries(s.meta.markets).map(([sym, slot]) => [sym, slot.marks])));
    },
    setSponsor: (ready) => { s.meta.sponsorReady = ready; },
    /** Who stands on the other side of the hedges on a venue without a market maker; null when it is the real book. */
    setLiquidity: (note) => { s.meta.strikeLiquidity = note; },
    /** Where quotes wait for their taker: "server" (the offer board) or "gateway" (this process hands the halves over). */
    setBoard: (kind) => { s.meta.midnightBoard = kind; },
    /** How often a window attestation is made, so the page can count down to the next one. */
    setAttestEvery: (ms) => { s.meta.attestEveryMs = ms; },
    /** The public tools endpoint and its x402 prices in lovelace, for the page's "connect an agent". */
    setTools: (t) => { s.meta.tools = t; },
    /** Whether /owner/ answers next to the feed. */
    setOwner: (on) => { s.meta.owner = Boolean(on); },
    /** What a new agent costs its owner: fee by mind, tools key, the smallest deposit, where the fee goes; null when orders are off. */
    setOrders: (o) => { s.meta.orders = o; },
    agent: (agentId, card) => { s.agents.set(agentId, { agentId, ...(s.agents.get(agentId) ?? {}), ...card }); },
    /** A cancelled order leaves the Arena. */
    agentGone: (agentId) => { s.agents.delete(agentId); },
    quoteOpen: (q) => { s.quotes.set(q.quoteId, q); },
    quoteGone: (quoteId) => { s.quotes.delete(quoteId); },
    fill: (f) => push(s.fills, f),
    /** The hedge that closed a Midnight fill, once it is known; a fill the feed never saw is ignored. */
    fillHedged: (quoteId, hedge) => { const f = s.fills.find((x) => x.quoteId === quoteId && x.midnight); if (f) f.hedge = hedge; },
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

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8" };

/** A file of the arena folder for a request path; null outside the folder or when there is none. `/` is the page. */
function staticFile(dir, pathname) {
  const rel = pathname === "/" || pathname === "/index.html" ? "flint.html" : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(dir, rel);
  if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { file, type: TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" };
}

/** Serve `state` on /feed/<route> and, with `staticDir`, the arena page at / and its files; resolves to the server, `port` 0 picks a free one. */
export function feedServer(state, { port = 4481, host = "127.0.0.1", staticDir = null, handlers = [] } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    // the owner API and anything else mounted next to the feed takes its paths first
    for (const h of handlers) { try { if (await h(req, res)) return; } catch (err) { if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: err.message })); } return; } }
    const m = url.pathname.match(/^\/feed\/([a-z]+)$/);
    if (req.method === "GET" && m) {
      const body = state.get(m[1], url.searchParams.get("since"));
      res.writeHead(body ? 200 : 404, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
      return res.end(JSON.stringify(body ?? { error: "not found" }));
    }
    const f = req.method === "GET" && staticDir ? staticFile(staticDir, url.pathname) : null;
    if (f) {
      res.writeHead(200, { "content-type": f.type, "cache-control": f.type.startsWith("text/html") ? "no-store" : "public, max-age=3600" });
      return fs.createReadStream(f.file).pipe(res);
    }
    res.writeHead(404, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
