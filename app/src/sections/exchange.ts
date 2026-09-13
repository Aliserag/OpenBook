/**
 * Pure helpers for the exchange-style market screen: the ticker strip figures
 * and the per-dataset order book rows. No React, no network; everything here
 * derives from values other surfaces already read live (the feed, the ENS
 * seller rows, the board rows).
 */
import type { MarketSellerRow } from "../components/Market";
import type { BoardRow } from "../data/feed";
import type { JobView } from "../data/types";
import { datasetTitle, type DatasetChain } from "../copy/plain";

export const DAY_SEC = 86_400;
export const MONTH_SEC = 30 * DAY_SEC;

/** The seller name used when no seller row exists yet (the app's own storefront). */
export const DEFAULT_SELLER_NAME = "openbook.eth";

export interface TickerStats {
  settled24hUsdc: bigint;
  refunded24hUsdc: bigint;
  settled24hCount: number;
  refunded24hCount: number;
  /** refunded / (settled + refunded) over the last 30 days, whole percent; null when no finished jobs */
  refundRatePct: number | null;
  /** protocol fees over every settled job passed in (feeBP of the settled volume) */
  feesUsdc: bigint;
  openCount: number;
}

export function tickerStats(jobs: readonly JobView[], nowSec: number, feeBP: number): TickerStats {
  const dayFloor = nowSec - DAY_SEC;
  const monthFloor = nowSec - MONTH_SEC;
  let settled24hUsdc = 0n;
  let refunded24hUsdc = 0n;
  let settled24hCount = 0;
  let refunded24hCount = 0;
  let settled30d = 0;
  let refunded30d = 0;
  let settledAllUsdc = 0n;
  let openCount = 0;
  for (const j of jobs) {
    const inDay = j.timestamp >= dayFloor;
    const inMonth = j.timestamp >= monthFloor;
    if (j.state === "settled") {
      settledAllUsdc += j.amount;
      if (inDay) {
        settled24hCount += 1;
        settled24hUsdc += j.amount;
      }
      if (inMonth) settled30d += 1;
    } else if (j.state === "refunded") {
      if (inDay) {
        refunded24hCount += 1;
        refunded24hUsdc += j.amount;
      }
      if (inMonth) refunded30d += 1;
    } else {
      openCount += 1;
    }
  }
  const finished30d = settled30d + refunded30d;
  return {
    settled24hUsdc,
    refunded24hUsdc,
    settled24hCount,
    refunded24hCount,
    refundRatePct: finished30d === 0 ? null : Math.round((refunded30d / finished30d) * 100),
    feesUsdc: (settledAllUsdc * BigInt(Math.trunc(feeBP))) / 10_000n,
    openCount,
  };
}

export interface BookDataset {
  id: string;
  chain: DatasetChain;
}

export interface BookRow {
  id: string;
  title: string;
  sellerName: string;
  /** raw ENS price record ("0.10 USDC/query"); null when unset */
  priceRaw: string | null;
  maxBlockLag: number | null;
  chain: DatasetChain;
  /** unix seconds of the newest board row for this dataset */
  lastAt: number | null;
  lastOutcome: "settled" | "refunded" | "open" | null;
  settledCount: number;
  refundedCount: number;
  /** other sellers whose menu lists the dataset, with their own price record (the book's other asks) */
  alsoBy: { name: string; priceRaw: string | null }[];
}

/** The seller whose menu lists the dataset, else the first seller, else null. */
export function sellerFor(datasetId: string, sellers: readonly MarketSellerRow[]): MarketSellerRow | null {
  return sellers.find((s) => s.menu.some((m) => m.id === datasetId)) ?? sellers[0] ?? null;
}

/**
 * Whether a board row belongs to a dataset: by dataset id when the row carries
 * one (this session's purchases), otherwise by the seller that sells it (the
 * subgraph indexes the job's seller, not its dataset), so every indexed job
 * still lands on its seller's rows.
 */
export function rowSells(row: BoardRow, datasetId: string, seller: MarketSellerRow | null): boolean {
  if (row.datasetId !== "") return row.datasetId === datasetId;
  if (seller === null) return false;
  // the feed labels a seller address with its ENS name ("openbook.eth (Circle seller wallet)")
  if (row.sellerName !== undefined && (row.sellerName === seller.name || row.sellerName.startsWith(`${seller.name} (`))) return true;
  if (row.seller === null) return false;
  const addr = row.seller.toLowerCase();
  return addr === seller.payee?.toLowerCase() || addr === seller.operator?.toLowerCase();
}

/** "openbook.eth (Circle seller wallet)" → "openbook.eth"; "our demo wallet (…)" → "our demo wallet". */
export function shortSellerLabel(label: string): string {
  const at = label.indexOf(" (");
  return at > 0 ? label.slice(0, at) : label;
}

export function bookRows(
  datasets: readonly BookDataset[],
  sellers: readonly MarketSellerRow[],
  rows: readonly BoardRow[],
): BookRow[] {
  return datasets.map((d) => {
    const seller = sellerFor(d.id, sellers);
    let last: BoardRow | null = null;
    let settledCount = 0;
    let refundedCount = 0;
    for (const r of rows) {
      if (!rowSells(r, d.id, seller)) continue;
      if (last === null || r.at > last.at) last = r;
      if (r.outcome === "settled") settledCount += 1;
      else if (r.outcome === "refunded") refundedCount += 1;
    }
    const alsoBy = sellers
      .filter((s) => s !== seller && s.menu.some((m) => m.id === d.id))
      .map((s) => ({ name: s.name, priceRaw: s.priceByDataset[d.id] ?? s.price }));
    return {
      id: d.id,
      title: datasetTitle(d.id),
      sellerName: seller?.name ?? DEFAULT_SELLER_NAME,
      alsoBy,
      priceRaw: seller === null ? null : (seller.priceByDataset[d.id] ?? seller.price),
      maxBlockLag: seller?.sla?.maxBlockLag ?? null,
      chain: d.chain,
      lastAt: last === null ? null : last.at,
      lastOutcome: last === null ? null : last.outcome,
      settledCount,
      refundedCount,
    };
  });
}
