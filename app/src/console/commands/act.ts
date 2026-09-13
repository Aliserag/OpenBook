/**
 * Act commands (T8) — the keyless real purchase lifecycle over the demo
 * signer (VITE_DEMO_BUYER_KEY via walletForDemo, injected wallet fallback):
 *
 *   buy      quote + fund an ERC-8183 job at exactly the ENS price
 *            (subname-first `${dataset.id}.${CONFIG.ens}` over the parent,
 *            identical to `quote`). sla.minBlock = dataset-chain head − the
 *            live ENS maxBlockLag window; hook = ADDR.hook (our SlaHook).
 *   deliver  gateway query (existing step-3 path) capturing payloadHash +
 *            _meta.block, then SUBMIT the deliverable onchain — the SlaHook
 *            binds completion to the submitted hash, so submission is part of
 *            the real lifecycle (mirrors agent/buyer-cli.ts).
 *   settle   attestDelivery (hook freshness proof) → verifyDelivery(settle:
 *            true) → print the verdict, the settle/refund tx, and the
 *            receipt-derived fee split.
 *
 * Guard convention (spec S9): every failed source renders a per-row `✗
 * reason`, never an invented figure. Failure paths print the EXACT contract
 * revert reason via classifyRevert (naming SlaHook + PolicyWallet selectors;
 * the T9 sandbox re-exports it from here — act's own failure paths need it,
 * so it lives with them).
 */
import { BaseError, keccak256, parseAbi, toBytes, type Address, type PublicClient, type WalletClient } from "viem";
import { CONFIG, defaultQueryFor, type DatasetConfig } from "../../config";
import { env } from "../../env";
import { attestViaApi, circleCreateJob, circleSetBudget, circleStatus, circleSubmit, deliverViaApi, hasGatewayAccess } from "../../data/api";
import { readHookAttester } from "../../data/hook";
import { ADDR } from "../../data/addresses";
import { getProvider, arcWalletClient, ensureArcChain } from "../../arc";
import { walletForDemo } from "../../data/chain";
import { feeSplitFromReceipt, freshnessRuler, platformFee } from "../../data/escrow";
import { POLICY_REVERT_SELECTORS } from "../../data/policy";
import { truncateHash, usdc6 } from "../../format";
import {
  createEnsTextReader,
  parsePriceToAmount6dec,
  parseSlaRecord,
  type EnsTextReader,
} from "../../../../mcp/src/ens";
import { defaultChainHeadResolver } from "../../../../mcp/src/chainhead";
import {
  ERC8183_ABI,
  createJobWithSla,
  escrowAddress,
  getJob,
  packSla,
  submitDeliverable,
  type Sla,
} from "../../../../agent/escrow";
import { verifyDelivery, type VerifyDeliveryResult } from "../../../../mcp/src/escrow";
import { register, type Command, type CommandContext, type CommandResult, type KvRow } from "../registry";
import type { SignerKind } from "../../data/types";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Value of a --flag that appears after the command name; undefined when absent. */
function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag, 1);
  return at >= 0 ? argv[at + 1] : undefined;
}

// One reader for the console: live ENSv2 reads on Sepolia (same as inspect).
const SEPOLIA_ENS = createEnsTextReader({ rpcUrl: env.sepoliaRpc });

const BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256", name: "" }],
  },
] as const;

/**
 * Trimmed 6dp display: raw 6-dec USDC units → no forced 2dp ("0.003", "0.15",
 * "1"). Mirrors agent/sell-cli.ts's `usdc6decToDisplay` for money surfaces
 * where usdc6's 2dp would read as a zero fee (treasury 3000 raw = 0.003, not
 * 0.00). sell-cli is not imported — its module drags node:fs/path/child_process
 * into the browser bundle; this 2-line twin is deliberate and pinned by test.
 */
export function usdcTrim(value: bigint | number | string): string {
  return (Number(value) / 1_000_000).toString();
}

/* ------------------------------------------------------------------ args */

export interface BuyArgs {
  datasetId: string;
  /** 6-dec raw USDC units · exactly what `quote <id>` shows */
  amountUsdc: number;
  /** the buyer's freshness demand as a block window on the dataset's chain (overrides the seller's window) */
  lagBlocks?: number;
  /** seconds the buyer asked for, kept for the receipt */
  freshSeconds?: number;
  /** 6-dec cap the buyer set with --max; the quote was checked against it */
  maxUsdc?: number;
  /** a name filter on the data (a pool name, a team): the query narrows to it */
  match?: string;
}

/** Public RPCs the browser may read a chain head from (CORS-open); the block time is used for freshness math. */
const CHAIN_RPC: Record<"arbitrum" | "ethereum", string> = { arbitrum: "https://arb1.arbitrum.io/rpc", ethereum: "https://ethereum-rpc.publicnode.com" };

/** The chain head as the buyer's clock sees it: number and how many seconds old its timestamp already is. */
export async function chainHeadWithAge(chain: "arbitrum" | "ethereum"): Promise<{ number: number; ageSeconds: number }> {
  const res = await fetch(CHAIN_RPC[chain], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }) });
  const body = (await res.json()) as { result?: { number: string; timestamp: string } };
  if (!body.result) throw new Error(`no head from the ${chain} rpc`);
  return { number: parseInt(body.result.number, 16), ageSeconds: Math.max(0, Date.now() / 1000 - parseInt(body.result.timestamp, 16)) };
}

/**
 * The floor for a freshness window measured in wall-clock time: the first
 * block that is at most `windowSeconds` old. When the newest block is already
 * older than the window the floor lands past the head, and no delivery can
 * clear it: the demand is impossible for any seller on that chain.
 */
export function floorForWindow(head: { number: number; ageSeconds: number }, windowSeconds: number, chain: "arbitrum" | "ethereum"): number {
  const blocksBack = Math.floor((windowSeconds - head.ageSeconds) / SECONDS_PER_BLOCK[chain]);
  return head.number - blocksBack;
}

