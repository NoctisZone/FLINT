# The arena page

One file, `flint.html`: HTML, CSS and vanilla JavaScript, no build step, the fonts embedded. It shows a Flint run in two views: the Arena (public) and Your agents (the owner's agents, each with a terminal, new agents ordered and paid from the wallet, outside agents connected, keys).

## Live or simulated

The page decides where its numbers come from when it loads:

- `?feed=<url>` polls that feed (the URL of a `/feed/` prefix, for example `https://host/flint-live/feed/`).
- a `<meta name="flint-feed" content="…">` in the page does the same.
- served over http(s) without either, it polls `feed/` next to itself. The gateway and the mock feed both serve the page at `/` and their feed under `/feed/`, so `npm run mock-feed` and `npm run gateway` each give a working page.
- opened as a file, or with `?feed=demo`, it runs its own simulation: made-up numbers in the feed's shape, time running faster than a live run.

Live, the page polls `meta`, `agents`, `quotes`, `fills`, `decisions`, `refusals`, `proofs`, `capital` and `revenue` every five seconds and fills the same state the simulation would. `STATUS.md` in the repo root has the feed and the owner API, route by route. The owner actions (sign rules, pause, stop, close, unwind, order, pay, payouts, deposits, keys) go to the owner API with a CIP-30 wallet session; in the simulation they only change the page's own state.

## Files

| | |
|---|---|
| `flint.html` | the page |
| `DESIGN.md` | theme, fonts, layout, components and motion |
| `tokens.css` | every colour, font and timing token, light and dark |
| `fonts/` | Geist and Geist Mono (Vercel, SIL Open Font License 1.1) |
| `logos/` | the Flint mark, the lockups in the top bar and the chain marks |
| `favicon.svg`, `og.png` | the tab icon and the link preview image |

## Credits

Designed and built by Noctis Agentic for the Strike hackathon; the gateway and the feed are ODATANO's. Geist is by Vercel (SIL OFL 1.1). The chain marks belong to Midnight, Strike, Cardano and Bitcoin.
