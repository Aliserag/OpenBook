# Arc mainnet (chain 5042) — verified 2026-09-17

Mainnet is live and these parameters were read from the chain and the Arc docs on
2026-09-17, not from memory. They supersede the "params not published yet" note in
`resources/arc/README.md` and the stale "testnet only" line in the Circle `use-arc` skill.

| field | value | how it was verified |
|---|---|---|
| chain id | **5042** | `eth_chainId` on the mainnet RPC → `0x13b2` |
| RPC | `https://rpc.mainnet.arc.io` | answered `eth_chainId` (Alchemy / Blockdaemon endpoints exist too) |
| explorer | `https://explorer.arc.io` | linked from the mainnet tab of the Arc docs' contract-address page |
| USDC (ERC-20 view) | `0x3600000000000000000000000000000000000000` | same predeploy address as testnet; `decimals()` → **6** |
| native gas | USDC, 18 decimals | one balance, two views — never sum or convert them |
| gas floor | 20 Gwei `maxFeePerGas` | a lower tip is silently dropped; the deploy script passes `--gas-price 20000000000` |

## Deploy the stack

```bash
# preflight only (safe, sends nothing):
bash scripts/deploy-mainnet.sh

# deploy (after the deployer is funded — see below):
ARC_MAINNET_BROADCAST=1 bash scripts/deploy-mainnet.sh
```

The script asserts the chain id and the 6-decimal USDC view, refuses to run without a
funded deployer, deploys in order — ERC-8183 reference implementation → `ArcProxy`
(`initialize(USDC, treasury, admin)`) → `SlaHook(escrow, attester)` →
`PolicyWallet(USDC, agent, perTxCap, dailyCap)` — then reads every contract back and
prints the `.env` block to append. `ARC_MAINNET_KEYSTORE` (from
`cast wallet import`) is preferred over `ARC_MAINNET_PK`, which is only read from the
environment and never printed.

## Funding the deployer (the one step only you can do)

Mainnet gas is real USDC. The deployer is `ARC_MAINNET_ADDR` in `.env`
(`0x5cB5a7c747962A4024ecf81E4adcF631c95Ec879` at the time of writing — funded 2026-09-18,
4.09 USDC left after the full deploy + proof run). Average Arc tx ≈ $0.004.

The canonical funding path is the repo's own CCTP bridge script — Ethereum mainnet USDC to the
deployer on Arc, with a plan mode and safe resume:

```bash
node scripts/bridge-eth-to-arc.mjs --amount 6          # plan: from/to/amount, sends nothing
node scripts/bridge-eth-to-arc.mjs --amount 6 --yes    # approve → burn → attest → mint
node scripts/bridge-eth-to-arc.mjs --resume /tmp/bridge-eth-to-arc.json   # after a soft failure
```

Circle's on-ramp or any exchange withdrawal that supports Arc mainnet USDC work too.

## Point the app at mainnet (env alone, no code change)

The client reads every one of these at build time; the worker reads its four from the
host at runtime — verified: with `OPENBOOK_ESCROW`/`ARC_RPC_URL` set the module yields
them, and with nothing set it yields the testnet defaults, so the live demo is unaffected.
Set them as environment variables on the Pages/Vercel project (no rebuild needed), then
confirm with one purchase: the receipt's fund row names the escrow it used.

```text
VITE_ARC_CHAIN_ID=5042
VITE_ARC_CHAIN_NAME=Arc
VITE_ARC_EXPLORER=https://explorer.arc.io
VITE_ARC_TESTNET_RPC=https://rpc.mainnet.arc.io     # name kept: the override slot for the active chain
VITE_USDC_ADDRESS=0x3600000000000000000000000000000000000000
VITE_ESCROW=<escrow proxy from the deploy>
VITE_HOOK=<hook from the deploy>
OPENBOOK_ESCROW=<escrow proxy>     # worker (runtime)
OPENBOOK_HOOK=<hook>               # worker (runtime)
OPENBOOK_USDC=0x3600000000000000000000000000000000000000
ARC_RPC_URL=https://rpc.mainnet.arc.io
```

Testnet stays the default everywhere, so the live demo is unaffected until those
variables are set.

## Evidence the bounty asks for

After the deploy: one live end-to-end loop on mainnet (buy → deliver → settle, then a
stale run → refund) with the real USDC movement linked from `SUBMISSION.md`. The
onchain receipts are the proof — every settlement and refund already carries a job id
and a tx hash on the explorer.

## Deployed (2026-09-18)

Four contracts, real USDC, two live jobs — every address, tx hash and balance delta:
[`docs/mainnet-evidence.md`](mainnet-evidence.md).

| contract | address |
| --- | --- |
| escrow (`ArcProxy`) | `0x1D2FB397D890aDd415Dd99dFCD00699629D58a62` |
| `SlaHook` | `0xe6Ac092054A17C43e206c8159BB8a9Bd67E97E9E` |
| `PolicyWallet` | `0x651255FCc762A032237e8D14838bA9f18a7171af` |
| escrow impl (EIP-8183 reference) | `0x49a2A51adCAde93bd1bc30887973167a8f9234B9` |

The app builds against them with `bunx vite build --mode mainnet` (`app/.env.mainnet`), deployed at
https://openbook-mainnet.vercel.app. The worker switches chain from host env — set
`OPENBOOK_ESCROW`, `OPENBOOK_HOOK`, `OPENBOOK_USDC`, `ARC_RPC_URL`, `ARC_CHAIN_ID=5042`,
`ARC_CHAIN_NAME=Arc` on that host; leaving them unset keeps a host on testnet, which is exactly how
production (https://openbook.litai.ca) stays where the demo rehearses.

## What `scripts/deploy-mainnet.sh` does now

1. escrow impl (EIP-8183 reference, `contracts/reference/`) · 2. `ArcProxy` + `initialize`
· 3. `SlaHook` · 4. `PolicyWallet` · **5. `setHookWhitelist(hook, true)`** — the reference escrow
reverts `HookNotWhitelisted` for every hook except `address(0)`, so this is what makes the deployed
stack usable · **6. `setPlatformFee(200, policyWallet)`** — mirrors testnet (2% → the PolicyWallet).

Steps 5-6 are idempotent (they read first and skip when already set), every captured address is
validated against on-chain code, and `IMPL_OVERRIDE`/`ESCROW_OVERRIDE`/`HOOK_OVERRIDE`/
`POLICY_OVERRIDE` let a partial run resume without redeploying. The preflight compiles the
reference escrow (solc 0.8.28, pinned in `foundry.toml`) before any money moves.
