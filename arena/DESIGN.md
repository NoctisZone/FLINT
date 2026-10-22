# FLINT: theme, fonts and design

The look is an instrument panel on a measured grid. A live agent network opens the page as its one bold moment. Every other panel is a quiet, precise readout. Light and dark are both designed; neither is an inverted copy of the other.

All values below come from `flint.html` and `tokens.css`. If you change one, change it there, never inline.

## 1. Colour

### Ground and ink

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F1F2F5` | `#07080A` | page ground |
| `--surface` | `#FFFFFF` | `#0E1014` | cards |
| `--surface-2` | `#F7F8FA` | `#13161B` | wells inside cards: charts, timers, hashes |
| `--well` | `#EEF0F4` | `#0A0C0F` | segmented-control track |
| `--line` / `--line-2` | `#E0E3E9` / `#C8CED7` | `#1D2127` / `#2B3139` | dividers / control borders |
| `--ink` | `#0A0C10` | `#ECEFF3` | text, primary buttons, card corner marks |
| `--t2` `--t3` `--t4` | `#2A303B` `#4A5363` `#5F6879` | `#C3C9D3` `#9CA5B3` `#828C9C` | body, secondary, labels |

### Signals

Each colour means one thing everywhere: dots in the network, chips, chart lines and the leaderboard.

| Token | Light | Dark | Means |
|---|---|---|---|
| `--pink` | `#D4007A` | `#FF2FB0` | the brand, the agents, paid calls, "yours" |
| `--cyan` | `#007F98` | `#00E5FF` | actions on Midnight: offers and takes |
| `--orange` | `#CC5200` | `#FF7A1A` | hedges on Strike, Strike's price, Bitcoin |
| `--yellow` | `#8F6A00` | `#FFD400` | Claude, warnings, unsigned changes |
| `--green` | `#00845B` | `#00FFA3` | proved, earned, within limits |
| `--red` | `#CC1D47` | `#FF5C7A` | refused, losses, stop |

Light signals are deepened so they read on white. Keep that pairing; don't reuse the dark values on light.

### The chains in the agent network