/** The query for a purchase: the dataset's default, narrowed to a name when the buyer named one. */
export function queryFor(dataset: DatasetConfig, match?: string): string {
  const m = match === undefined ? undefined : match.replace(/["\\]/g, "").trim();
  const where = (extra: string) => (m ? `where: {${extra}${extra ? ", " : ""}name_contains_nocase: "${m}"}` : extra ? `where: {${extra}}` : "");
  switch (dataset.schema) {
    case "dex-amm/4.0.1":
      return `{ liquidityPools(first: 3, orderBy: totalValueLockedUSD, orderDirection: desc${m ? `, ${where("")}` : ""}) { name totalValueLockedUSD inputTokens { symbol lastPriceUSD } } }`;
    case "lending/3.1.0":
      return `{ markets(first: 3, orderBy: totalValueLockedUSD, orderDirection: desc${m ? `, ${where("")}` : ""}) { id name totalValueLockedUSD rates { rate side type } } }`;
    case "sports-odds/1.0.0":
      return `{ sportMarkets(first: 3, orderBy: timestamp, orderDirection: desc, where: {isOpen: true${m ? `, homeTeam_contains_nocase: "${m}"` : ""}}) { homeTeam awayTeam homeOdds awayOdds } }`;
    case "nft-marketplace/2.1.0":
      return `{ trades(first: 3, orderBy: timestamp, orderDirection: desc${m ? `, where: {collection_: {name_contains_nocase: "${m}"}}` : ""}) { timestamp priceETH tokenId collection { id name } } }`;
    case "ens/1.0.0":
      return `{ registrations(first: 3, orderBy: registrationDate, orderDirection: desc${m ? `, where: {domain_: {name_contains_nocase: "${m}"}}` : ""}) { registrationDate cost domain { name } } }`;
    default:
      return defaultQueryFor(dataset);
  }
}

/** One line per delivered row, readable on a receipt: the thing the buyer paid for. */
export function summarizeData(schema: string, data: unknown): string[] {
  const root = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const usd = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 })}` : "?"; };
  if (schema === "dex-amm/4.0.1" && Array.isArray(root["liquidityPools"])) {
    return (root["liquidityPools"] as Array<Record<string, unknown>>).map((p) => {
      const toks = (Array.isArray(p["inputTokens"]) ? (p["inputTokens"] as Array<Record<string, unknown>>) : []).map((t) => `${String(t["symbol"])} ${usd(t["lastPriceUSD"])}`).join(" · ");
      return `${String(p["name"])} · TVL ${usd(p["totalValueLockedUSD"])} · ${toks}`;
    });
  }
  if (schema === "lending/3.1.0" && Array.isArray(root["markets"])) {
    return (root["markets"] as Array<Record<string, unknown>>).map((p) => {
      const rates = Array.isArray(p["rates"]) ? (p["rates"] as Array<Record<string, unknown>>) : [];
      const pick = (side: string) => rates.find((r) => r["side"] === side && r["type"] === "VARIABLE");
      const pct = (r: Record<string, unknown> | undefined) => (r === undefined ? "" : `${Number(r["rate"]).toFixed(2)}%`);
      const supply = pick("LENDER");
      const borrow = pick("BORROWER");
      const tail = supply || borrow ? ` · supply ${pct(supply) || "?"} · borrow ${pct(borrow) || "?"}` : "";
      return `${String(p["name"])} · TVL ${usd(p["totalValueLockedUSD"])}${tail}`;
    });
  }
  const ago = (ts: unknown) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - Number(ts)));
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  };
  if (schema === "nft-marketplace/2.1.0" && Array.isArray(root["trades"])) {
    return (root["trades"] as Array<Record<string, unknown>>).map((t) => {
      const col = t["collection"] as Record<string, unknown> | null;
      const c = col?.["name"] ? String(col["name"]) : col?.["id"] ? `collection ${String(col["id"]).slice(0, 6)}…${String(col["id"]).slice(-4)}` : "collection";
      const eth = Number(t["priceETH"]);
      return `${c} · ${Number.isFinite(eth) ? `${eth.toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH` : "?"} · ${ago(t["timestamp"])}`;
    });
  }
  if (schema === "ens/1.0.0" && Array.isArray(root["registrations"])) {
    return (root["registrations"] as Array<Record<string, unknown>>).map((r) => {
      const name = (r["domain"] as Record<string, unknown> | null)?.["name"];
      const eth = Number(r["cost"]) / 1e18;
      return `${name ? String(name) : "?"} · registered ${ago(r["registrationDate"])}${Number.isFinite(eth) && eth > 0 ? ` · ${eth.toFixed(4)} ETH` : ""}`;
    });
  }
  if (schema === "sports-odds/1.0.0" && Array.isArray(root["sportMarkets"])) {
    return (root["sportMarkets"] as Array<Record<string, unknown>>).map((p) => {
      const pct = (v: unknown) => `${(Number(v) / 1e16).toFixed(1)}%`;
      return `${String(p["homeTeam"])} vs ${String(p["awayTeam"])} · home ${pct(p["homeOdds"])} · away ${pct(p["awayOdds"])}`;
    });
  }
  const first = Object.values(root)[0];
  if (Array.isArray(first)) return first.slice(0, 3).map((r) => JSON.stringify(r).slice(0, 120));
  return [JSON.stringify(root).slice(0, 160)];
}

/** Arbitrum blocks are about a quarter second, Ethereum blocks twelve. */
const SECONDS_PER_BLOCK: Record<"arbitrum" | "ethereum", number> = { arbitrum: 0.25, ethereum: 12 };

/** "--fresh 10" → the block window on the dataset's chain, never below one block. */
export function freshnessToBlocks(seconds: number, chain: "arbitrum" | "ethereum"): number {
  return Math.max(1, Math.round(seconds / SECONDS_PER_BLOCK[chain]));
}

export interface DatasetQuote {
  /** raw svc.price record (e.g. "0.10 USDC/query") */
  price: string;
  /** the ENS name whose svc.price record answered (the dataset subname or the parent) */
  priceName: string;
  amountUsdc: number;
  maxBlockLag: number;
  maxLatencyMs: number;
  /** svc.payee (subname, then the parent): who a buyer with its own wallet pays */
  payee: Address | null;
}

/**
 * Subname-first svc record resolution (`<dataset>.openbook.eth` over the
 * parent storefront): a SET subname record wins; a subname that is unset or
 * failed falls back to the parent. M4 consolidation note: marketplace M4 adds
 * a shared `resolveDatasetRecords` to mcp/src/ens.ts — this local pure helper
 * is the console-side twin built to be replaced by it.
 */
export function resolveDatasetRecord(sub: string | null, parent: string | null): string | null {
  return sub ?? parent;
}

/** ENS read that reports resolution failures instead of throwing (probe style). */
type EnsProbe = { ok: true; value: string | null } | { ok: false; reason: string };

async function probeEns(
  readEnsText: EnsTextReader,
  name: string,
  key: string,
): Promise<EnsProbe> {
  try {
    return { ok: true, value: await readEnsText(name, key) };
  } catch (error) {
    return { ok: false, reason: reason(error) };
  }
}

/**
 * Subname-over-parent merge with the failure edge `quote` uses (inspect.ts's
 * firstNonNull semantics): a SET subname wins; a resolved-but-unset subname
 * falls back to the parent; a FAILED subname read falls back to the parent
 * too — the charge must equal the quote even when a record read fails; only
 * when BOTH fail is the resolution refused.
 */
function firstNonNull(
  primary: EnsProbe,
  fallback: EnsProbe,
): { value: string | null; failed?: string } {
  if (primary.ok && primary.value !== null) return { value: primary.value };
  if (fallback.ok && fallback.value !== null) return { value: fallback.value };
  if (primary.ok || fallback.ok) return { value: null };
  return { value: null, failed: primary.reason };
}

/**
 * Live quote for one dataset — price, amount and the SLA window, all from
 * ENSv2 with the subname-first resolution `quote` uses, INCLUDING the failure
 * edge: an unset record falls back to the parent and a failed read falls back
 * to the parent too (quote == charge); only when subname AND parent both fail
 * (or both are unset) is the buy refused — never a hard-coded value.
 */
export async function resolveDatasetQuote(
  dataset: DatasetConfig,
  readEnsText: EnsTextReader,
): Promise<DatasetQuote> {
  const sub = `${dataset.id}.${CONFIG.ens}`;
  const [subPrice, subSla, rootPrice, rootSla, subPayee, rootPayee] = await Promise.all([
    probeEns(readEnsText, sub, "svc.price"),
    probeEns(readEnsText, sub, "svc.sla"),
    probeEns(readEnsText, CONFIG.ens, "svc.price"),
    probeEns(readEnsText, CONFIG.ens, "svc.sla"),
    probeEns(readEnsText, sub, "svc.payee"),
    probeEns(readEnsText, CONFIG.ens, "svc.payee"),
  ]);
  const payeeRaw = firstNonNull(subPayee, rootPayee);
  const payee = !payeeRaw.failed && payeeRaw.value !== null && /^0x[0-9a-fA-F]{40}$/.test(payeeRaw.value.trim()) ? (payeeRaw.value.trim() as Address) : null;
  const price = firstNonNull(subPrice, rootPrice);
  if (price.failed) {
    throw new Error(`svc.price is unreachable (${price.failed}) · refusing to buy at a hard-coded price`);
  }
  if (price.value === null) {
    throw new Error(
      `svc.price is not set on ${sub} (nor ${CONFIG.ens}) · refusing to buy at a hard-coded price`,
    );
  }
  const sla = firstNonNull(subSla, rootSla);
  if (sla.failed) {
    throw new Error(`svc.sla is unreachable (${sla.failed}) · no freshness window to floor the SLA`);
  }
  if (sla.value === null) {
    throw new Error(
      `svc.sla is not set on ${sub} (nor ${CONFIG.ens}) · no freshness window to floor the SLA`,
    );
  }
  const amountUsdc = parsePriceToAmount6dec(price.value);
  const parsedSla = parseSlaRecord(sla.value);
  return {
    price: price.value,
    priceName: subPrice.ok && subPrice.value !== null ? sub : CONFIG.ens,
    amountUsdc,
    maxBlockLag: parsedSla.maxBlockLag,
    maxLatencyMs: parsedSla.maxLatencyMs,
    payee,
  };
}

/**
 * Parse `<dataset> [--amount <usdc>]`. The amount DEFAULTS to the live ENS
 * price (subname-first, exactly what `quote` shows); `--amount` overrides it.
 * Unknown datasets and unreadable prices throw with the reason.
 */
export async function parseBuyArgs(
  argv: string[],
  readEnsText: EnsTextReader,
): Promise<BuyArgs> {
  const id = argv[1];
  if (!id) throw new Error("usage: buy <dataset> [--max <usdc>] [--fresh <seconds>] · try datasets");
  const dataset = CONFIG.datasets.find((d) => d.id === id);
  if (!dataset) throw new Error(`unknown dataset: ${id} · try datasets`);
  const quote = await resolveDatasetQuote(dataset, readEnsText);
  const extra: Pick<BuyArgs, "lagBlocks" | "freshSeconds" | "maxUsdc" | "match"> = {};
  const fresh = flagValue(argv, "--fresh");
  if (fresh !== undefined) {
    const seconds = parseFloat(fresh);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`invalid --fresh "${fresh}" · seconds, e.g. 10`);
    extra.freshSeconds = seconds;
    extra.lagBlocks = freshnessToBlocks(seconds, dataset.chain);
  }
  const max = flagValue(argv, "--max");
  if (max !== undefined) {
    const cap = Math.round(parseFloat(max.replace(/[^0-9.]/g, "")) * 1_000_000);
    if (!Number.isFinite(cap) || cap <= 0) throw new Error(`invalid --max "${max}" · a USDC number, e.g. 0.10`);
    extra.maxUsdc = cap;
    if (quote.amountUsdc > cap) {
      throw new Error(`${quote.priceName} asks ${usdc6(quote.amountUsdc)} USDC per query, above your cap of ${usdc6(cap)} · nothing bought`);
    }
  }
  const match = flagValue(argv, "--match");
  if (match !== undefined && match.trim().length > 0) extra.match = match.trim();
  const raw = flagValue(argv, "--amount");
  if (raw !== undefined) {
    const parsed = Math.round(parseFloat(raw) * 1_000_000);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`invalid --amount "${raw}" · a positive USDC number (e.g. 0.10)`);
    }
    return { datasetId: dataset.id, amountUsdc: parsed, ...extra };
  }
  return { datasetId: dataset.id, amountUsdc: quote.amountUsdc, ...extra };
}

/* ------------------------------------------------------------------ buy */

/**
 * Pure buy guard: signer kind + USDC balance vs the charge. The copy is
 * pinned by act.test.ts — the demo key guidance (VITE_DEMO_BUYER_KEY) and
 * the faucet (faucet.circle.com) are the two actionable recovery paths.
 */
export function canBuy(input: {
  signer: SignerKind;
  balance: bigint;
  amount: bigint;
}): { ok: true } | { ok: false; reason: string } {
  if (input.signer === "none") {
    return { ok: false, reason: "no signer · connect a wallet or set VITE_DEMO_BUYER_KEY" };
  }
  if (input.balance < input.amount) {
    return {
      ok: false,
      reason:
        `low USDC balance (${usdc6(input.balance)} < ${usdc6(input.amount)}) · ` +
        "fund the buyer from faucet.circle.com (Arc testnet) and retry",
    };
  }
  return { ok: true };
}

/**
 * Who signs the act commands. A `circle` signer holds no key in the browser:
 * the buyer and the seller are Circle developer-controlled wallets on Arc and
 * every transaction is signed on the server (`/api/circle/*`), gas sponsored
 * by Circle Gas Station — the same path the page's Try section uses.
 */
