# OpenBook

**Fresh data or your money back. The data marketplace for AI agents.**

Sellers list data under an ENS name with a price and a freshness promise. A buyer agent pays
USDC into an escrow on Arc with that promise written in. The delivery arrives through The
Graph stamped with the block it was recorded at, and a contract compares the stamp with the
promise: fresh, the seller is paid; stale, the money goes back. No dispute, no support
ticket.

[![OpenBook demo video](https://img.youtube.com/vi/OLUNTuVyvac/hqdefault.jpg)](https://www.youtube.com/watch?v=OLUNTuVyvac)

| | |
| --- | --- |
| Demo video | https://www.youtube.com/watch?v=OLUNTuVyvac |
| Live app | https://openbook.litai.ca |
| The market | https://openbook.litai.ca/#market |
| Architecture | [docs/architecture.md](docs/architecture.md) |

## The problem and the solution

The people driving the next trillion-dollar economy have a blind spot that is going to
hemorrhage as much as $7 billion by the end of this year (our estimate). The people driving
it are in fact not people. They are AI agents, and entire economies will be built around how
they make decisions and the data they use to make them.

Every day, agents spend real money on data at machine speed. On Polymarket's fastest
markets, bots already move 55 to 62% of the volume (Dune). A prediction-market agent buys
odds before it takes a position, and for it, current data is edge worth paying for. Agentic
commerce is projected at $1.5 trillion by 2030 (Juniper).

Every day, some of that data arrives stale, and the agent acts on it anyway. There is no
refund, no dispute, no half-dead Discord, nobody to call. Bad data of every kind already
costs the average organization $12.9 million a year (Gartner, via IBM). Today 54% of
organizations are deploying agents (KPMG, Q1 2026). Gartner's own forecast is that more
than 40% of agentic AI projects will be canceled by 2027, and it names the reason:
inadequate risk controls. The rails exist. The recourse does not.

Recourse is the missing primitive of the agentic economy. Agents will not be trusted with
real budgets until spending can be undone. Not by a court or a support ticket, but by the
contract that holds the money.

A refund that the contract executes itself bounds an agent's loss per query to the gas it
spent, which is what makes an agent's budget underwritable. It is also what turns freshness
into something people can profit from: a seller can charge more for a tighter freshness
window and forfeits the fee when it misses, so the incentive runs toward faster indexers and
better feeds, and the freshness premium becomes an open, observable price instead of a
private contract. Refundable spend lets agents hold real budgets, real budgets create demand
for fresher data, and that demand pays the people who make data fresher. An economy where
agents decide every block needs data priced every block.

OpenBook is that market: the data marketplace for AI agents, with a freshness guarantee
that enforces itself. Sellers list a dataset under their own onchain name (an ENS name) with
a price per query and a freshness promise. A buyer agent asks in plain English, its payment
locks into an escrow on Arc with the promise written in, and the data arrives from The Graph
stamped with the block it was recorded at. Fresh: 98% to the seller, 2% to the protocol.
Stale: the contract refuses to pay and the money goes back. Every settlement, refund and fee
is written into public books anyone can audit. Both outcomes are live on testnet: job 116
settled with odds 3 seconds old inside a 10-second window
([0.098 USDC to the seller, 0.002 to the protocol](https://testnet.arcscan.app/tx/0x769685cdda5a6df5606baef78241ce6a065ad89193f0b4641afc33e9644cc2fd)),
and job 117, asking for odds no older than a tenth of a second, was refused and
[refunded in full](https://testnet.arcscan.app/tx/0x39d92b9e041a3bf7065a1718d876aec21df7bf7914fc4814ad8e8fbd47db6012)
without anyone asking.

Prediction markets, lending rates, pool prices, NFT trades and name registrations are on the
market today; any active subgraph (15,000+ as of today) can be turned into its own monetized
market with one config line, and an MCP server lets agents discover, compare and buy.
Tomorrow, anything an agent acts on is sold this way, and the $7 billion blind spot is not
litigated. It is refunded.

## How it works

![OpenBook architecture](docs/images/architecture.png)

**Settlement on Arc.** Every purchase is a job on OpenBook's instance of Circle's ERC-8183
escrow ([0x967e…7Dd5](https://testnet.arcscan.app/address/0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5),
an [ArcProxy](contracts/src/ArcProxy.sol) over Circle's reference implementation so OpenBook
holds the admin role that whitelists the hook), paid and gassed in USDC, with a 2% platform fee.
[SlaHook.sol](contracts/src/SlaHook.sol)
([0x6060…0846](https://testnet.arcscan.app/address/0x606075F3Cf9b5B66E7e4DD2ea369894374Ff0846))
is the ERC-8183 hook the escrow calls on every action: on submit it records the hash of the
delivered bytes; before complete it requires a signed attestation over that hash and checks
that the delivery's block clears the freshness floor set at payment. If either check fails
it reverts `SlaNotMet(attested, floor)` and the job can only be refunded. The fee goes to a
[PolicyWallet](contracts/src/PolicyWallet.sol) treasury
([0x4e83…894E](https://testnet.arcscan.app/address/0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E))
with onchain per-transaction and daily caps and an allowlist.

**Data from The Graph, stamped with its block.** Every dataset is a live subgraph on The
Graph gateway (three on Messari standardized schemas, plus the ENS and Overtime subgraphs).
The server appends `_meta { block { number } }` to each query, hashes the payload and signs
the observation ([app/worker/shared.ts](app/worker/shared.ts)); that block number is what
the hook compares against the floor. One route settles a job: verify the hash, post the
attestation, simulate `complete()`, then send `complete()` or `reject()` in the same
request, so refunds do not wait for a deadline. The
[open-book subgraph](https://api.studio.thegraph.com/query/1760032/open-book/v0.0.10)
indexes every payment, settlement, refund and fee into public books.

**Every ENS name is a market.** `openbook.eth` is registered in the
[ENSv2 registry on Sepolia](https://sepolia.etherscan.io/address/0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2)
and runs its own
[UserRegistry subregistry](https://sepolia.etherscan.io/address/0x8eC443d5e7BCB2E9182c83CE96295dFc35085f29),
so the name is a namespace of markets. A dataset can be its own subname with its own price,
freshness window and payee in text records (`svc.price`, `svc.sla`, `svc.payee`): the Aave
lending subname quotes 0.15 while the parent quotes 0.10 and can name its own payee; the
other four datasets resolve to the parent's records. `alpha.openbook.eth` has no resolver of its own and resolves through the parent's
(`getResolver` returns 0x0), so a market exists the moment the name does. `svc.pnl` points at the name's public books, and `agent-registration`,
`agent-context` and `agent-endpoint` records (ENSIP-25/26, tied to ERC-8004 agent 894065)
let an agent find the market from the name alone. Onboarding a seller is an Enhanced
Access Control grant: `alpha.openbook.eth`'s key was given write access to `svc.price`
only, on its own node
([grant](https://sepolia.etherscan.io/tx/0x09589d0ed2d14d5b64181b41f6d38c9a4c069de1d21354addbcc7d97873b2f86)),
and it repriced itself
([setText](https://sepolia.etherscan.io/tx/0x0b2c133612a735ff69a86cab43c8aabcc231adcf7af4113726f30269d41edac2));
every other write reverts `EACUnauthorizedAccountRoles`. The server re-resolves price and
payee from ENS before every job ([app/worker/circle.ts](app/worker/circle.ts)) and no purchase
or quote path has a default price or payee. No ENS, no market.

**Wallets.** On the web app the buyer and seller are Circle developer-controlled wallets with
gas sponsored by Circle Gas Station
([sponsored submit](https://testnet.arcscan.app/tx/0x66135a8c6ec289d165023a16bb86bd53d478aa3a6c95f888a939bea2b46b6638)),
so a purchase needs nothing installed. With a browser wallet connected, the wallet creates
and funds the job and the seller quotes it from its Circle wallet. The treasury funds the
buyer from another chain with App Kit's CCTP bridge
([mint on Arc](https://testnet.arcscan.app/tx/0xe54af84c20628ff04f3e691f12818f1f1a6220d109c476b50432d35909b769f1))
and a Gateway unified balance
([spend on Arc](https://testnet.arcscan.app/tx/0xa956aabeb35342b8c03d7e728a60511f24dcae1793f4885ba290ea54cf196156)).
An x402 lane sells the same signed delivery per call, paid from a Circle Agent Wallet
([app/worker/x402.ts](app/worker/x402.ts)); it runs on the Vercel functions of the mirror
deployment (`POST https://ethonline2026-openbook.vercel.app/api/x402/status` returns the terms).

**Freshness is measured at delivery.** The server fetches the data first, reads the source
chain's head timestamp, and derives the floor from wall-clock and block time, so a request
for data no older than 0.1 s fails honestly: the newest block is already over a second old
and the subgraph lags a few seconds more.

## Using the demo

Open [openbook.litai.ca](https://openbook.litai.ca). The console on the landing page takes
plain English; anything that is not a command is routed to a validated command by a
server-side model, and a purchase asks how fresh the data must be before it spends.

- `Get me the odds for Charlotte 49ers vs Western Carolina, max 10 cents, under 10 seconds old`
  runs a real purchase through a Circle wallet and prints one receipt: the odds, the block,
  the data's age, the verdict and the split, with every transaction linked.
- `Same odds, but no older than a tenth of a second` is a purchase no seller can meet: the
  contract refuses and the escrow refunds in the same receipt.
- `What data can I buy` lists the datasets with their live ENS prices and windows.
- `Show me the seller's ENS records` prints the storefront as it resolves right now.
- `ens can-edit alpha.openbook.eth svc.sla 0xe09C8F90931E97d0aEE998885b306DDF08CE08Cc` shows the
  resolver refusing a key the parent never granted (`EACUnauthorizedAccountRoles`), live,
  without a transaction; the same key with `svc.price` is allowed.

**Connect wallet** in the top bar uses your own wallet on Arc testnet instead (testnet USDC
from [faucet.circle.com](https://faucet.circle.com)); the wallet signs `createJob`,
`approve` and `fund`, the seller quotes from its Circle wallet, and the same receipt prints.
[The market](https://openbook.litai.ca/#market) shows the ticker, an order book priced from
ENS, and the trades tape. **Try it** runs the purchase as a six-row stepper, and **Make it
fail** runs the refund.

## Running the app

```bash
git clone https://github.com/Aliserag/OpenBook && cd OpenBook
bun install
bun test              # unit tests across agent, mcp, app and scripts, no keys needed
cd app && bun run dev # http://localhost:5173
```

`cp .env.example .env` and set `GRAPH_GATEWAY_KEY` (free at thegraph.com/studio) for
deliveries; the deployed app holds it server-side. `forge test` runs the contract tests.
`scripts/deploy-app.sh` publishes one bundle to Cloudflare Pages and Vercel and
`scripts/app-audit.mjs` runs a browser audit against the live page.

## The MCP server

[`mcp/`](mcp/README.md) is `sla-subgraph-mcp`, an MCP server that turns any subgraph into a
paid, freshness-guaranteed dataset. Seven tools: `list_datasets`, `discover_datasets` (searches
The Graph's Subgraph MCP and returns paste-ready config entries), `get_quote` (live ENS
terms), `choose_seller` (reads every seller's terms and the dataset's current index lag,
drops sellers whose window the index cannot meet, and picks the cheapest or freshest with
its reasoning), `query_dataset` (signed, block-stamped delivery), `verify_delivery` and
`get_pnl`.

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_quote","arguments":{"datasetId":"overtime-sports-odds"}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"query_dataset","arguments":{"datasetId":"overtime-sports-odds","graphql":"{ sportMarkets(first: 1) { id } }"}}}' \
  | GRAPH_GATEWAY_KEY=<key> OPERATOR_PRIVATE_KEY=<key> bun mcp/src/server.ts --config mcp/config/openbook.json
```

The quote resolves `price`, `sla` and `payee` from the live ENS records (`"source": "ENS"`);
the query returns live rows with the gateway's `meta.block`, the payload hash and the operator's
signature (the quote alone needs no keys).
Listing a new dataset is one entry in [mcp/config/openbook.json](mcp/config/openbook.json).

## Deployments

| | |
| --- | --- |
| Escrow (ERC-8183, 2% fee, SlaHook whitelisted) | [0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5](https://testnet.arcscan.app/address/0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5) on Arc testnet |
| SlaHook | [0x606075F3Cf9b5B66E7e4DD2ea369894374Ff0846](https://testnet.arcscan.app/address/0x606075F3Cf9b5B66E7e4DD2ea369894374Ff0846) |
| PolicyWallet treasury | [0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E](https://testnet.arcscan.app/address/0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E) |
| Agent identity | ERC-8004 agent 894065 on Arc testnet |
| Storefront | `openbook.eth` on ENSv2 Sepolia ([registry](https://sepolia.etherscan.io/address/0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2), [subregistry](https://sepolia.etherscan.io/address/0x8eC443d5e7BCB2E9182c83CE96295dFc35085f29)) |
| Public books | [open-book subgraph](https://api.studio.thegraph.com/query/1760032/open-book/v0.0.10) on Subgraph Studio |
| App | [openbook.litai.ca](https://openbook.litai.ca) (Cloudflare Pages, with a Vercel mirror of the same bundle) |

## Repository

- `contracts/`: SlaHook.sol and PolicyWallet.sol with Foundry tests
- `app/`: the web app (Vite, React) and its server routes (`app/worker`)
- `mcp/`: sla-subgraph-mcp and its dataset configs
- `subgraph/`: the open-book subgraph (`scripts/deploy-subgraph.sh` substitutes the seller address the mapping books)
- `agent/`: the seller service and buyer CLI
- `scripts/`: ENS setup and delegation, Circle treasury ops, deploy and audit
- `docs/`: architecture, the bounty technology map, the ENS storefront runbook
