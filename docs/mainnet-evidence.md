# Arc mainnet deployment — evidence (2026-09-18)

Arc mainnet, chain **5042**, RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`.
Everything below is a real transaction on that chain; every hash is clickable at
`https://explorer.arc.io/tx/<hash>`. This is the file the submission's mainnet-bonus claim points at
(the Arc prize adds $2,000–$2,500 for "deploying the same project to Arc Mainnet by Sep 30, 2026").

## Deployed contracts

| contract | address | deploy tx |
| --- | --- | --- |
| EIP-8183 reference escrow (impl) | `0x49a2A51adCAde93bd1bc30887973167a8f9234B9` | `0xc7db3dfdc60d764084d2cc66a398030c5a2ba0f49acf995ed83966052c56c1c0` |
| escrow proxy (`ArcProxy`, initialized) | `0x1D2FB397D890aDd415Dd99dFCD00699629D58a62` | `0xff53a0ac3ac30f415f20aae65eb1b9e7c96d5fa2a0ba6e2db31590f383fcfc71` |
| `SlaHook` | `0xe6Ac092054A17C43e206c8159BB8a9Bd67E97E9E` | `0x6dc172f81229dbcc7da3c264b306a533b56cab744a28771271bb708ee71ac456` |
| `PolicyWallet` | `0x651255FCc762A032237e8D14838bA9f18a7171af` | `0x8ecd04999d6480d1e9ce4c950a6216b88e12f9b6f98f72b605cbcebfe6855774` |

Read-backs from the live contracts (the deploy script asserts them):