| Node | Colour | Tile |
|---|---|---|
| Midnight | `--mid-c` `#FFFFFF` | dark tile `#0E1014` in both themes, so the white mark shows on a light page |
| Strike | `--strike-c` `#26FAB0` (Strike's green) | dark tile, as Midnight |
| Cardano | `--cblue` `#1F5FC4` light / `#5B8EF0` dark | the card surface |
| Bitcoin | `--orange` | the card surface |

The marks are one-colour images used as CSS masks, painted with `currentColor`: `.lgm{background:currentColor; mask-image:url(...)}`. That's how one file takes any colour. The files are in `logos/chains/`.

### How the theme works

- `html[data-theme="light"|"dark"]` forces a theme. Without it, `prefers-color-scheme` decides.
- The theme button cycles system → light → dark and keeps the choice in `localStorage` under `flint-v3-theme`.
- Canvases (network, price chart, terminal chart) read the tokens at draw time (`readTokens()`) and redraw when `data-theme` changes. Never hard-code a colour in canvas code: read the token.

## 2. Type

Two families, both variable, both in `fonts/` and embedded in `flint.html`:

- **Geist** for the interface: sentences, titles, buttons and the thin display numbers.
- **Geist Mono** for every measured value and every label: prices, sizes, times, hashes, eyebrows and table heads.

| Role | Setting |
|---|---|
| Body | Geist 400, 15px/1.55 |
| Hero headline | Geist 300, `clamp(38px, 5vw, 66px)`/1.02, letter-spacing −0.045em; the emphasis in Geist 500, pink |
| Section headline (Console) | Geist 300, `clamp(32px, 4.4vw, 54px)`, −0.045em |
| Big numbers (scoreboard, terminal) | Geist 300, 46px (scoreboard) / 30px (terminal bar), −0.05em, `font-variant-numeric: tabular-nums` |
| Card title | Geist 500, 15px, −0.01em |
| Labels and eyebrows | Geist Mono 500, 10.5–11px, uppercase, letter-spacing 0.12–0.16em, `--t4` |
| Values in tables | Geist Mono 400, 12.5px, tabular figures |

Thin numbers are the signature: big values are Geist 300, never bold. Every number that changes uses tabular figures, so it doesn't jitter.

## 3. Layout

- **Width:** content sits in `.wrap`, max 1280px, side padding `max(16px, safe-area)`.
- **Ground:** a measured grid behind everything: 48px lines at 5% ink, faded out from the top with a radial mask.
- **Top bar:** sticky, frosted glass (`--glass` plus `backdrop-filter: blur(14px) saturate(140%)`).
  - Left: FLINT, then "by", the ODATANO logo, "&" and the Noctis Agentic lockup.
  - Right: the view switch, the Simple/Pro switch, the theme, motion and the tour.
- **Strip:** under the top bar, a strip says it's a prototype with made-up numbers.
- **Rhythm:** 20px between cards; card headers 14px × 18px; card bodies 14px 18px 18px.
- **Breakpoints:**
  - **1200px:** the terminal's stats wrap smaller.
  - **1000px:** every two- or three-column grid becomes one column.
  - **760px:** leaderboard rows become two-column cards.
  - **700px:**
    - the top bar wraps and stops sticking;
    - help windows and the tour become bottom sheets;
    - the agent drawer goes full width.
- **Phones:** no horizontal page scroll, ever. Wide tables scroll inside their own card.

## 4. Components

- **Card:**
  - 3px radius, a 1px `--line` border and the `--shadow` token;
  - HUD corner marks: 9px ink ticks at top-left and bottom-right, at 55% opacity, drawn by `.card::after`.
- **Card header (`.ch`):**
  - left: a 26px ring icon in the panel's signal colour, then the title;
  - right: a mono uppercase note and a round **?** button that opens the panel's help.
- **Scoreboard tile (`.kpi`):**
  - a 2px accent bar at the top in its signal colour;
  - when the value changes, the bar sweeps across and the number flashes its colour (`bump`).
- **Segmented control (`.seg`):**
  - a pill track with a thumb that slides to the pressed button;
  - call `thumbs()` after showing a hidden one, because it measures widths.
- **Buttons (`.btn`):** pill-shaped, min-height 36px (`big` is 44px, `sm` is 32px). Variants:
  - `primary`: ink fill;
  - `glow`: pink fill, for the one main action;
  - `cyan`: wallet and money actions;
  - `danger`: red outline, filled on hover.
- **Chip (`.chip`):** mono uppercase, tinted with its colour at 9% and bordered at 30%; `.dot` adds a status dot.
- **Key-value row (`.kv`):** a label left in `--t3` and a value right, with a hairline above.
- **Windows:**
  - help (`.pop`) and glossary words (dotted pink underline) open small windows;
  - an agent's card opens in a right-hand drawer;
  - confirmations (wallet, stop agent) open in a centred modal;
  - toasts appear at the bottom.
- **Avatars:** each agent's face is a sigil drawn from its name (`avatar(seed)`), the same every time. A new agent gets its face from the name you type.

## 5. Motion

- **Easing:** `--ease: cubic-bezier(.2,0,0,1)` for state changes and `--out: cubic-bezier(.16,1,.3,1)` for things arriving. Most transitions run 0.25 to 0.6 s.
- **Lists:**
  - list items enter (grow and fade in) and leave (shrink away) by key (`keyed()`);
  - leaderboard rows slide to their new rank;
  - numbers count up (`tween()`).
- **One animation loop:** a single `requestAnimationFrame` loop (`frame()`) drives:
  - the network's packets;
  - the trade lane's comet;
  - the charts;
  - the dial needles (on springs);
  - the offer timers.
- **The Motion switch** adds `.still` to `<html>`, which stops every CSS animation. Canvases then redraw once a second. Motion starts off when the system asks for reduced motion. The choice is saved under `noctis-agentic-view`.

## 6. Words

- Plain sentences, in present tense.
- The page explains instead of naming things: "rules its owner signed" rather than "mandate"; "proof on Midnight" rather than "attestation".
- **Pro** mode swaps in the exact terms: mandate field paths (`risk.hedgeWithinSec`), bps, tool names, client order ids and hashes.
- Every panel has a **?** with three parts: what it is, how to read it, and why it matters.
- Five words have their own glossary windows: hedge, rules, proof, sponsor and netting.
- Buttons say what happens: "Sign 2 changes with your wallet", "Stop MM Rule".
- Demo actions say "(demo)", because nothing on the page acts for real until the owner API exists.

## 7. Logos

- **Top bar:**
  - **FLINT** in Geist Mono 600, letter-spaced 0.22em, after a small ring mark with a pink centre;
  - then "by", the ODATANO logo, "&" and the Noctis Agentic lockup;
  - each logo comes in two files, swapped by theme: `logos/odatano-nav-on-dark.svg` / `-on-light.svg` and `logos/noctis-agentic-on-dark.svg` / `-on-light.svg`.
- **The ODATANO logo** is your brand file with the small tagline line removed: at 30px it can't be read. Swap in the full file if you prefer.
- **The Noctis Agentic lockup** is the brand kit's logo, cropped to its drawing.
- **Chain marks:** `logos/chains/` holds the white marks used as masks. `strike.svg` is Strike's disc with its symbol cut out, one colour.
