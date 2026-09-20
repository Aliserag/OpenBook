#!/usr/bin/env bash
# The live Arc-mainnet proof for OpenBook — two real-USDC jobs on the deployed escrow:
#
#   Job A  settles under a met SLA:    create → setBudget (provider) → fund (client) →
#                                      submit (provider) → attest (attester) → complete (evaluator)
#                                      → 0.5 USDC moves to the provider on mainnet.
#   Job B  cannot settle on a missed SLA: the attester posts a stale attestation, so the hook
#                                      reverts `complete` (simulated, then proven) and the escrow
#                                      can only be recovered by `claimRefund` after expiry.
#
# Every step prints its tx hash; the tail prints the USDC deltas. Env comes from .env
# (ARC_MAINNET_PK = client/evaluator/attester, ARC_RECIPIENT_PK = provider).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then set -a; . ./.env; set +a; fi

RPC="${ARC_MAINNET_RPC:-https://rpc.mainnet.arc.io}"
EXPLORER="${ARC_MAINNET_EXPLORER:-https://explorer.arc.io}"
USDC="${ARC_MAINNET_USDC:-0x3600000000000000000000000000000000000000}"
ESCROW="${OPENBOOK_ESCROW_MAINNET:?set OPENBOOK_ESCROW_MAINNET (scripts/deploy-mainnet.sh printed it)}"
HOOK="${OPENBOOK_HOOK_MAINNET:?set OPENBOOK_HOOK_MAINNET}"
CLIENT_PK="${ARC_MAINNET_PK:?set ARC_MAINNET_PK}"
PROVIDER_PK="${ARC_RECIPIENT_PK:?set ARC_RECIPIENT_PK (the provider agent)}"
# The evaluator IS the hook's attester (the worker reads it from chain), and only the attester
# may call attest(), so both roles sign with the attester key when one is configured.
ATTESTER_PK="${OPENBOOK_ATTESTER_PK:-$CLIENT_PK}"
BUDGET="${BUDGET:-500000}" # 0.5 USDC (6 decimals)
DELIVERABLE="$(cast keccak "openbook-mainnet-loop-v1")"
JOB_B_WAIT="${JOB_B_WAIT:-360}" # > the escrow's 5-minute minimum expiry

say() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
GAS=(--gas-price 20000000000)
addr_of() { cast wallet address --private-key "$1"; }

send() { # <private key> <to> <signature> [args...] — prints the tx hash
  local pk="$1" to="$2" sig="$3"; shift 3
  local hash
  hash="$(cast send "$to" "$sig" "$@" "${GAS[@]}" --rpc-url "$RPC" --private-key "$pk" --json | jq -r .transactionHash)"
  printf '%s' "$hash"
}

# ── preflight ───────────────────────────────────────────────────────────────
CLIENT="$(addr_of "$CLIENT_PK")"
PROVIDER="$(addr_of "$PROVIDER_PK")"
ATTESTER="$(addr_of "$ATTESTER_PK")"
EVALUATOR="$(cast call "$HOOK" "attester()(address)" --rpc-url "$RPC")"
say "== preflight =="
say "  chain        $(cast chain-id --rpc-url "$RPC")"
say "  escrow       $ESCROW"
say "  hook         $HOOK"
say "  client       $CLIENT"
say "  evaluator    $EVALUATOR  (= hook.attester(); signs attest + complete)"
say "  provider     $PROVIDER"
BAL_CLIENT_0="$(cast call "$USDC" "balanceOf(address)(uint256)" "$CLIENT" --rpc-url "$RPC" | awk '{print $1}')"
BAL_PROVIDER_0="$(cast call "$USDC" "balanceOf(address)(uint256)" "$PROVIDER" --rpc-url "$RPC" | awk '{print $1}')"
say "  client USDC  $BAL_CLIENT_0 (6dp)"
say "  provider USDC $BAL_PROVIDER_0 (6dp)"
say "  jobCounter   $(cast call "$ESCROW" "jobCounter()(uint256)" --rpc-url "$RPC")"