export type Signer =
  | { kind: "demo" | "injected"; wallet: WalletClient; address: Address }
  | { kind: "circle"; address: Address; seller: Address };

/** The `signer` receipt row: who pays, and (for Circle) who is paid. */
export function describeSigner(signer: Signer): string {
  if (signer.kind === "circle") {
    return `Circle buyer wallet ${truncateHash(signer.address)} · seller wallet ${truncateHash(signer.seller)} · gas sponsored by Circle Gas Station`;
  }
  if (signer.kind === "injected") {
    return `your wallet ${signer.address} · you sign each step · gas is Arc's native USDC, paid by your wallet`;
  }
  return `${signer.kind} ${truncateHash(signer.address)}`;
}

/**
 * Keyless signer: the deployment's Circle wallets win (the browser signs
 * nothing), then the demo key (walletForDemo), then a connected injected
 * wallet (Arc chain added on demand). The instructive error names both
 * recovery paths. Addresses come from the wallet itself, never guessed.
 */
export async function resolveSigner(): Promise<{ ok: true; signer: Signer } | { ok: false; reason: string }> {
  // a wallet the reader connected wins: they asked to pay with their own money
  const provider = typeof window !== "undefined" ? getProvider() : undefined;
  if (provider) {
    try {
      const accounts = (await provider.request({ method: "eth_accounts" })) as string[] | null;
      if (accounts && accounts.length > 0) {
        const address = accounts[0] as Address;
        return { ok: true, signer: { kind: "injected", wallet: arcWalletClient(address), address } };
      }
    } catch {
      // provider present but unreadable: fall through to the keyless paths
    }
  }
  const circle = await circleStatus();
  if (circle.enabled && circle.buyer && circle.seller) {
    return { ok: true, signer: { kind: "circle", address: circle.buyer, seller: circle.seller } };
  }
  const demo = walletForDemo();
  if (demo?.account) {
    return { ok: true, signer: { kind: "demo", wallet: demo, address: demo.account.address } };
  }
  if (provider) {
    return { ok: false, reason: "browser wallet found but no connected account · connect it (Arc testnet) and retry" };
  }
  return { ok: false, reason: "no signer · connect a wallet or set VITE_DEMO_BUYER_KEY" };
}

const JOB_CREATED_TOPIC = keccak256(toBytes("JobCreated(uint256,address,address,address,uint256,address)"));
const USDC_SPEND_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/**
 * Marketplace purchase from the reader's own wallet: the wallet opens the job
 * naming the ENS payee (the seller's Circle wallet) as provider and the hook's
 * attester as evaluator, the seller quotes it through the server (setBudget),
 * then the wallet approves and funds. Three signatures in the wallet; gas is
 * Arc's native USDC, paid by the wallet.
 */
