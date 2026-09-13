import { describe, expect, it } from "bun:test";
import { bookRows, rowSells, shortSellerLabel, DAY_SEC, DEFAULT_SELLER_NAME, MONTH_SEC, sellerFor, tickerStats } from "./exchange";
import type { MarketSellerRow } from "../components/Market";
import type { BoardRow } from "../data/feed";
import type { JobView } from "../data/types";

const NOW = 1_789_200_000;
const ADDR = "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21" as const;

function job(id: number, state: JobView["state"], timestamp: number, amount = 100_000n): JobView {
  return {
    jobId: BigInt(id),
    buyer: ADDR,
    seller: ADDR,
    amount,
    minBlock: 1n,
    deadline: BigInt(timestamp + 600),
    blockNumber: 1n,
    timestamp,
    state,
  };
}

function seller(name: string, menu: string[], overrides: Partial<MarketSellerRow> = {}): MarketSellerRow {
  return {
    name,
    menu: menu.map((id) => ({ id, schema: "lending/3.1.0" })),
    price: "0.10 USDC/query",
    sla: { maxBlockLag: 40, maxLatencyMs: 5000 },
    payee: null,
    operator: ADDR,
    priceByDataset: {},
    stats: null,
    ...overrides,
  };
}

function board(jobId: string, datasetId: string, outcome: BoardRow["outcome"], at: number): BoardRow {
  return { jobId, datasetId, amount: 100_000n, outcome, at, confirming: false, seller: ADDR, delivered: true };
}

describe("tickerStats", () => {
  it("is all zeros and a null refund rate with no jobs", () => {
    expect(tickerStats([], NOW, 200)).toEqual({
      settled24hUsdc: 0n,
      refunded24hUsdc: 0n,
      settled24hCount: 0,
      refunded24hCount: 0,
      refundRatePct: null,
      feesUsdc: 0n,
      openCount: 0,
    });
  });

  it("counts a job exactly 24h old inside the window and one second older outside it", () => {
    const jobs = [
      job(1, "settled", NOW - DAY_SEC, 250_000n),
      job(2, "settled", NOW - DAY_SEC - 1, 999_000n),
      job(3, "refunded", NOW - DAY_SEC, 50_000n),
      job(4, "refunded", NOW - DAY_SEC - 1, 70_000n),
    ];
    const t = tickerStats(jobs, NOW, 200);
    expect(t.settled24hCount).toBe(1);
    expect(t.settled24hUsdc).toBe(250_000n);
    expect(t.refunded24hCount).toBe(1);
    expect(t.refunded24hUsdc).toBe(50_000n);
    // fees cover every settled job, not only the 24h window: 2% of 1.249 USDC
    expect(t.feesUsdc).toBe(24_980n);
  });

  it("rounds the 30d refund rate to a whole percent and ignores older jobs", () => {
    const jobs = [
      job(1, "settled", NOW - 10),
      job(2, "settled", NOW - 20),
      job(3, "refunded", NOW - 30),
      job(4, "refunded", NOW - MONTH_SEC - 1),
      job(5, "refunded", NOW - MONTH_SEC - 2),
    ];
    // 1 refund out of 3 finished jobs in the window: 33.33 -> 33
    expect(tickerStats(jobs, NOW, 200).refundRatePct).toBe(33);
    expect(tickerStats([job(1, "settled", NOW), job(2, "refunded", NOW)], NOW, 200).refundRatePct).toBe(50);
    expect(tickerStats([job(1, "settled", NOW), job(2, "refunded", NOW), job(3, "refunded", NOW)], NOW, 200).refundRatePct).toBe(67);
  });

  it("counts open jobs without touching the money figures", () => {
    const t = tickerStats([job(1, "open", NOW), job(2, "open", NOW - MONTH_SEC * 2)], NOW, 200);
    expect(t.openCount).toBe(2);
    expect(t.refundRatePct).toBeNull();
    expect(t.settled24hUsdc).toBe(0n);
  });
});