- `escrow.paymentToken()` = `0x3600…0000` (Arc's USDC ERC-20 view, 6 decimals — verified before deploying)
- `escrow.platformFeeBP()` = 0 · `escrow.jobCounter()` advanced 0 → 2 through the two jobs below
- `hook.escrow()` = the proxy · `hook.attester()` = `0x8D71610fa6E1c95e28Bd465f0236b5c31010C587`
- `policy.agent()` = `0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21`, caps 1 USDC/tx · 10 USDC/day

Operational transactions:

- provider funded with gas: `0xc8742b2c2ef0b46437c62ff8a9c602c9f120377108b2dcc15481ddcbc7ad160e` (0.3 USDC)
- `setHookWhitelist(hook, true)`: `0x1beab5ed3d73a7d4e6fe251cac9a309b95f42bfe0424acbec630dfe914c1cb0c`
- `setAttester(0x8D71…C587)`: `0x79966b60304715345797abd4b28bad1686d53eaa461f2bdc00b9bbf53eab9253` — the worker's
  attester key, so the deployed app's lane works on mainnet (the evaluator IS `hook.attester()`)
- attester gas endowment: `0xa7a08980946611f1c3171549dc3a0add3bf560d11416577bee8e92150cc8d0ab` (0.3 USDC —
  attest/complete are sent by that key, exactly as the worker does)
- **venue fee** `setPlatformFee(200, PolicyWallet)`: `0x9e250c59bcbc6382bb402d20d34e48dc4f15160e9923a47ab980e64e49ef758d`
  — mirrors testnet: 2% of every settlement routes to the PolicyWallet

## Live USDC movement — two jobs, run by `scripts/mainnet-loop.sh`

**Job 1 — met SLA, settled.** Client `0x5cB5…c879` funds 0.5 USDC; the provider submits; the
attester posts a fresh proof; `complete` releases the escrow.

| step | tx |
| --- | --- |
| `createJob` | `0xaf1a8125479c873611b12d024f3d0ce49b2c2a67214896d78d6e36dbc7ac1912` |
| `setBudget` (provider) | `0x6a260e70678f21b5b506ff694122f56e046b5214a07ce7780f4878dbdc9369eb` |
| `approve` | `0x808491426819b310f9312f7fca05e904226f13c9ad98dfb4a4305c5e3a2f9a12` |
| `fund` | `0xc74d1c1e6a0d15f2587ded09ebdac2c348c518a2610955d690c0ebf1e0f58591` |
| `submit` (provider) | `0x55bcde0bc460f7600ad58d14aee154a9674f5bb928eacee347b4aefcf251c992` |
| `attest` (fresh) | `0xfd3e0b9516025e96a13e5edcba01df2699f6436ea987f8bd9463dce543c59e88` |
| `complete` | `0x2e49dcf8e7d124441dc769e80dfd4bb41b46680fa6e7192ae4c8a8491b88dad5` |

Result: job status 3 (`Completed`); 0.5 USDC moved to the provider on mainnet.

**Job 3 — settlement with the venue fee.** Run after the fee was set, to capture the split on
mainnet: `createJob` `0xb1982624bcbb6bc0c2a64bd349ee19e44ff4ec2da7429e5657b5898a06b1b180`,
`setBudget` `0x9429943bbe7e973922f2e35b6c50d63fb8569c22eb2a53d10b755fd64bd8c4f7`, `approve`
`0xdca8d4bd38d96b00e509b96c331dcac0e88d4c00d07953538d45ff8f9af5fd5b`, `fund`
`0x88aba1a5441ce4a7b89fd77ec4a98591f04e682d6860c4483e0e885b8428befc`, `submit`
`0x818c18d173083913146e043ac1210ee6161167b53ab206830ca9dd4432b4c81d`, `attest`
`0x29afb5d90f7fbf19ff8ffe21286ba0de7ea742b9bdbff14811af1ab76e50006c`, `complete`
`0xe2ce6b4e2b0fcbb5ab0b659ccae780f61104a5cc0921d10a26fb0f48ea8f4247`.
Outcome: job status 3 (`Completed`); the provider received 0.49 USDC and the **PolicyWallet
received exactly 0.01 USDC = 2% of 0.5** — the venue fee, collected on mainnet
(`balanceOf(PolicyWallet)` went 0 → 10000 in the 6-decimal view).

**Job 2 — missed SLA, blocked, refunded.** The attester posts a **stale** proof
(`metaBlock 16901448 < minBlock 21901448`), so the hook refuses settlement, and the escrow can only
be recovered permissionlessly after expiry.

| step | tx |
| --- | --- |
| `createJob` | `0x94723b830c9f93b034ba5b1bae9f87daf69979b8483fb8c2d649cf9524a7a511` |
| `setBudget` (provider) | `0xec645bb73c764f47de6e64e253918a4fc2445d8f445bda446c33c4a9fca8a1f7` |
| `approve` | `0x0a81d3e2d7ae5239c2565cfce65ced0ed2c6227fc981ae4b5013654d372a9326` |
| `fund` | `0xe979f8f236835d34ce9ddf963ff542de8b6993726ff73d9630aa8780f176a158` |
| `submit` (provider) | `0x4a09cf0bdbdae971302edb2a659556c0141d96dab60c9f4f9888a266db56bf83` |
| `attest` (stale) | `0xaf593aa3248bc3c515845f07db56e1cea2509c289e740a3c0c13d1468d06114e` |
| `complete` | **reverted** in simulation with `0x49407c8b` = `SlaNotMet(uint256,uint256)` (selector verified) |
| `claimRefund` | `0xc8a709633e57b43fb5976f1ed888d9e52a88f1695091538d9bcdce9cf1d72478` |

Result: job status 5 (`Expired`); 0.5 USDC returned to the client. The escrow balance is **0** —
nothing is stranded in the contract.

## Money (Arc USDC, 6-decimal view; gas is the same balance in its 18-decimal native view)

| account | before | after (through job 3) |
| --- | --- | --- |
| client (deployer) | 5.000000 USDC | 3.592918 USDC |
| provider (agent) | 0 | 1.280689 USDC |
| PolicyWallet (venue fees) | 0 | 0.010000 USDC |

5.0 USDC in → 0.906 spent total: ~0.07 in contract deployment gas, 0.3 as the provider's gas
endowment, 0.5 settled as real payment, ~0.036 in run gas. All four contracts plus both jobs were
executed for under a dollar — the "gas is USDC, and cheap" claim, measured.

## The app on mainnet

**https://openbook-mainnet.vercel.app** — built from this repo with `bunx vite build --mode mainnet`
(`app/.env.mainnet` carries the chain 5042 values, committed so a judge can reproduce the bundle).
Verified in the browser: the banner reads "OpenBook runs on Arc mainnet. Buying with your own
wallet spends real USDC." and the served bundle carries the mainnet escrow, hook, policy wallet and
RPC. The worker runs with mainnet chain env (`OPENBOOK_ESCROW`, `OPENBOOK_HOOK`, `ARC_RPC_URL`,
`ARC_CHAIN_ID=5042`, `ARC_CHAIN_NAME=Arc` set as preview variables on the host).

Deliberate differences from the testnet demo, stated plainly:

- **Circle developer-controlled wallets are testnet entities**, so `VITE_BUY_LANE=wallet` on the
  mainnet build: purchases sign with a connected wallet (or the demo key), never a testnet signer.
- **The Graph's subgraph for this project is testnet-indexed**, so the market page's live dataset
  stays on testnet; the mainnet deployment demonstrates the protocol contracts end to end.
- The production demo (**https://openbook.litai.ca**) deliberately stays on testnet: same code,
  same copy, testnet chain env — the two deployments differ only by build mode and host env.

## How the labels were verified (not inferred)

Address labels can be silently swapped; these are the checks that settle them, all run against
chain state:

- the wallet's deploy receipt names it: `cast receipt 0x8ecd0499…` → `status 1`,
  `contractAddress 0x651255FCc762A032237e8D14838bA9f18a7171af`
- `0x651255FC… .agent()` → `0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21`; `.escrow()` on it reverts
  (only the PolicyWallet has `agent()`)
- `0xe6Ac0920… .escrow()` → `0x1D2FB397D890aDd415Dd99dFCD00699629D58a62`; `.attester()` →
  `0x8D71610f…` (only the SlaHook has `escrow()`)
- runtime code: PolicyWallet 1900 bytes, SlaHook 2240 bytes, the proxy 129 — consistent with the
  labels, and both were re-read at deploy time by `scripts/deploy-mainnet.sh`
- **where the money is**: `escrow.platformTreasury()` = `0x651255FC…`, its USDC balance is `10000`
  (job 3's 2%), and the SlaHook's balance is **0** — the fee is in the treasury, nothing is
  stranded. The treasury can move it: `PolicyWallet.requestWithdrawal(to, amount)` is
  `onlyAgentOrOwner` (contracts/src/PolicyWallet.sol:55).

## What is deliberately NOT on mainnet (stated, not implied)

- **ERC-8004 identity**: probed — `cast code 0x8004A818…` has **no code on mainnet** (the testnet
  deployment is a 263-byte proxy). There is no registry to register against, so the agent
  identity stays on testnet; the mainnet deployment is the commerce layer.
- **The Graph subgraph**: this project's subgraph is testnet-indexed; `arc` mainnet network id is
  not used. The mainnet app therefore demonstrates the contracts (escrow, hook, policy wallet)
  end to end, while the market/feed pages keep reading the testnet dataset.
- **ENS**: ENSv2 is Sepolia-only for this bounty, so the agent's names/records stay on Sepolia —
  a constraint of the ENS track, not a mainnet descope.

## Reproduce it

```bash
# 1. deploy the four contracts (needs a funded mainnet key in .env)
ARC_MAINNET_BROADCAST=1 bash scripts/deploy-mainnet.sh
# 2. run the two-job proof (needs OPENBOOK_ATTESTER_PK for attest/complete)
bash scripts/mainnet-loop.sh
```
