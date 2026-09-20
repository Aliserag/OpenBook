#!/usr/bin/env bash
# Deploy the OpenBook stack to Arc MAINNET (chain 5042).
#
# Keyless-safe by default, like contracts/script/deploy-policy-wallet.sh: without
# ARC_MAINNET_BROADCAST=1 it runs every preflight, verifies the chain, and prints the
# exact forge commands. With it, it deploys and then reads the deployed contracts back.
#
# What it deploys, in order (each one is a separate tx; gas is USDC):
#   1. the ERC-8183 reference escrow implementation  (contracts/reference/AgenticCommerce.sol)
#   2. ArcProxy → initialize(USDC, treasury, admin)  (the escrow the app talks to)
#   3. SlaHook(escrow, attester)                     (enforces the freshness promise)
#   4. PolicyWallet(USDC, agent, perTxCap, dailyCap) (the treasury's spending rails)
#
# Env (all optional; .env is sourced when present):
#   ARC_MAINNET_RPC      default https://rpc.mainnet.arc.io (verified 2026-09-17)
#   ARC_MAINNET_USDC     default 0x3600…0000 — the ERC-20 view, 6 decimals
#   ARC_MAINNET_PK       deployer key (required only to broadcast)
#   ARC_MAINNET_ATTESTER address the hook trusts to attest freshness (default: deployer)
#   TREASURY_EOA         protocol treasury (default: deployer)
#   AGENT_ADDR           agent key allowed to spend the PolicyWallet (default: ARC_RECIPIENT_ADDR)
#   PER_TX_CAP/DAILY_CAP PolicyWallet caps in 6-dec USDC (default 1000000 / 10000000)
set -euo pipefail

cd "$(dirname "$0")/.." # repo root

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

RPC="${ARC_MAINNET_RPC:-https://rpc.mainnet.arc.io}"
USDC="${ARC_MAINNET_USDC:-0x3600000000000000000000000000000000000000}"
CHAIN_ID=5042
EXPLORER="${ARC_MAINNET_EXPLORER:-https://explorer.arc.io}"
PER_TX="${PER_TX_CAP:-1000000}"
DAILY="${DAILY_CAP:-10000000}"
BROADCAST="${ARC_MAINNET_BROADCAST:-0}"

say() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# ---- preflight ------------------------------------------------------------
say "== preflight =="
GOT_CHAIN="$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)"
[[ -n "$GOT_CHAIN" ]] || fail "no chain answered at $RPC"
[[ "$GOT_CHAIN" == "$CHAIN_ID" ]] || fail "$RPC reports chain $GOT_CHAIN, expected $CHAIN_ID"
say "  chain          $GOT_CHAIN ✓"

DECIMALS="$(cast call "$USDC" "decimals()(uint8)" --rpc-url "$RPC")"
[[ "$DECIMALS" == "6" ]] || fail "USDC ERC-20 view reports $DECIMALS decimals, expected 6 (Arc trap)"
say "  usdc decimals  $DECIMALS ✓ ($USDC)"

if [[ -z "${ARC_MAINNET_PK:-}" ]]; then
  say ""
  say "awaiting key: \$ARC_MAINNET_PK is unset."
  say "  Set it in .env (the address it derives is \$ARC_MAINNET_ADDR = ${ARC_MAINNET_ADDR:-<unset>})."
  say "  Security: prefer a keystore — cast wallet import openbook-deployer --interactive, then export ARC_MAINNET_KEYSTORE=openbook-deployer"
  exit 0
fi

if [[ -n "${ARC_MAINNET_KEYSTORE:-}" ]]; then
  SIGNER=(--account "$ARC_MAINNET_KEYSTORE")
  DEPLOYER="$(cast wallet address --account "$ARC_MAINNET_KEYSTORE")"
else
  SIGNER=(--private-key "$ARC_MAINNET_PK")
  DEPLOYER="$(cast wallet address --private-key "$ARC_MAINNET_PK")"
  say "  signer         $DEPLOYER (private key from env; a keystore is preferred)"
fi

BALANCE="$(cast balance --rpc-url "$RPC" "$DEPLOYER")"
if [[ "$BALANCE" == "0" || -z "$BALANCE" ]]; then
  say ""
  say "awaiting funding: deployer $DEPLOYER holds 0 USDC on Arc mainnet."
  say "  USDC is the gas token, and this is real mainnet USDC — only you can move it."
  say "  Bridging path (App Kit / CCTP, ~2 minutes once the source chain has USDC):"
  say "    node -e \"…\"  # or the repo's own kit.bridge snippet — see docs/mainnet.md"
  say "  Then re-run this script; it will print the deploy commands."
  exit 0
fi
say "  deployer       $DEPLOYER funded ($BALANCE wei native) ✓"

