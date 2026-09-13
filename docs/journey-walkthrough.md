# Journey walkthrough: OpenBook, the live page

Driven against the deployed page (https://openbook.litai.ca) on 2026-09-12, in headless
Chrome and in a real browser. Every journey is keyed to observable evidence: a transaction
hash, a subgraph row, or a measured value. The scripted half of this is
`scripts/app-audit.mjs` (20 assertions, all passing on the live domain at submission).

## J1: zero-context judge, cold load (no wallet, no keys)

- Hero: the headline, one paragraph that sells the problem (no refund, no dispute, nobody
  to call) and the console, open, with a clean tape and six chips as the call to action. ⌘K focuses it; the market's Buy buttons run `buy <dataset>` in it.
- Top bar: "Connect wallet" (browser wallet on Arc testnet). Connected, the console buys
  from that wallet: createJob, approve and fund are signed in the wallet, the seller quotes
  through the server, the receipt links every transaction to ArcScan. A dismissable banner
  points to the Arc faucet for testnet USDC.
- Below: the market ticker strip as a teaser with "Open the market", the button-driven Try
  section (defaults to Overtime sports odds) and How it works. The market is its own dark
  page at `#market`: ticker strip (protocol fee tooltip on its header), order book, trades tape.
- Data arrives through the same-origin `/api/subgraph` proxy (20 s cache, stale copy on
  a Studio 429) and from ENSv2 Sepolia and the Arc RPC. Nothing is typed in; a failed
  source renders its reason in place ("could not be read right now"), never a fake value.
- Verified at 1280, 390 and 320 wide: no horizontal scroll, headline and primary button
  inside a 640 px tall phone screen.

## J2: buy a query (the happy path)

- Pick a dataset; the line under it reads the live ENS price and freshness promise
  ("0.15 USDC per query · fresh within 50 blocks (about 13 seconds) · sold by openbook.eth").
- Click Buy. Six rows land in about 25 s: price read from ENS, paid into escrow (job id,
  floor, tx), data delivered (indexed block), freshness checked (attest tx), settled
  (settle tx), fee split (98% seller, 2% treasury, derived from the receipt).
- Evidence: job 49 on Aave (settle tx `0xd95df8fa…502706`, split 0.147 / 0.003), job 50
  on OpenSea (Ethereum chain, 10-minute window), both settled.

## J3: make it fail (the refund)

- Click Make it fail. The data is delivered first, then the job is funded with the floor
  one block above the delivered block, the hook refuses `complete()` (`SlaNotMet`, shown
  in the verdict row), and `reject()` refunds the buyer in full. Five rows, about 30 s.
- The hero receipt switches to this refund ("confirming" until the subgraph indexes it);
  the board shows the row at the top.
- Evidence: job 48 (`0x6f35cb69…b731b1`), job 52 (`0xa589ed…1c093e`).

## J2c / J3c: the same two runs from the console (the agentic path)

- Or say it: "get me the odds for Charlotte 49ers vs Western Carolina, max 10 cents" → the model
  proposes `buy overtime-sports-odds --match "Charlotte 49ers" --max 0.10`, the console asks
  "How fresh does the data need to be?", "under 10 seconds" answers it and one receipt
  prints the match and its odds, fund, submit and the verdict (job 114, 2026-09-13); "now get me the same data but no older than a tenth of a second" is a real purchase
  with a window no seller can meet: the data is fetched first, the floor is the chain head at
  that instant minus the window, the delivery lands below it and the contract refuses and
  refunds (job 115, data 3.5 s old, window 0.1 s, the window measured against the clock); "make the same purchase fail on purpose"
  still runs the staged `sandbox stale` (job 109); "show all available data markets" runs
  `datasets`. Read-only questions run at once; a purchase waits only for the freshness answer.
- Open the console (`⌘K` or the footer link). The chips under the tape are the walk:
  "How fresh is the sports data?" runs `quote overtime-sports-odds` (price and window read
  from ENS, the floor computed from the Arbitrum head); "Buy the next UFC card's odds" runs
  `buy overtime-sports-odds` through the Circle buyer wallet (the receipt names both
  wallets and the sponsored gas). After each receipt the chips change to the next move:
  `deliver` (the seller's Circle wallet submits the signed delivery), then `settle` (the
  attester posts the proof and the escrow pays: verdict APPROVE, split 0.098 / 0.002 read
  from the receipt), then `replay 101` and `books`.
- "Refuse a stale delivery (demo)" runs `sandbox stale overtime-sports-odds`: delivery
  first, the floor one block above it, fund, submit, attest; the hook refuses with
  `SlaNotMet(attested, floor)` and `reject()` refunds in the same request. The chips then
  lead to the replay and `jobs --state refunded`.
- Evidence (2026-09-12): job 101 settled (`0x8e016a9e…7966035f`), job 103 refunded
  (`0xbdc9…8a81`), both driven from the console with no key in the browser.

## J4: the market

- Two seller cards from live ENS (`openbook.eth`, `alpha.openbook.eth`) with per-dataset
  prices, the freshness promise, purchases / settled / refunded from the subgraph's
  provider stats (labeled when served from cache or the build-time snapshot), operator link.
- The protocol-fee line reads `platformFeeBP` and the treasury address from the escrow.

## J5: the books

- Four figures (settled, refunded, protocol fees, treasury balance), the settlement board
  (12 latest jobs, seller name or dataset, outcome badge, tx or replay link), the
  treasury's refusals (`PolicyBlocked` rows with tx links).
- Session runs appear immediately and lose their "confirming" label once the v0.0.8
  subgraph indexes them (verified for jobs 48, 49, 50).

## J6: secondary surfaces

- Replay theater from any board row (`#theater/<jobId>`), the system map (`#map`), and
  the console (`⌘K`, or the footer link on desktop): `help` lists 19 commands, `quote`
  renders the ENS price and floor.

## Accessibility and motion (measured)

- Text contrast ≥ 4.5:1 on both grounds after the muted token was darkened (5.0 and 5.4).
- Every control shows a 2 px focus ring under real Tab key presses; tab order follows
  reading order.
- Four transitions and three keyframe animations, one easing family, none on layout
  properties; `prefers-reduced-motion` disables all of them.
- No text under 12 px anywhere; landing-page body copy is 13 px or larger (the audit enforces both).

## Known limits

- Both sellers and every buyer so far are ours; the mechanism is permissionless, the
  liquidity is not.
- Keyless runs use two Circle developer-controlled wallets on Arc (buyer and seller, gas
  by Circle Gas Station), signed on the server; the hook's attester is the evaluator and
  sends the complete() or reject() that settles them. Rows from those runs are labeled
  "our buyer (Circle wallet)" and "openbook.eth (Circle seller wallet)"; both wallets are ours.
- The staleness in Make it fail is staged (floor above the delivery); the hook's refusal
  is real and is the same path a natural miss takes.
