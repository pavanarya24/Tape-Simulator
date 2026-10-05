# Tape Reading Academy — Project Handoff

Last updated: this conversation, build size 4,134 lines / ~253 KB single HTML file.

## What this is

A single self-contained `index.html` file — an interactive order-flow and tape-reading
course, built to eventually run as a real, publicly hosted learning site (GitHub Pages),
not just a chat artifact. No build step, no server, no external dependencies beyond
Google Fonts and a CDN font stylesheet. Everything — content, charts, quizzes, the
scoring engine — is plain HTML/CSS/JavaScript in one file.

**Live locations right now:**
- Claude artifact (working copy, edited live in this chat): the published link in this conversation
- Downloadable deploy-ready package: `tape-reading-academy-site.zip` (contains `index.html`,
  `videos/` folder with a naming-convention README, and a root `README.md` with GitHub Pages
  deploy steps)
- NotebookLM source document (for generating audio/video overviews): `tape-reading-academy-source.md`

## Curriculum — 18 lessons, six units

| Unit | Lessons | Theme |
|---|---|---|
| Foundations | 1–5 | Bid/ask, tape colour, imbalance, breakout mechanics, absorption |
| Reading Participation | 6–8 | Spoofing, context filters, risk/account rules |
| Context and Structure | 9–11 | Auction theory (value area/POC), Wyckoff (springs/upthrusts), dealers/adverse selection |
| Application | 12–13 | Process over outcome, cross-framework cheat sheet |
| Quant Lab | 14–16 | Order flow imbalance & Kyle's lambda, statistics of your edge (confidence intervals), Kelly sizing |
| Order Flow Instruments | 17–18 | Footprint charts & CVD divergence taxonomy, order types/participants/market suitability |

Every lesson has: at least one custom SVG diagram (26 total across the course, all
hand-built to match real generated data — see "Numbers are real" below), a "what it
tells you / what it doesn't" split box on higher-stakes concepts, a "common mistake"
callout, a "key takeaways" list, an explicit "mark complete" button (progress isn't
auto-tracked from merely opening a lesson), and prev/next navigation.

## Interactive tools (beyond reading)

- **Charts tab** — procedurally generates a candlestick chart containing one of 5
  patterns (spring, upthrust, absorption, initiative break, responsive fade), with a
  live 2D volume profile, a rotatable 3D volume profile, a VWAP overlay, and a live
  **CVD (Cumulative Volume Delta) panel** underneath — genuinely computed per-bar
  aggressor-classified delta, engineered so each pattern produces the textbook-correct
  divergence signature (verified numerically, see below).
- **Walkthrough tab** — 5 narrated, autoplaying episodes (one per pattern), each on a
  fixed, hand-verified random seed so the chart always resolves cleanly and every
  number mentioned in the captions (price levels, direction) is checked against the
  actual generated data.
- **Drill tab** — timed pattern-ID quiz on generated charts, difficulty ramps with
  streak, weighted toward whatever pattern the user keeps missing, daily-seeded mode.
- **Trading Desk tab** — chart stops mid-pattern; user commits Long/Short/Pass with a
  real Level-2 ladder and last-10-prints tape shown at the decision point; fixed $25
  risk, 2R target; ~30% of "clean-looking" setups fail on purpose (calibrated and
  verified — trading the correct read nets ~+0.5R expectancy over 1,200 simulated
  trades, not a guaranteed win); three-losing-R daily lockout is enforced, not just
  suggested; every trade is journaled with a VWAP-alignment tag.
- **Tape Simulator tab** — 5 scripted Level-2/tape scenarios (A–E, increasing
  difficulty) with live coach captions, rendered as real candlesticks (not a line
  chart) with wick size scaled to actual traded volume in that scenario frame; ends
  each scenario with a comprehension check tied to what just happened.
- **Your Data tab** — paste real OHLCV CSV (Stooq/Yahoo/broker export format), get the
  same chart/profile engine and a bar-by-bar replay control.
- **Report Card tab** — rank/XP breakdown, 8 badges, a full Kelly/confidence-interval
  statistics panel computed from the user's own logged desk trades (mean R, standard
  deviation, 95% CI, plain-language significance verdict), VWAP-bias performance
  comparison, per-pattern breakdown, and a downloadable CSV journal export.
- **Leaderboard tab** — uses this conversation's `db` and `user` capabilities for a
  real cross-organization leaderboard (ranked by XP, and separately by desk
  expectancy among traders with ≥20 logged trades). Degrades gracefully to an
  explanatory message when viewed standalone or outside an organization — nothing
  else on the page depends on it working.
- **Quiz tab** — 15 questions with instant feedback, spanning the full curriculum
  including the new CVD/footprint/instrument content.