# Both service keys need native USDC for gas (Arc: gas is the same balance, 18dp view):
# the provider submits, the attester/evaluator attests and completes.
for ROLE_ADDR in "provider:$PROVIDER" "attester:$EVALUATOR"; do
  ROLE="${ROLE_ADDR%%:*}"; WHO="${ROLE_ADDR#*:}"
  if [[ "$(cast balance "$WHO" --rpc-url "$RPC")" == "0" ]]; then
    say ""
    say "→ funding the $ROLE with 0.3 USDC for gas"
    say "  tx $(cast send "$WHO" --value 300000000000000000 "${GAS[@]}" --rpc-url "$RPC" --private-key "$CLIENT_PK" --json | jq -r .transactionHash)"
  fi
done

# The escrow refuses a non-whitelisted hook; the deployer holds DEFAULT_ADMIN_ROLE.
if [[ "$(cast call "$ESCROW" "whitelistedHooks(address)(bool)" "$HOOK" --rpc-url "$RPC")" != "true" ]]; then
  say ""
  say "→ whitelisting the SLA hook"
  say "  tx $(send "$CLIENT_PK" "$ESCROW" "setHookWhitelist(address,bool)" "$HOOK" true)"
fi
# The venue fee must match the demo story (2% → the PolicyWallet, same as testnet).
FEE_BP="${PLATFORM_FEE_BP:-200}"
GOT_FEE="$(cast call "$ESCROW" "platformFeeBP()(uint256)" --rpc-url "$RPC" | awk '{print $1}')"
[[ "$GOT_FEE" == "$FEE_BP" ]] || fail "platformFeeBP is $GOT_FEE, expected $FEE_BP"
FEE_AMT="$(( BUDGET * FEE_BP / 10000 ))"
say "  venue fee    ${FEE_BP}bp → $FEE_AMT of every $BUDGET settles to the PolicyWallet"

# ── job A: settle under a met SLA ───────────────────────────────────────────
say ""
say "═══ Job A — met SLA, real settlement ═══"
EXPIRY_A="$(( $(date +%s) + 1800 ))"
TX="$(send "$CLIENT_PK" "$ESCROW" "createJob(address,address,uint256,string,address)" \
  "$PROVIDER" "$EVALUATOR" "$EXPIRY_A" "OpenBook mainnet proof — SLA met (live data)" "$HOOK")"
JOB_A="$(cast call "$ESCROW" "jobCounter()(uint256)" --rpc-url "$RPC" | awk '{print $1}')"
say "  createJob    job $JOB_A  tx $TX"
say "  setBudget    tx $(send "$PROVIDER_PK" "$ESCROW" "setBudget(uint256,uint256,bytes)" "$JOB_A" "$BUDGET" 0x)"
TXT="$(send "$CLIENT_PK" "$USDC" "approve(address,uint256)" "$ESCROW" "$BUDGET")"
say "  approve      tx $TXT"
say "  fund         tx $(send "$CLIENT_PK" "$ESCROW" "fund(uint256,bytes)" "$JOB_A" 0x)"
say "  submit       tx $(send "$PROVIDER_PK" "$ESCROW" "submit(uint256,bytes32,bytes)" "$JOB_A" "$DELIVERABLE" 0x)"
BLOCK="$(cast block-number --rpc-url "$RPC")"
say "  attest       tx $(send "$ATTESTER_PK" "$HOOK" "attest(uint256,bytes32,uint256,uint256)" "$JOB_A" "$DELIVERABLE" "$BLOCK" 0)"
say "  complete     tx $(send "$ATTESTER_PK" "$ESCROW" "complete(uint256,bytes32,bytes)" "$JOB_A" "$(cast keccak "sla-met")" 0x)"
say "  status       $(cast call "$ESCROW" "jobs(uint256)(uint256,address,address,address,string,uint256,uint256,uint8,address)" "$JOB_A" --rpc-url "$RPC" | tail -2 | head -1)  (3 = Completed)"

# ── job B: a missed SLA cannot be settled, and the escrow comes back ─────────
say ""
if [[ "${SKIP_JOB_B:-0}" == "1" ]]; then
  say ""
  say "(SKIP_JOB_B=1 — settlement-only run; the expiry half was proven in job 2)"