# The escrow impl is the EIP-8183 reference: it needs OpenZeppelin (lib/) and its own
# pragma needs solc 0.8.28. Compile it here so a build failure never costs a tx.
if ! forge build contracts/reference/AgenticCommerce.sol >/tmp/forge-build-reference.log 2>&1; then
  tail -5 /tmp/forge-build-reference.log >&2
  fail "the reference escrow does not compile (needs: forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 openzeppelin-contracts-upgradeable@v5.1.0)"
fi
say "  reference impl compiles ✓"

ATTESTER="${ARC_MAINNET_ATTESTER:-$DEPLOYER}"
TREASURY="${TREASURY_EOA:-$DEPLOYER}"
AGENT="${AGENT_ADDR:-${ARC_RECIPIENT_ADDR:-}}"
[[ -n "$AGENT" ]] || fail "AGENT_ADDR (or ARC_RECIPIENT_ADDR) must name the agent key"
say "  attester       $ATTESTER"
say "  treasury       $TREASURY"
say "  agent          $AGENT"
say "  policy caps    $PER_TX per tx / $DAILY per day (6-dec USDC)"

# ---- the commands ---------------------------------------------------------
INIT_DATA="$(cast calldata "initialize(address,address,address)" "$USDC" "$TREASURY" "$DEPLOYER")"
say ""
say "== deploy plan (gas is USDC; Arc's floor is 20 Gwei) =="
say "1) escrow implementation (reference ERC-8183)"
say "   forge create contracts/reference/AgenticCommerce.sol:AgenticCommerce --rpc-url $RPC --gas-price 20000000000 --broadcast"
say "2) escrow proxy (this is the address the app uses)"
say "   forge create contracts/src/ArcProxy.sol:ArcProxy --constructor-args <IMPL> $INIT_DATA --rpc-url $RPC --gas-price 20000000000 --broadcast"
say "3) SLA hook"
say "   forge create contracts/src/SlaHook.sol:SlaHook --constructor-args <ESCROW> $ATTESTER --rpc-url $RPC --gas-price 20000000000 --broadcast"
say "4) policy wallet"
say "   forge create contracts/src/PolicyWallet.sol:PolicyWallet --constructor-args $USDC $AGENT $PER_TX $DAILY --rpc-url $RPC --gas-price 20000000000 --broadcast"
say "5) whitelist the hook in the escrow + set the venue fee (both idempotent)"
say "   cast send <ESCROW> \"setHookWhitelist(address,bool)\" <HOOK> true …"
say "   cast send <ESCROW> \"setPlatformFee(uint256,address)\" ${FEE_BP:-200} <POLICY> …"

if [[ "$BROADCAST" != "1" ]]; then
  say ""
  say "dry run: nothing sent. Re-run with ARC_MAINNET_BROADCAST=1 to deploy."
  exit 0
fi

# ---- broadcast ------------------------------------------------------------
say ""
say "== deploying =="
# deploy <path:Contract> [constructor args...] — prints the address on stdout only; the
# forge log (address + tx hash) goes to stderr so a caller can never capture prose by mistake.
deploy() {
  local target="$1"; shift
  forge create "$target" --rpc-url "$RPC" --gas-price 20000000000 --broadcast "${SIGNER[@]}" \
    ${1:+--constructor-args "$@"} >/tmp/forge-create.log 2>&1 || true
  grep -E "^Deployed to|^Transaction hash|^Error|error\[|revert" /tmp/forge-create.log >&2 || true
  awk '/Deployed to:/ {print $3}' /tmp/forge-create.log | tail -1
}

# Every address is validated before it is trusted, and each step can be resumed from env so a
# partial run never redeploys what already landed.
is_address() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; }
landed() { # <label> <address> — a deployed contract answers with code
  is_address "$2" || fail "$1: '$2' is not an address"
  [[ "$(cast code "$2" --rpc-url "$RPC")" != "0x" ]] || fail "$1: no code at $2"
}

step() { # <label> <override env value> <forge args...>
  local label="$1" override="$2"; shift 2
  local addr="$override"
  if [[ -n "$addr" ]]; then
    landed "$label" "$addr"
    printf '  %s %s (reused; already on chain)\n' "$label" "$addr" >&2
    printf '%s' "$addr"
    return
  fi
  addr="$(deploy "$@")"
  landed "$label" "$addr"
  # stdout carries the address and nothing else: callers capture this function.
  printf '  %s %s\n' "$label" "$addr" >&2
  printf '%s' "$addr"
}

IMPL="$(step "escrow impl  " "${IMPL_OVERRIDE:-}" contracts/reference/AgenticCommerce.sol:AgenticCommerce)"
ESCROW="$(step "escrow       " "${ESCROW_OVERRIDE:-}" contracts/src/ArcProxy.sol:ArcProxy "$IMPL" "$INIT_DATA")"
HOOK="$(step "hook         " "${HOOK_OVERRIDE:-}" contracts/src/SlaHook.sol:SlaHook "$ESCROW" "$ATTESTER")"
POLICY="$(step "policy wallet" "${POLICY_OVERRIDE:-}" contracts/src/PolicyWallet.sol:PolicyWallet "$USDC" "$AGENT" "$PER_TX" "$DAILY")"