- **Library tab** — public-domain texts (Wyckoff, Lefèvre, Selden), modern books,
  academic papers, and honest notes on free vs. paid data sources.

## Numbers are real, not decorative

Several things in this build were specifically engineered and then *verified with
Node scripts before publishing*, not just written and hoped to be right:
- The chart generator's per-pattern outcomes were fuzz-tested (hundreds of runs) to
  confirm OHLC validity and no NaN/broken bars.
- Five specific random seeds were searched for and locked in for the Walkthrough
  episodes — chosen because they produce a *clean, textbook* resolution (the
  generator does have ~30% failure built in, which is correct for the Drill/Desk but
  wrong for a first-watch tutorial), then every dollar figure and direction in the
  captions was checked against the actual generated data.
- The per-bar CVD delta engineering was checked bar-by-bar around each pattern's
  decision point to confirm it produces the *correct* divergence signature (classic
  bullish/bearish, absorption-based, confirming, weak) for each of the 5 patterns.
- The Trading Desk's win-rate/expectancy was measured over 1,200 simulated trades
  before publishing (reading the pattern correctly nets ~+0.5R, not a sure thing).
- The Report Card's confidence-interval math (mean, SD, SE, 95% CI) was run against
  mock data in Node before shipping.

This matters for anyone continuing the project: if you ask for a new pattern type or
a new scripted scenario, the same discipline should apply — verify the generated
numbers match whatever the surrounding prose claims, in Node, before publishing.

## Rank, XP, and badges

Single source of truth: `computeProgress()` (search for it in the file) reads
directly from localStorage every time — nothing is stored as a pre-computed derived
number. XP = lessons read × 45 + min(best drill streak, 25) × 8 + clamped total desk
R × 4 + quiz-correct × 9 + desk wins × 3 + badges × 25. Six ranks (Observer through
Desk Head). Eight badges, each a pure function of the same state object — see the
`BADGES` array.

## localStorage keys in use

`tra_lessons_read`, `tra_best`, `tra_miss`, `tra_journal`, `tra_lockouts`,
`tra_quiz_correct`. All namespaced with `tra_` prefix; safe to clear individually if
ever debugging.

## Video slot system (built, waiting on content)

Every lesson has a `<video>` element wired to look for `videos/lesson-NN.mp4` (01
through 18) relative to wherever `index.html` is served from. Inside the claude.ai
artifact preview, all 18 stay invisible (correct — no such folder exists there). The
same markup lights up automatically the instant real files with those exact names
sit next to the page — including once deployed to GitHub Pages. See
`videos/README.md` in the zip for the exact filename-to-lesson mapping. **This is the
main outstanding item** — the user is generating these via NotebookLM and will hand
them to Claude to trim/rename/place.

## Why some things can't run inside the claude.ai artifact preview

Published Claude artifacts run in a locked-down sandbox: no external embeds, no
network requests to arbitrary hosts, everything self-contained in one file. This is
**specific to claude.ai's hosting** and does not apply once deployed elsewhere (e.g.
GitHub Pages). That's why the video slots stay silent here but are already built to
work the moment real files exist alongside the page on a real host. Real embedded
PDFs, external video players, etc. all become possible post-deployment — they were
not possible to test/ship inside this chat.

## Deploying to GitHub Pages

Full instructions are in the zip's root `README.md`. Short version: new public repo →
upload `index.html` + `videos/` folder + `README.md` to repo root → Settings → Pages →
Deploy from branch → main → / (root) → Save. Live URL within ~1 minute, typically
`https://<username>.github.io/<repo>/`.

## Known open items / next steps

1. **Video files** — waiting on the user to generate via NotebookLM (steering prompt
   and source doc already provided) and hand them over, or place them manually per
   `videos/README.md`.
2. Diagram coverage is now complete (every lesson has ≥1 SVG), but only Lessons 7,
   8, 11, 14, 15, 16 got the newest "second pass" treatment — if the visual bar
   should be raised further on any specific lesson, say which one rather than a
   blanket "redo everything" to keep quality controllable.
3. The course map on Home is clickable but currently only jumps to the *first*
   lesson of each unit — could be extended to a per-lesson visual atlas if wanted.
4. No mobile-specific testing has been done beyond the responsive CSS breakpoints
   already in place (`@media max-width:880px` etc.).

## If you're a developer picking this up cold

Open the file, search for the numbered section comments (`/* ====... 1. RANDOMNESS
====... */` etc.) — the whole file is organized into ~15 clearly labeled sections in
order of dependency (RNG → chart generator → volume profile → canvas renderer →
Charts tab → Drill → Desk → CSV replay → Tape sim → Quiz → lesson progress → XP/rank
→ Leaderboard → Walkthrough → init/resize). Nothing requires a build step; edit and
reload.