describe("bookRows", () => {
  const datasets = [
    { id: "aave-v3-arbitrum-lending", chain: "arbitrum" as const },
    { id: "ens-registrations", chain: "ethereum" as const },
  ];

  it("falls back to openbook.eth with no price or promise when there is no seller row", () => {
    const rows = bookRows(datasets, [], []);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "aave-v3-arbitrum-lending",
      title: "Aave V3 lending markets",
      sellerName: DEFAULT_SELLER_NAME,
      priceRaw: null,
      maxBlockLag: null,
      chain: "arbitrum",
      lastAt: null,
      lastOutcome: null,
      settledCount: 0,
      refundedCount: 0,
      alsoBy: [],
    });
  });

  it("picks the seller whose menu lists the dataset, else the first seller", () => {
    const parent = seller("openbook.eth", ["aave-v3-arbitrum-lending"], { price: "0.10 USDC/query" });
    const sub = seller("ens.openbook.eth", ["ens-registrations"], {
      price: "0.30 USDC/query",
      priceByDataset: { "ens-registrations": "0.25 USDC/query" },
      sla: { maxBlockLag: 5, maxLatencyMs: 9000 },
    });
    expect(sellerFor("ens-registrations", [parent, sub])?.name).toBe("ens.openbook.eth");
    expect(sellerFor("opensea-nft-trades", [parent, sub])?.name).toBe("openbook.eth");
    expect(sellerFor("opensea-nft-trades", [])).toBeNull();

    const rows = bookRows(datasets, [parent, sub], []);
    expect(rows[0].sellerName).toBe("openbook.eth");
    expect(rows[0].priceRaw).toBe("0.10 USDC/query");
    expect(rows[0].maxBlockLag).toBe(40);
    // the dataset-level price override wins over the seller-level record
    expect(rows[1].sellerName).toBe("ens.openbook.eth");
    expect(rows[1].priceRaw).toBe("0.25 USDC/query");
    expect(rows[1].alsoBy).toEqual([]);
    // a second seller listing the same dataset appears as another ask
    const both = bookRows(datasets.slice(0, 1), [parent, seller("alpha.openbook.eth", ["aave-v3-arbitrum-lending"], { price: "0.13 USDC/query" })], []);
    expect(both[0].sellerName).toBe("openbook.eth");
    expect(both[0].alsoBy).toEqual([{ name: "alpha.openbook.eth", priceRaw: "0.13 USDC/query" }]);
    expect(rows[1].maxBlockLag).toBe(5);
  });

  it("takes the newest board row per dataset and counts outcomes; an indexed row without a dataset id counts for every dataset its seller sells", () => {
    const rows = bookRows(datasets, [seller("openbook.eth", ["aave-v3-arbitrum-lending"])], [
      board("3", "aave-v3-arbitrum-lending", "refunded", NOW - 5),
      board("2", "aave-v3-arbitrum-lending", "settled", NOW - 50),
      board("1", "aave-v3-arbitrum-lending", "settled", NOW - 500),
      board("4", "ens-registrations", "open", NOW - 1),
      board("5", "", "settled", NOW),
    ]);
    // row 5 carries no dataset id but its seller (ADDR, the operator) sells both datasets
    expect(rows[0].lastAt).toBe(NOW);
    expect(rows[0].lastOutcome).toBe("settled");
    expect(rows[0].settledCount).toBe(3);
    expect(rows[0].refundedCount).toBe(1);
    expect(rows[1].lastOutcome).toBe("settled");
    expect(rows[1].settledCount).toBe(1);
  });
});

describe("rowSells", () => {
  const seller = {
    name: "openbook.eth", menu: [{ id: "a" }], price: null, sla: null,
    payee: "0xB63FA642B3BC64D91722F0884D86AF5B00E66CA9", operator: "0x64a7000000000000000000000000000000008d21",
    priceByDataset: {}, stats: null,
  } as unknown as import("../components/Market").MarketSellerRow;
  const base = { jobId: "1", amount: 0n, outcome: "settled" as const, at: 1, confirming: false, delivered: true };
  it("an indexed row (no dataset id) lands on the seller that sells the dataset, by payee or operator, case-insensitively", () => {
    expect(rowSells({ ...base, datasetId: "", seller: "0xb63fa642b3bc64d91722f0884d86af5b00e66ca9" }, "a", seller)).toBe(true);
    expect(rowSells({ ...base, datasetId: "", seller: "0x64A7000000000000000000000000000000008D21" }, "a", seller)).toBe(true);
    expect(rowSells({ ...base, datasetId: "", seller: "0x0000000000000000000000000000000000000001" }, "a", seller)).toBe(false);
    expect(rowSells({ ...base, datasetId: "", seller: null }, "a", seller)).toBe(false);
    expect(rowSells({ ...base, datasetId: "", seller: "0xb63fa642b3bc64d91722f0884d86af5b00e66ca9" }, "a", null)).toBe(false);
  });
  it("a session row keeps its own dataset id, whatever the seller", () => {
    expect(rowSells({ ...base, datasetId: "b", seller: "0xb63fa642b3bc64d91722f0884d86af5b00e66ca9" }, "a", seller)).toBe(false);
    expect(rowSells({ ...base, datasetId: "a", seller: null }, "a", seller)).toBe(true);
  });
});

describe("seller labels", () => {
  it("a row labeled with the seller's ENS name belongs to that seller even when the payee record is unset", () => {
    const parent = { name: "openbook.eth", menu: [{ id: "a" }], price: null, sla: null, payee: null, operator: null, priceByDataset: {}, stats: null } as unknown as import("../components/Market").MarketSellerRow;
    const base = { jobId: "1", amount: 0n, outcome: "settled" as const, at: 1, confirming: false, delivered: true, datasetId: "", seller: "0xb63fa642b3bc64d91722f0884d86af5b00e66ca9" };
    expect(rowSells({ ...base, sellerName: "openbook.eth (Circle seller wallet)" }, "a", parent)).toBe(true);
    expect(rowSells({ ...base, sellerName: "alpha.openbook.eth" }, "a", parent)).toBe(false);
    expect(rowSells(base, "a", parent)).toBe(false);
  });
  it("shortens a wallet label to its name", () => {
    expect(shortSellerLabel("openbook.eth (Circle seller wallet)")).toBe("openbook.eth");
    expect(shortSellerLabel("our demo wallet (buyer and seller, runs before Sep 13)")).toBe("our demo wallet");
    expect(shortSellerLabel("alpha.openbook.eth")).toBe("alpha.openbook.eth");
  });
});
