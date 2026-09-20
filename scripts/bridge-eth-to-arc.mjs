#!/usr/bin/env node
/**
 * Bridge USDC from Ethereum mainnet to Arc mainnet with Circle's App Kit (CCTP).
 *
 * Source:      Ethereum mainnet (chain "Ethereum"), key ETH_MAINNET_PK
 * Destination: Arc mainnet (chain "Arc"), key ARC_MAINNET_PK — the Arc deployer, so the
 *              USDC lands on the address that pays for the contract deploys.
 *
 *   node scripts/bridge-eth-to-arc.mjs --amount 6            # plan only, confirms nothing
 *   node scripts/bridge-eth-to-arc.mjs --amount 6 --yes      # sends (real money)
 *   node scripts/bridge-eth-to-arc.mjs --resume <result.json>  # resume a soft-failed transfer
 *
 * Costs: Ethereum gas for approve + burn (needs a little ETH in the source wallet), then
 * the Arc mint is ~$0.004 of USDC. Fast mode, ~8-20 seconds after the burn.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inspect } from "node:util";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = new URL("..", import.meta.url).pathname;
const RESULT_PATH = "/tmp/bridge-eth-to-arc.json";

/** Read `KEY=value` lines from the repo `.env` without pulling in a dependency. */
function envFromFile(path) {
  try {
    const out = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[2] && !m[2].startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const fileEnv = envFromFile(`${ROOT}.env`);
const env = (name) => (process.env[name] ?? fileEnv[name] ?? "").trim();

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const amount = value("amount") ?? "6";
const confirmed = flag("yes");
const resumePath = value("resume");

const kit = new AppKit();

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Resolve both adapters; the destination prints even when the source key is still missing. */
async function resolve() {
  const sourceKey = env("ETH_MAINNET_PK");
  const destKey = env("ARC_MAINNET_PK");
  if (!/^0x[0-9a-fA-F]{64}$/.test(destKey)) {
    console.error("missing: ARC_MAINNET_PK — the Arc deployer key in the repo .env (run scripts/deploy-mainnet.sh --check).");
    process.exit(2);
  }
  // Addresses come from the keys directly: the adapter's getAddress() wants an
  // OperationContext chain, and for a private-key adapter the address is just the EOA.
  const destination = createViemAdapterFromPrivateKey({ privateKey: destKey });
  const to = privateKeyToAccount(destKey).address;
  const hasSource = /^0x[0-9a-fA-F]{64}$/.test(sourceKey);
  const source = hasSource ? createViemAdapterFromPrivateKey({ privateKey: sourceKey }) : null;
  const from = hasSource ? privateKeyToAccount(sourceKey).address : null;
  return { source, from, destination, to };
}

async function main() {
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) {
    console.error(`bad --amount: ${amount}`);
    process.exit(2);
  }

  if (resumePath) {
    const saved = JSON.parse(readFileSync(resumePath, "utf8"));
    const { source, destination } = await resolve();
    if (!source) {
      console.error("missing: ETH_MAINNET_PK — the source adapter has to be rebuilt to resume. Nothing was sent.");
      process.exit(2);
    }
    console.log(`resuming ${resumePath} — retryBridge continues at the failed step, no double spend`);
    const result = await kit.retryBridge(saved, { from: source, to: destination });
    writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
    console.log("RESULT", inspect(result, false, null, true));
    return;
  }

  const { source, from, destination, to } = await resolve();

  // Fail before spending anything if this SDK build doesn't know the two chains.
  const known = (await kit.getSupportedChains()).map((c) => c.chain ?? c.name);
  const missing = ["Ethereum", "Arc"].filter((name) => !known.includes(name));
  if (missing.length > 0) {
    console.error(`this App Kit build does not know: ${missing.join(", ")} — known: ${known.join(", ")}`);
    process.exit(2);
  }

  console.log("Plan — USDC over CCTP v2, fast mode");
  console.log(`  from   Ethereum mainnet  ${from ?? "(no ETH_MAINNET_PK yet)"}`);
  console.log(`  to     Arc mainnet       ${to}   ← the deployer`);
  console.log(`  amount ${amount} USDC`);
  console.log("Costs: Ethereum gas for approve + burn (ETH), ~$0.004 USDC for the Arc mint.");

  if (!source) {
    console.error("\nmissing: ETH_MAINNET_PK — the Ethereum wallet holding the USDC (and a little ETH for gas).");
    console.error("Set it in .env or the environment, then re-run. Nothing was sent.");
    process.exit(2);
  }
  if (Number(amount) > 100) {
    console.error("refusing: >100 USDC on mainnet without a manual review");
    process.exit(2);
  }
  if (!confirmed) {
    console.log("\nPlan only — nothing was sent. Re-run with --yes to bridge (real mainnet funds).");
    return;
  }

  let result;
  try {
    result = await kit.bridge({
      from: { adapter: source, chain: "Ethereum" },
      to: { adapter: destination, chain: "Arc" },
      amount,
    });
  } catch (err) {
    // A hard error throws (validation/config) and nothing moved.
    console.error("bridge failed before any transfer:", err instanceof Error ? err.message : String(err));
    console.error("If the chain name was rejected, the message above lists the names this SDK version knows.");
    process.exit(1);
  }

  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  console.log(`\nresult saved to ${RESULT_PATH}`);
  for (const step of result.steps ?? []) {
    console.log(`  ${step.name}: ${step.state}${step.txHash ? `  ${step.txHash}` : ""}`);
    if (step.explorerUrl) console.log(`      ${step.explorerUrl}`);
  }
  console.log(`  state: ${result.state}`);

  const failed = (result.steps ?? []).some((s) => s.state !== "success" && s.state !== "noop");
  if (failed || result.state !== "success") {
    console.error(`\nnot complete — do NOT bridge again from scratch. Resume with:`);
    console.error(`  node scripts/bridge-eth-to-arc.mjs --resume ${RESULT_PATH}`);
    process.exit(1);
  }

  console.log(`\nbridged. The deployer now holds Arc mainnet USDC — next: ARC_MAINNET_BROADCAST=1 bash scripts/deploy-mainnet.sh`);
}

await main();