# ---- wiring (steps 5-6) ---------------------------------------------------
# The reference escrow reverts HookNotWhitelisted for every hook but address(0) (only
# initialize's zero address is whitelisted), and it leaves platformFeeBP at 0. Both are
# admin calls the deployer can make, and both are what makes the deployed stack usable.
cast_send() { # <to> <signature> [args...] — prints the tx hash
  local to="$1" sig="$2"; shift 2
  cast send "$to" "$sig" "$@" --rpc-url "$RPC" --gas-price 20000000000 "${SIGNER[@]}" --json | jq -r .transactionHash
}
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

say ""
if [[ "$(cast call "$ESCROW" "whitelistedHooks(address)(bool)" "$HOOK" --rpc-url "$RPC")" == "true" ]]; then
  say "  hook whitelist already set ✓"
else
  say "  hook whitelist tx $(cast_send "$ESCROW" "setHookWhitelist(address,bool)" "$HOOK" true)"
fi
[[ "$(cast call "$ESCROW" "whitelistedHooks(address)(bool)" "$HOOK" --rpc-url "$RPC")" == "true" ]] \
  || fail "hook is not whitelisted — every createJob with this hook would revert HookNotWhitelisted"

FEE_BP="${PLATFORM_FEE_BP:-200}"
CUR_FEE="$(cast call "$ESCROW" "platformFeeBP()(uint256)" --rpc-url "$RPC" | awk '{print $1}')"
CUR_TREASURY="$(cast call "$ESCROW" "platformTreasury()(address)" --rpc-url "$RPC")"
if [[ "$CUR_FEE" == "$FEE_BP" && "$(lower "$CUR_TREASURY")" == "$(lower "$POLICY")" ]]; then
  say "  venue fee      ${FEE_BP}bp → $POLICY ✓ (already)"
else
  say "  venue fee      ${FEE_BP}bp → $POLICY tx $(cast_send "$ESCROW" "setPlatformFee(uint256,address)" "$FEE_BP" "$POLICY")"
fi
[[ "$(cast call "$ESCROW" "platformFeeBP()(uint256)" --rpc-url "$RPC" | awk '{print $1}')" == "$FEE_BP" ]] \
  || fail "platformFeeBP did not stick"
[[ "$(lower "$(cast call "$ESCROW" "platformTreasury()(address)" --rpc-url "$RPC")")" == "$(lower "$POLICY")" ]] \
  || fail "platformTreasury is not the PolicyWallet"

# ---- read back ------------------------------------------------------------
say ""
say "== read-back (the deployed contracts answering) =="
say "  escrow.paymentToken()   $(cast call "$ESCROW" "paymentToken()(address)" --rpc-url "$RPC")"
say "  escrow.platformFeeBP()  $(cast call "$ESCROW" "platformFeeBP()(uint256)" --rpc-url "$RPC")"
say "  hook.escrow()           $(cast call "$HOOK" "escrow()(address)" --rpc-url "$RPC")"
say "  hook.attester()         $(cast call "$HOOK" "attester()(address)" --rpc-url "$RPC")"
say "  policy.agent()          $(cast call "$POLICY" "agent()(address)" --rpc-url "$RPC")"
say "  escrow.whitelistedHooks $(cast call "$ESCROW" "whitelistedHooks(address)(bool)" "$HOOK" --rpc-url "$RPC")"
say "  escrow.platformTreasury $(cast call "$ESCROW" "platformTreasury()(address)" --rpc-url "$RPC")"

cat <<EOF

== append to .env (mainnet values) ==
OPENBOOK_ESCROW_MAINNET=$ESCROW
OPENBOOK_HOOK_MAINNET=$HOOK
POLICY_WALLET_MAINNET=$POLICY
ERC8183_IMPL_MAINNET=$IMPL

== app + worker (mainnet build; the testnet demo keeps its own values) ==
VITE_ARC_CHAIN_ID=$CHAIN_ID
VITE_ARC_CHAIN_NAME=Arc
VITE_ARC_EXPLORER=$EXPLORER
VITE_ARC_TESTNET_RPC=$RPC
VITE_USDC_ADDRESS=$USDC
VITE_ESCROW=$ESCROW
VITE_HOOK=$HOOK
VITE_POLICY_WALLET=$POLICY
VITE_OPERATOR_ADDRESS=$AGENT
OPENBOOK_ESCROW=$ESCROW
OPENBOOK_HOOK=$HOOK
ARC_RPC_URL=$RPC

Explorer: $EXPLORER/address/$ESCROW
EOF