export async function walletOpenJob(
  publicClient: PublicClient,
  signer: { wallet: WalletClient; address: Address },
  p: { datasetId: string; payee: Address; evaluator: Address; sla: Sla; amount6dec: bigint; expirySeconds: number },
  trace: KvRow[],
): Promise<bigint> {
  const { timestamp } = await publicClient.getBlock();
  const expiredAt = timestamp + BigInt(p.expirySeconds);
  const chain = signer.wallet.chain;
  const account = signer.wallet.account ?? signer.address;
  const send = async (label: string, tx: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<`0x${string}`> => {
    const hash = await signer.wallet.writeContract({ address: tx.address, abi: tx.abi as never, functionName: tx.functionName, args: tx.args as never, account, chain } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
    trace.push([label, `${hash} · signed in your wallet`]);
    return hash;
  };
  const createHash = await send("createJob", {
    address: escrowAddress(),
    abi: ERC8183_ABI,
    functionName: "createJob",
    args: [p.payee, p.evaluator, expiredAt, packSla(p.sla), ADDR.hook],
  });
  const receipt = await publicClient.getTransactionReceipt({ hash: createHash });
  const log = receipt.logs.find((l) => l.address.toLowerCase() === escrowAddress().toLowerCase() && l.topics[0] === JOB_CREATED_TOPIC);
  if (!log?.topics[1]) throw new Error("createJob succeeded but the JobCreated log is missing");
  const jobId = BigInt(log.topics[1]);
  const budgetTx = await circleSetBudget({ jobId: jobId.toString(), datasetId: p.datasetId, amount: p.amount6dec.toString() });
  trace.push(["setBudget", `${budgetTx} · the seller's Circle wallet quoted the job, gas sponsored`]);
  const allowance = (await publicClient.readContract({ address: ADDR.usdc, abi: USDC_SPEND_ABI, functionName: "allowance", args: [signer.address, escrowAddress()] })) as bigint;
  if (allowance < p.amount6dec) {
    await send("approve", { address: ADDR.usdc, abi: USDC_SPEND_ABI, functionName: "approve", args: [escrowAddress(), p.amount6dec * 200n] });
  }
  await send("fund", { address: escrowAddress(), abi: ERC8183_ABI, functionName: "fund", args: [jobId, "0x"] });
  return jobId;
}

/** Prepare an injected wallet's Arc chain (demo key writes go straight to the RPC). */
async function ensureChainFor(signer: Signer): Promise<void> {
  if (signer.kind === "injected") await ensureArcChain();
}

/* ------------------------------------------------------ shared job state */

/** A spent job's terminal lifecycle outcome — the record REMAINS, not erased. */
export type ActOutcome = "settled" | "refunded";

/** In-memory lifecycle state: `buy` → `deliver` → `settle` (and the T9 sandbox). */
export interface ActJob {
  datasetId: string;
  jobId: string;
  minBlock: number;
  amountUsdc: number;
  /** expiredAt in unix seconds (read back onchain · the truth) */
  deadline: bigint;
  payloadHash?: `0x${string}`;
  metaBlock?: number;
  /** the server's deliver signature (required by /api/attest) */
  proof?: string;
  /** unix seconds when the job was funded locally (recovery affordance) */
  createdAt: number;
  /** set once the job reached a terminal state (settle/refund executed) */
  outcome?: ActOutcome;
  /** the terminal tx hash (settle complete or refund), when known */
  txHash?: `0x${string}`;
  /** the --match text of the purchase, so "the same data" can repeat it */
  match?: string;
}

let actJob: ActJob | null = null;
let actJobRecovered = false;

export function setActJob(job: ActJob | null): void {
  actJob = job;
  actJobRecovered = false;
  if (job === null) clearStoredActJob();
  else persistActJob(job);
}

export function getActJob(): ActJob | null {
  return actJob;
}

/** True when the current act job was rehydrated from localStorage after a reload. */
export function isRecoveredActJob(): boolean {
  return actJobRecovered;
}

/**
 * Clear the act slot after a terminal claim — ONLY when the claimed job IS
 * the slot's job AND the slot is not already terminal. A refund of one job
 * must never wipe a different, still-unsettled purchase's state or a spent
 * job's terminal recovery record.
 */
export function clearActJobIfClaimed(active: ActJob | null, claimedJobId: string): void {
  if (active?.jobId === claimedJobId && active.outcome === undefined) setActJob(null);
}

/**
 * A spent job's recovery row — the shared copy for `status` and the
 * deliver/settle/sandbox-claim refusals: the terminal record stays ON RECORD
 * ("last job 19 · settled · tx …"), never degraded to a bare "no active job".
 */
export function actJobStatusRow(job: ActJob, recovered: boolean): { key: string; value: string } {
  if (job.outcome !== undefined) {
    const tx = job.txHash !== undefined ? ` · tx ${job.txHash.slice(0, 10)}…${job.txHash.slice(-8)}` : "";
    return {
      key: "last job",
      value: `${job.jobId} · ${job.outcome}${tx} · run buy <dataset> to start a new one`,
    };
  }
  return {
    key: recovered ? "recovered job" : "active job",
    value: `${job.jobId} · run deliver / settle (or sandbox claim after its deadline)`,
  };
}

/** Refusal shared by deliver/settle/sandbox claim once the job is spent. */
export function terminalRefusal(job: ActJob, verb: string): CommandResult {
  return {
    render: "kv",
    data: {
      rows: [
        ["job", job.jobId],
        ["outcome", job.outcome === "settled" ? "settled" : "refunded"],
        ...(job.txHash !== undefined
          ? ([["tx", `${job.txHash.slice(0, 10)}…${job.txHash.slice(-8)}`]] as KvRow[])
          : []),
      ],
      note: `${verb}: nothing left to do · the job already ${
        job.outcome === "settled" ? "settled" : "refunded"
      } · run buy <dataset> to start a new one`,
    },
  };
}

/* -------------------------------------------- act-job persistence (v1) */

const ACT_JOB_STORAGE_KEY = "openbook.actjob.v1";

/** Pure serializer · deadline is bigint, stored as a decimal string. */
export function serializeActJob(job: ActJob): string {
  return JSON.stringify({ version: 1, ...job, deadline: job.deadline.toString() });
}

/**
 * Pure deserializer with shape validation. Returns null on ANY mismatch
 * (corrupt JSON, wrong version, missing/invalid fields) — never throws, so
 * the caller can clear the bad entry instead of crashing the console mount.
 */
export function deserializeActJob(raw: string): ActJob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p["version"] !== 1) return null;
  if (typeof p["datasetId"] !== "string" || p["datasetId"].length === 0) return null;
  if (typeof p["jobId"] !== "string" || !/^[0-9]+$/.test(p["jobId"])) return null;
  if (typeof p["minBlock"] !== "number" || !Number.isInteger(p["minBlock"])) return null;
  if (typeof p["amountUsdc"] !== "number" || !Number.isInteger(p["amountUsdc"])) return null;
  if (typeof p["createdAt"] !== "number" || !Number.isInteger(p["createdAt"])) return null;
  let deadline: bigint;
  try {
    deadline = BigInt(typeof p["deadline"] === "string" ? p["deadline"] : (p["deadline"] as number));
  } catch {
    return null;
  }
  if (deadline < 0n) return null;
  const job: ActJob = {
    datasetId: p["datasetId"] as string,
    jobId: p["jobId"] as string,
    minBlock: p["minBlock"] as number,
    amountUsdc: p["amountUsdc"] as number,
    createdAt: p["createdAt"] as number,
    deadline,
  };
  if (typeof p["payloadHash"] === "string" && /^0x[0-9a-fA-F]{64}$/.test(p["payloadHash"])) {
    job.payloadHash = p["payloadHash"] as `0x${string}`;
  }
  if (typeof p["metaBlock"] === "number" && Number.isInteger(p["metaBlock"])) {
    job.metaBlock = p["metaBlock"];
  }
  if (typeof p["proof"] === "string" && /^[0-9a-f]{64}$/.test(p["proof"])) {
    job.proof = p["proof"];
  }
  if (p["outcome"] === "settled" || p["outcome"] === "refunded") {
    job.outcome = p["outcome"];
  }
  if (typeof p["txHash"] === "string" && /^0x[0-9a-fA-F]{64}$/.test(p["txHash"])) {
    job.txHash = p["txHash"] as `0x${string}`;
  }
  return job;
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null; // privacy mode / sandboxed iframe · persistence degrades to session-only
  }
}