else
say "═══ Job B — missed SLA, blocked settlement, refund after expiry ═══"
EXPIRY_B="$(( $(date +%s) + JOB_B_WAIT ))"
TX="$(send "$CLIENT_PK" "$ESCROW" "createJob(address,address,uint256,string,address)" \
  "$PROVIDER" "$EVALUATOR" "$EXPIRY_B" "OpenBook mainnet proof — stale SLA (blocked)" "$HOOK")"
JOB_B="$(cast call "$ESCROW" "jobCounter()(uint256)" --rpc-url "$RPC" | awk '{print $1}')"
say "  createJob    job $JOB_B  tx $TX"
say "  setBudget    tx $(send "$PROVIDER_PK" "$ESCROW" "setBudget(uint256,uint256,bytes)" "$JOB_B" "$BUDGET" 0x)"
say "  approve      tx $(send "$CLIENT_PK" "$USDC" "approve(address,uint256)" "$ESCROW" "$BUDGET")"
say "  fund         tx $(send "$CLIENT_PK" "$ESCROW" "fund(uint256,bytes)" "$JOB_B" 0x)"
say "  submit       tx $(send "$PROVIDER_PK" "$ESCROW" "submit(uint256,bytes32,bytes)" "$JOB_B" "$DELIVERABLE" 0x)"
STALE_META="$(( BLOCK > 5000000 ? BLOCK - 5000000 : 1 ))"
say "  attest       tx $(send "$ATTESTER_PK" "$HOOK" "attest(uint256,bytes32,uint256,uint256)" "$JOB_B" "$DELIVERABLE" "$STALE_META" "$BLOCK")  (metaBlock $STALE_META < minBlock $BLOCK = stale)"
say ""
say "  → simulating complete on the stale job (expect the hook's SlaNotMet revert):"
if OUT="$(cast call "$ESCROW" "complete(uint256,bytes32,bytes)" "$JOB_B" "$(cast keccak "sla-missed")" 0x --rpc-url "$RPC" --from "$EVALUATOR" 2>&1)"; then
  fail "complete did NOT revert on a stale attestation — the SLA hook is not enforcing"
else
  say "    reverted ✓  $(printf '%s' "$OUT" | grep -oiE "SlaNotMet|0x[0-9a-f]{8}" | head -1)"
fi

WAIT="$(( EXPIRY_B - $(date +%s) + 3 ))"
if (( WAIT > 0 )); then
  say ""
  say "  waiting ${WAIT}s for expiry before the permissionless refund…"
  sleep "$WAIT"
fi
say "  claimRefund  tx $(send "$CLIENT_PK" "$ESCROW" "claimRefund(uint256)" "$JOB_B")  (anyone may call it; refunds the client)"
say "  status       $(cast call "$ESCROW" "jobs(uint256)(uint256,address,address,address,string,uint256,uint256,uint8,address)" "$JOB_B" --rpc-url "$RPC" | tail -2 | head -1)  (5 = Expired)"
fi

# ── the money ───────────────────────────────────────────────────────────────
BAL_CLIENT_1="$(cast call "$USDC" "balanceOf(address)(uint256)" "$CLIENT" --rpc-url "$RPC" | awk '{print $1}')"
BAL_PROVIDER_1="$(cast call "$USDC" "balanceOf(address)(uint256)" "$PROVIDER" --rpc-url "$RPC" | awk '{print $1}')"
say ""
say "═══ USDC on Arc mainnet (6dp) ═══"
say "  client    $BAL_CLIENT_0 → $BAL_CLIENT_1   (paid $BUDGET on job $JOB_A${JOB_B:+, refunded on job $JOB_B})"
say "  provider  $BAL_PROVIDER_0 → $BAL_PROVIDER_1   (settled from job $JOB_A, net of the ${FEE_BP}bp venue fee)"
say "  policy    $(cast call "$USDC" "balanceOf(address)(uint256)" "${VITE_POLICY_WALLET:-0x651255FCc762A032237e8D14838bA9f18a7171af}" --rpc-url "$RPC" | awk '{print $1}')   (venue fees collected so far)"
say ""
say "Explorer: $EXPLORER/address/$ESCROW"
say "Jobs:     A=$JOB_A settled${JOB_B:+, B=$JOB_B blocked-then-refunded}"