export function persistActJob(job: ActJob): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(ACT_JOB_STORAGE_KEY, serializeActJob(job));
  } catch {
    // quota/availability — the in-memory job still drives this session
  }
}

export function clearStoredActJob(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(ACT_JOB_STORAGE_KEY);
  } catch {
    // ignore — nothing to recover anyway
  }
}

/**
 * Read the persisted act job (injectable store for tests). A corrupt entry is
 * CLEARED and yields null — a reload must never crash the console. Runs at
 * module scope (console mount) so deliver/settle/sandbox claim keep working
 * after a page reload.
 */
export function rehydrateActJob(store?: Storage | null): ActJob | null {
  const target = store !== undefined ? store : storage();
  if (target === null) return null;
  let raw: string | null = null;
  try {
    raw = target.getItem(ACT_JOB_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const job = deserializeActJob(raw);
  if (job === null) {
    try {
      target.removeItem(ACT_JOB_STORAGE_KEY);
    } catch {
      // corrupt entry may not be removable — still yield null
    }
    return null;
  }
  return job;
}

// Console mount: rehydrate any stranded act job (a reload between buy and
// deliver/settle must not orphan the funded escrow).
{
  const recovered = rehydrateActJob();
  if (recovered !== null) {
    actJob = recovered;
    actJobRecovered = true;
  }
}

/* ----------------------------------------------------------- revert copy */

const SLA_REVERT_SELECTORS = {
  // SlaNotMet(uint256 metaBlock, uint256 minBlock) — selector for the FULL
  // signature (Solidity computes it from the parameter types).
  slaNotMet: keccak256(toBytes("SlaNotMet(uint256,uint256)")).slice(0, 10),
  notAttester: keccak256(toBytes("NotAttester()")).slice(0, 10),
  missingAttestation: keccak256(toBytes("MissingAttestation()")).slice(0, 10),
  hashMismatch: keccak256(toBytes("HashMismatch()")).slice(0, 10),
} as const;

const ERROR_STRING_SELECTOR = "0x08c379a0";

function hexToUtf8(hex: string): string {
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Name a contract revert from its raw 0x data: SlaHook errors (SlaNotMet,
 * NotAttester, MissingAttestation, HashMismatch), the PolicyWallet cap errors
 * (PerTxCapExceeded / DailyCapExceeded / NotAllowlisted), and the standard
 * Error(string) — PolicyWallet's onlyAgentOrOwner rejects with require(…,
 * "not agent"), decoded to its modifier name. Unknown data renders its hex
 * prefix, never a fabricated name.
 */
export function classifyRevert(data: `0x${string}`): string {
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === SLA_REVERT_SELECTORS.slaNotMet) return "SlaNotMet";
  if (selector === SLA_REVERT_SELECTORS.notAttester) return "NotAttester";
  if (selector === SLA_REVERT_SELECTORS.missingAttestation) return "MissingAttestation";
  if (selector === SLA_REVERT_SELECTORS.hashMismatch) return "HashMismatch";
  if (selector === POLICY_REVERT_SELECTORS.perTxCapExceeded) return "PerTxCapExceeded";
  if (selector === POLICY_REVERT_SELECTORS.dailyCapExceeded) return "DailyCapExceeded";
  if (selector === POLICY_REVERT_SELECTORS.notAllowlisted) return "NotAllowlisted";
  if (selector === ERROR_STRING_SELECTOR) {
    try {
      const body = data.slice(10);
      const offset = parseInt(body.slice(0, 64) || "0", 16); // abi.encode(string) offset word
      if (offset !== 32) return "Error(string)"; // non-standard encoding · name only
      const len = parseInt(body.slice(64, 128) || "0", 16); // length word
      const text = hexToUtf8(body.slice(128, 128 + len * 2)); // data word
      return text === "not agent" ? "onlyAgentOrOwner" : `Error(string): ${text}`;
    } catch {
      return "Error(string)";
    }
  }
  if (data.length <= 2) return "empty revert data";
  return `unknown selector ${selector}`;
}

/**
 * Extract contract revert bytes from a viem error by walking the cause chain.
 * viem 2.56.3 wraps reverts in BaseError subclasses and the raw hex lives on a
 * NESTED cause — ContractFunctionExecutionError → ContractFunctionRevertedError
 * (`.raw` is the raw hex; its `.data` is the DECODED object) → RawContractError
 * (`.data` is the hex). Reading `.data` off the top error alone is dead code.
 * Returns undefined when no node in the chain carries 0x revert data.
 */
export function walkRevertData(error: unknown): `0x${string}` | undefined {
  const hexOf = (value: unknown): `0x${string}` | undefined =>
    typeof value === "string" && value.startsWith("0x") ? (value as `0x${string}`) : undefined;
  if (!(error instanceof BaseError)) {
    // Bare non-viem payload (e.g. an RPC error surfaced through a custom
    // transport) that still carries the data field directly.
    return hexOf((error as { data?: unknown } | null | undefined)?.data);
  }
  const found = error.walk((e) => {
    const node = e as { raw?: unknown; data?: unknown };
    return typeof node.raw === "string" || typeof node.data === "string";
  }) as (Error & { raw?: unknown; data?: unknown }) | null;
  if (!found) return undefined;
  return hexOf(found.raw ?? found.data);
}

/** Failure-path formatter: name the revert when raw data is present, else the message. */
export function formatSendError(error: unknown): string {
  const hex = walkRevertData(error);
  if (hex !== undefined) {
    return `${classifyRevert(hex)} (revert data ${hex.slice(0, 10)}…)`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/* ------------------------------------------------------------------ buy */

/**
 * A purchase with a freshness demand, measured at delivery: the data is fetched
 * first, the floor is written from the chain head at that instant minus the
 * buyer's window, the job is funded and the seller submits the very delivery
 * that was fetched, then the attester settles. A window tighter than the
 * seller's real indexing lag is refused by the contract and refunded: a real
 * failure from a real demand, nothing staged.
 */
async function buyWithDemand(
  ctx: CommandContext,
  p: { dataset: DatasetConfig; quote: DatasetQuote; args: BuyArgs; signer: Signer },
  rows: KvRow[],
): Promise<CommandResult> {
  const { dataset, quote, args, signer } = p;
  const secondsPerBlock = SECONDS_PER_BLOCK[dataset.chain];
  let delivered: Awaited<ReturnType<typeof deliverViaApi>>;
  try {
    delivered = await deliverViaApi({ subgraphId: dataset.subgraphId, query: queryFor(dataset, args.match) });
    if (args.match !== undefined) rows.push(["asked for", args.match]);
    const lines = summarizeData(dataset.schema, delivered.data);
    rows.push(["data", lines.length > 0 ? lines.join("  |  ") : "no rows matched"]);
    rows.push(["delivered", `indexed at block ${delivered.metaBlock.toLocaleString("en-US")} · observed and signed by the server`]);
  } catch (error) {
    return { render: "kv", data: { rows: [...rows, ["delivered", `✗ query failed: ${reason(error)}`]] } };
  }
  let headInfo: { number: number; ageSeconds: number };
  try {
    headInfo = await chainHeadWithAge(dataset.chain);
  } catch (error) {
    return { render: "kv", data: { rows: [...rows, ["chain head", `✗ ${reason(error)} · no floor, nothing bought`]] } };
  }
  const head = headInfo.number;
  const age = head - delivered.metaBlock;
  const ageSeconds = headInfo.ageSeconds + Math.max(0, age) * secondsPerBlock;
  const floor = floorForWindow(headInfo, args.freshSeconds!, dataset.chain);
  rows.push(["data age at delivery", `${ageSeconds.toFixed(2)} s · indexed ${age} block${age === 1 ? "" : "s"} behind the ${dataset.chain} head ${head.toLocaleString("en-US")}, which is itself ${headInfo.ageSeconds.toFixed(1)} s old`]);
  rows.push(["your window", `${args.freshSeconds} s · the seller promises ${(quote.maxBlockLag * secondsPerBlock).toFixed(0)} s (${quote.maxBlockLag} blocks)`]);
  rows.push(["sla floor", `block ${floor.toLocaleString("en-US")}${floor > head ? ` · ${floor - head} blocks past the head: nothing this fresh exists yet` : ""} · the delivery ${delivered.metaBlock >= floor ? "clears it" : "is below it"}`]);
  const sla: Sla = { minBlock: floor, schemaHash: keccak256(toBytes(dataset.schema)), maxLatencyMs: quote.maxLatencyMs };
  let jobId: bigint;
  let providerAddr: Address;
  try {
    if (signer.kind === "circle") {
      const job = await circleCreateJob({ datasetId: dataset.id, minBlock: floor, schemaHash: sla.schemaHash, maxLatencyMs: sla.maxLatencyMs, amount: String(args.amountUsdc) });
      jobId = BigInt(job.jobId);
      providerAddr = signer.seller;
      rows.push(["fund", `${job.txs.fund} · job ${job.jobId} · Circle buyer wallet, gas sponsored`]);
    } else if (signer.kind === "injected" && quote.payee !== null) {
      await ensureChainFor(signer);
      const evaluator = await readHookAttester(ctx.publicClient);
      jobId = await walletOpenJob(ctx.publicClient, signer, { datasetId: dataset.id, payee: quote.payee, evaluator, sla, amount6dec: BigInt(args.amountUsdc), expirySeconds: 3600 }, rows);
      providerAddr = quote.payee;
    } else {
      return { render: "kv", data: { rows: [...rows, ["fund", "✗ a freshness demand needs the Circle wallets or a connected wallet"]] } };
    }
  } catch (error) {
    return { render: "kv", data: { rows: [...rows, ["fund", `✗ ${formatSendError(error)}`]] } };
  }
  try {
    const tx = await circleSubmit({ jobId: jobId.toString(), deliverable: delivered.payloadHash, metaBlock: delivered.metaBlock, proof: delivered.proof });
    rows.push(["submit", `${tx} · the seller's wallet submitted the delivery it fetched`]);
  } catch (error) {
    return { render: "kv", data: { rows: [...rows, ["submit", `✗ ${formatSendError(error)}`]] } };
  }
  let attested: Awaited<ReturnType<typeof attestViaApi>>;
  try {
    attested = await attestViaApi({ jobId: jobId.toString(), deliverable: delivered.payloadHash, metaBlock: delivered.metaBlock, minBlock: floor, proof: delivered.proof });
  } catch (error) {
    return { render: "kv", data: { rows: [...rows, ["attest", `✗ ${formatSendError(error)}`]] } };
  }
  const settle = attested.settle;
  const base: ActJob = { datasetId: dataset.id, jobId: jobId.toString(), minBlock: floor, amountUsdc: args.amountUsdc, deadline: 0n, payloadHash: delivered.payloadHash, metaBlock: delivered.metaBlock, proof: delivered.proof, createdAt: Math.floor(Date.now() / 1000), ...(args.match !== undefined ? { match: args.match } : {}) };
  if (settle === undefined) {
    setActJob(base);
    rows.push(["verdict", "✗ the attester posted the proof but did not settle · run `status`"]);
    return { render: "kv", data: { rows } };
  }
  if (settle.verdict === "APPROVE") {
    rows.push(["verdict", `APPROVE · ${settle.txHash}`]);
    try {
      const receipt = await ctx.publicClient.getTransactionReceipt({ hash: settle.txHash });
      const terms = await platformFee(ctx.publicClient);
      const split = feeSplitFromReceipt(receipt, terms.feeBP, providerAddr);
      rows.push(["split", `seller ${usdcTrim(split.seller)} · protocol fee ${usdcTrim(split.treasury)} · total ${usdcTrim(split.total)} USDC`]);
    } catch (error) {
      rows.push(["split", `✗ ${reason(error)}`]);
    }
    setActJob({ ...base, outcome: "settled", txHash: settle.txHash });
    return { render: "kv", data: { rows, note: `settled · the data was ${ageSeconds.toFixed(2)} s old and you allowed ${args.freshSeconds} s, so the contract paid the seller` } };
  }
  rows.push(["verdict", `REFUSED · complete() reverted ${settle.refusal ?? settle.reason ?? "SlaNotMet"} · reject() ${settle.txHash}`]);
  rows.push(["refund", `${usdc6(args.amountUsdc)} USDC back to the buyer, in full, no fee`]);
  setActJob({ ...base, outcome: "refunded", txHash: settle.txHash });
  return { render: "kv", data: { rows, note: `refunded · the data was ${ageSeconds.toFixed(2)} s old and you allowed ${args.freshSeconds} s: no seller could meet that, the contract refused to pay and the escrow returned the money · nobody asked` } };
}

const buyCommand: Command = {
  name: "buy",
  args: "<dataset> [--max <usdc>] [--fresh <seconds>] [--match <text>]",
  help: "buy one query of a dataset at its live ENS price: --match narrows the data to a name (a pool like \"WETH/USDC\", a team), --max caps what you will pay in USDC, --fresh is how old the data may be in seconds, measured against the clock at delivery (with --fresh the whole purchase runs: fund, deliver, settle or refund, one receipt). Without --fresh: fund only, then deliver, then settle.",
  kind: "act",
  run: async (ctx, argv) => {
    const rows: KvRow[] = [];
    let args: BuyArgs;
    try {
      args = await parseBuyArgs(argv, SEPOLIA_ENS);
    } catch (error) {
      return { render: "text", data: `buy: ${reason(error)}` };
    }
    const dataset = CONFIG.datasets.find((d) => d.id === args.datasetId);
    if (!dataset) return { render: "text", data: `buy: unknown dataset ${args.datasetId}` };
    rows.push(["dataset", dataset.id]);

    // The charge is the ENS quote — resolve it for the rows so the receipt
    // line matches what `quote <id>` would print.
    let quote: DatasetQuote;
    try {
      quote = await resolveDatasetQuote(dataset, SEPOLIA_ENS);
      rows.push(["ens price", quote.price]);
      rows.push(["amount", `${usdc6(args.amountUsdc)} USDC (6dp raw ${args.amountUsdc})`]);
    } catch (error) {
      return { render: "kv", data: { rows: [...rows, ["ens price", `✗ ${reason(error)}`]] } };
    }

    const signed = await resolveSigner();
    if (!signed.ok) {
      return {
        render: "kv",
        data: { rows: [...rows, ["signer", `✗ ${signed.reason}`], ["balance", "✗ not read · no signer"]] },
      };
    }
    const { signer } = signed;
    rows.push(["signer", describeSigner(signer)]);

    let balance: bigint;
    try {
      balance = (await ctx.publicClient.readContract({
        address: ADDR.usdc,
        abi: BALANCE_ABI,
        functionName: "balanceOf",
        args: [signer.address],
      })) as bigint;
      rows.push(["balance", `${usdc6(balance)} USDC`]);
    } catch (error) {
      return { render: "kv", data: { rows: [...rows, ["balance", `✗ balance read failed: ${reason(error)}`]] } };
    }
    const gate = canBuy({ signer: signer.kind, balance, amount: BigInt(args.amountUsdc) });
    if (!gate.ok) {
      return { render: "kv", data: { rows: [...rows, ["gate", `✗ ${gate.reason}`]] } };
    }

    if (args.maxUsdc !== undefined) rows.push(["your cap", `${usdc6(args.maxUsdc)} USDC · the ask ${usdc6(quote.amountUsdc)} is within it`]);
    // a freshness demand is measured at delivery: fetch first, then write the floor
    if (args.lagBlocks !== undefined && signer.kind !== "demo") return buyWithDemand(ctx, { dataset, quote, args, signer }, rows);

    // The SLA floor is a block on the DATASET's chain (data lives on
    // Arbitrum/Ethereum); the public-RPC branch avoids browser-CORS failures
    // from a keyed Alchemy app (same choice as `quote`).
    let head = 0;
    try {
      head = await defaultChainHeadResolver(undefined)(dataset.chain);
      rows.push(["chain head", `${head.toLocaleString("en-US")} (${dataset.chain})`]);
    } catch (error) {
      return {
        render: "kv",
        data: {
          rows: [...rows, ["chain head", `✗ ${reason(error)} · no SLA floor, buy refused`]],
        },
      };
    }
    const lag = args.lagBlocks ?? quote.maxBlockLag;
    const sla: Sla = {
      minBlock: head - lag,
      schemaHash: keccak256(toBytes(dataset.schema)),
      maxLatencyMs: quote.maxLatencyMs,
    };
    if (args.freshSeconds !== undefined) rows.push(["freshness demanded", `${args.freshSeconds} s = ${lag} ${dataset.chain} blocks (the seller promises ${quote.maxBlockLag})`]);
    rows.push(["sla floor", `${sla.minBlock.toLocaleString("en-US")} = head − ${lag}`]);

    let jobId: bigint;
    try {
      if (signer.kind === "circle") {
        // server-signed through Circle: createJob → setBudget → approve → fund,
        // the seller wallet as provider and the hook's attester as evaluator
        const job = await circleCreateJob({ datasetId: dataset.id, minBlock: sla.minBlock, schemaHash: sla.schemaHash, maxLatencyMs: sla.maxLatencyMs, amount: String(args.amountUsdc) });
        jobId = BigInt(job.jobId);
        rows.push(["createJob", `${job.txs.createJob} · Circle buyer wallet`]);
        rows.push(["setBudget", `${job.txs.setBudget} · Circle seller wallet`]);
        rows.push(["fund", `${job.txs.fund} · Circle buyer wallet · gas sponsored on every step`]);
      } else if (signer.kind === "injected" && quote.payee !== null && quote.payee.toLowerCase() !== signer.address.toLowerCase()) {
        // the reader's own wallet buys from the seller named by ENS
        await ensureChainFor(signer);
        const evaluator = await readHookAttester(ctx.publicClient);
        rows.push(["seller", `${quote.payee} · svc.payee of ${quote.priceName}`]);
        jobId = await walletOpenJob(ctx.publicClient, signer, { datasetId: dataset.id, payee: quote.payee, evaluator, sla, amount6dec: BigInt(args.amountUsdc), expirySeconds: 3600 }, rows);
      } else {
        await ensureChainFor(signer);
        // the hook's attester is the evaluator: it can pay or refund, the buyer cannot
        const evaluator = await readHookAttester(ctx.publicClient);
        jobId = await createJobWithSla(ctx.publicClient, {
          buyer: signer.wallet,
          provider: signer.wallet,
          evaluator,
          sla,
          amount6dec: BigInt(args.amountUsdc),
          expirySeconds: 3600,
          hook: ADDR.hook,
        });
      }
    } catch (error) {
      return {
        render: "kv",
        data: {
          rows: [...rows, ["fund", `✗ ${formatSendError(error)}`]],
          note: "the job funds via createJob → setBudget → approve → fund; a revert here names the exact onchain reason",
        },
      };
    }

    let deadline = 0n;
    try {
      deadline = (await getJob(ctx.publicClient, jobId)).expiredAt;
    } catch {
      deadline = 0n; // job created but the read-back raced · deadline unknown
    }
    const job: ActJob = {
      datasetId: dataset.id,
      jobId: String(jobId),
      minBlock: sla.minBlock,
      amountUsdc: args.amountUsdc,
      deadline,
      createdAt: Math.floor(Date.now() / 1000),
    };
    setActJob(job);
    return {
      render: "kv",
      data: {
        rows: [
          ...rows,
          ["job", job.jobId],
          ["deadline", deadline === 0n ? "unknown (read-back raced)" : job.deadline.toString()],
        ],
        note: `funded · next: deliver ${dataset.id} (captures the payload + _meta), then settle ${dataset.id} (attest + complete)`,
      },
    };
  },
};

/* -------------------------------------------------------------- deliver */

const deliverCommand: Command = {
  name: "deliver",
  args: "[dataset]",
  help: "capture the gateway payload hash + _meta.block and SUBMIT it onchain (SlaHook binds completion to it)",
  kind: "act",
  run: async (ctx, argv) => {
    const id = argv[1];
    const job = getActJob();
    if (!job) return { render: "text", data: "deliver: no active job · run buy <dataset> first" };
    if (job.outcome !== undefined) return terminalRefusal(job, "deliver");
    const dataset = CONFIG.datasets.find((d) => d.id === (id ?? job.datasetId));
    if (!dataset) return { render: "text", data: `deliver: unknown dataset ${id ?? job.datasetId}` };
    if (!hasGatewayAccess()) {
      return {
        render: "kv",
        data: {
          rows: [["dataset", dataset.id], ["gateway", "✗ delivery refused · no server route (VITE_API_BASE) and no VITE_GRAPH_GATEWAY_KEY"]],
        },
      };
    }

    const rows: KvRow[] = [["dataset", dataset.id], ["job", job.jobId]];
    let payloadHash: `0x${string}`;
    let metaBlock: number;
    let proof = "";
    try {
      const delivered = await deliverViaApi({ subgraphId: dataset.subgraphId, query: defaultQueryFor(dataset) });
      payloadHash = delivered.payloadHash;
      metaBlock = delivered.metaBlock;
      proof = delivered.proof;
      const lines = summarizeData(dataset.schema, delivered.data);
      if (lines.length > 0) rows.push(["data", lines.join("  |  ")]);
      rows.push(["payloadHash", truncateHash(payloadHash, 12, 10)]);
      rows.push(["metaBlock", metaBlock.toLocaleString("en-US")]);
      rows.push(["observed by", proof.length > 0 ? "the server (signed)" : "this browser (local key, unsigned)"]);
    } catch (error) {
      return {
        render: "kv",
        data: { rows: [...rows, ["delivery", `✗ query failed: ${reason(error)}`]] },
      };
    }

    // Freshness ruler against the SLA floor (dataset-chain head).
    try {
      const head = await defaultChainHeadResolver(undefined)(dataset.chain);
      const fresh = freshnessRuler(metaBlock, BigInt(job.minBlock), BigInt(head));
      rows.push(["freshness", fresh.ok ? `fresh (metaBlock ≥ floor)` : `stale (metaBlock < floor, delta ${fresh.delta} blocks)`]);
    } catch {
      rows.push(["freshness", "✗ chain head unreachable · freshness unknown"]);
    }

    const signed = await resolveSigner();
    if (!signed.ok) {
      setActJob({ ...job, payloadHash, metaBlock, proof });
      return {
        render: "kv",
        data: {
          rows: [...rows, ["submit", `✗ ${signed.reason} · hash captured but not submitted onchain`]],
          note: "settle needs the submitted hash onchain (SlaHook HashMismatch otherwise); set VITE_DEMO_BUYER_KEY or connect, then rerun deliver",
        },
      };
    }
    try {
      const onchain = signed.signer.kind === "circle" ? null : await getJob(ctx.publicClient, BigInt(job.jobId)).catch(() => null);
      const sellerSubmits = signed.signer.kind === "circle" || (onchain !== null && onchain.provider.toLowerCase() !== signed.signer.address.toLowerCase());
      if (sellerSubmits) {
        // the seller's Circle wallet submits, after the server re-checks the deliver signature
        const tx = await circleSubmit({ jobId: job.jobId, deliverable: payloadHash, metaBlock, proof });
        rows.push(["submit", `${tx} · the seller's Circle wallet submitted (job → Submitted)`]);
      } else if (signed.signer.kind !== "circle") {
        await ensureChainFor(signed.signer);
        const receipt = await submitDeliverable(
          ctx.publicClient,
          signed.signer.wallet,
          BigInt(job.jobId),
          payloadHash,
        );
        rows.push(["submit", `tx ${receipt.transactionHash.slice(0, 10)}…${receipt.transactionHash.slice(-8)} (job → Submitted)`]);
      }
    } catch (error) {
      return {
        render: "kv",
        data: { rows: [...rows, ["submit", `✗ ${formatSendError(error)}`]] },
      };
    }
    setActJob({ ...job, payloadHash, metaBlock, proof });
    return {
      render: "kv",
      data: { rows, note: `payload captured and submitted · next: settle ${dataset.id}` },
    };
  },
};

/* --------------------------------------------------------------- settle */

const settleCommand: Command = {
  name: "settle",
  help: "attest the delivery (hook), verify + settle onchain, print the verdict and the receipt-derived fee split",
  kind: "act",
  run: async (ctx) => {
    const job = getActJob();
    if (!job) return { render: "text", data: "settle: no active job · run buy <dataset>, then deliver" };
    if (job.outcome !== undefined) return terminalRefusal(job, "settle");
    if (job.payloadHash === undefined || job.metaBlock === undefined) {
      return { render: "text", data: "settle: no delivery captured · run deliver <dataset> first" };
    }
    const dataset = CONFIG.datasets.find((d) => d.id === job.datasetId);
    if (!dataset) return { render: "text", data: `settle: unknown dataset ${job.datasetId}` };
    const signed = await resolveSigner();
    if (!signed.ok) {
      return {
        render: "kv",
        data: {
          rows: [["signer", `✗ ${signed.reason}`]],
          note: "attest and complete both need a signer; the demo key is the planned hook attester (living-protocol T13)",
        },
      };
    }
    const { signer } = signed;

    // 1. Hook freshness proof. Until T13 sets the demo key as the hook's
    // attester, this reverts NotAttester — rendered as the exact revert
    // reason, never glossed over.
    let attested: Awaited<ReturnType<typeof attestViaApi>>;
    try {
      await ensureChainFor(signer);
      attested = await attestViaApi({ jobId: job.jobId, deliverable: job.payloadHash, metaBlock: job.metaBlock, minBlock: job.minBlock, proof: job.proof ?? "" });
    } catch (error) {
      return {
        render: "kv",
        data: {
          rows: [
            ["job", job.jobId],
            ["attest", `✗ ${formatSendError(error)}`],
          ],
          note:
            "the attester runs on the server: it verifies the job, the floor and the submitted deliverable onchain and requires the deliver signature",
        },
      };
    }

    let result: VerifyDeliveryResult;
    if (attested.settle) {
      // the attester is this job's evaluator: it already completed or refunded
      result = { verdict: attested.settle.verdict, reason: attested.settle.reason as VerifyDeliveryResult["reason"], minBlock: job.minBlock, txHash: attested.settle.txHash };
    } else if (signer.kind === "circle") {
      return {
        render: "kv",
        data: {
          rows: [["job", job.jobId], ["attest", "ok"], ["settle", "✗ the attester posted the proof but did not settle: it is not this job's evaluator"]],
          note: "a Circle purchase names the hook's attester as evaluator at createJob; this job was opened another way — settle it from the wallet that opened it",
        },
      };
    } else try {
      await ensureChainFor(signer);
      result = await verifyDelivery(
        {
          jobId: job.jobId,
          payloadHash: job.payloadHash,
          metaBlock: job.metaBlock,
          minBlock: job.minBlock,
          settle: true,
        },
        { publicClient: ctx.publicClient, walletClient: signer.wallet },
      );
    } catch (error) {
      return {
        render: "kv",
        data: {
          rows: [
            ["job", job.jobId],
            ["attest", "ok"],
            ["settle", `✗ ${formatSendError(error)}`],
          ],
        },
      };
    }

    const rows: KvRow[] = [
      ["job", job.jobId],
      ["verdict", result.verdict],
    ];
    if (result.reason !== undefined) rows.push(["reason", result.reason]);
    rows.push(["minBlock", result.minBlock.toLocaleString("en-US")]);

    if (result.txHash !== undefined) {
      rows.push(["tx", result.txHash]);
      if (result.verdict === "APPROVE") {
        try {
          const receipt = await ctx.publicClient.getTransactionReceipt({ hash: result.txHash as `0x${string}` });
          const terms = await platformFee(ctx.publicClient);
          // Circle: the seller wallet is the provider. Single-key operation:
          // the signer is buyer, provider and evaluator (legal per the verified
          // spec), so the seller side of the split is the funding address.
          const providerAddr = signer.kind === "circle" ? signer.seller : ((await getJob(ctx.publicClient, BigInt(job.jobId)).catch(() => null))?.provider ?? signer.address);
          const split = feeSplitFromReceipt(receipt, terms.feeBP, providerAddr);
          // Trimmed 6dp: a 3000-raw treasury fee is 0.003, never "0.00" (usdc6
          // rounds to 2dp and would read as "no fee"); raw units stay visible.
          rows.push(["split", `seller ${usdcTrim(split.seller)} · treasury ${usdcTrim(split.treasury)} · total ${usdcTrim(split.total)} (fee ${split.feeBP} bp · raw ${split.seller}/${split.treasury}/${split.total})`]);
        } catch (error) {
          rows.push(["split", `✗ ${reason(error)}`]);
        }
      } else {
        rows.push(["refund", "client refunded · full amount, no fee row"]);
      }
      // Terminal outcome (settled or refunded) — the job is spent, but the
      // record REMAINS marked terminal (outcome + tx + amount) so the
      // recovery row keeps printing "last job 19 · settled · tx …" and the
      // tour's step chips stay DONE across reloads. A new buy or sandbox
      // stale replaces it.
      setActJob({
        ...job,
        outcome: result.verdict === "APPROVE" ? "settled" : "refunded",
        // verdict txHash is a plain string here; the record's field is typed
        txHash: result.txHash as `0x${string}`,
      });
    } else {
      rows.push(["tx", "none · decision was returned without settlement (no signer given)"]);
    }
    return {
      render: "kv",
      data: {
        rows,
        note: `verdict is ${result.verdict}: ${result.verdict === "APPROVE" ? "SLA met · the hook allowed complete()" : "stale or invalid · refunded instead"}; split is receipt-derived, never config`,
      },
    };
  },
};

register(buyCommand);
register(deliverCommand);
register(settleCommand);
