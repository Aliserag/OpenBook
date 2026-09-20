/**
 * The market as an exchange screen: a ticker strip (24h volume, refund rate,
 * fees, open jobs, subgraph lag), an order book with one row per dataset
 * (price and freshness read live from ENS, last delivery from the escrow) and
 * a trades tape of the newest settlements and refunds. Every figure comes
 * from a hook other surfaces already poll; nothing here is synthesized.
 */
import type { JSX, ReactNode } from "react";
import { readSellers, venuePercent } from "../components/Market";
import { CONFIG } from "../config";
import { datasetTitle, freshnessPromise, priceLabel, relativeTime } from "../copy/plain";
import { getPublicClient } from "../data/chain";
import { platformFee } from "../data/escrow";
import { boardRows, marketJobs, useFeed, type BoardRow } from "../data/feed";
import { sellerNameMap } from "../data/sellers";
import { fetchLagShared } from "../data/subgraph";
import { useSessionRuns } from "../flow/session";
import { useAttributedRuns } from "../data/attributedRuns";
import { ensRecordUrl, explorerUrl, truncateHash } from "../format";
import { useLiveValue } from "../ui/useLiveValue";
import { parsePriceToAmount6dec } from "../../../mcp/src/ens";
import { bookRows, shortSellerLabel, tickerStats, type BookRow } from "./exchange";

const TAPE_LIMIT = 20;

function priceText(raw: string | null): string {
  if (raw === null) return "not set";
  try {
    return priceLabel(parsePriceToAmount6dec(raw));
  } catch {
    return raw;
  }
}

/** "about 13 s · 50 blocks": the promise, short enough for a table cell (the full sentence is the title). */
function freshnessShort(maxBlockLag: number, chain: "arbitrum" | "ethereum"): string {
  const full = freshnessPromise(maxBlockLag, chain); // "fresh within about 13 seconds (50 Arbitrum blocks)"
  const m = /within (about )?([\d.]+) (seconds?|minutes?|hours?)/.exec(full);
  const unit = m ? m[3]!.startsWith("second") ? "s" : m[3]!.startsWith("minute") ? "min" : "h" : "";
  return m ? `about ${m[2]} ${unit} · ${maxBlockLag} blocks` : full;
}

function outcomeClass(outcome: "settled" | "refunded" | "open"): string {
  return `is-${outcome}`;
}

/** A value that remounts (and so replays the flash animation) whenever its text changes. */
function Flash({ id, children }: { id: string; children: ReactNode }): JSX.Element {
  return (
    <span key={id} className="xch__flash">
      {children}
    </span>
  );
}

function Tick({ label, id, hint, children }: { label: string; id: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <div role="listitem">
      {hint ? (
        <span className="xch__k xch__k--hint" title={hint} tabIndex={0} aria-label={`${label}: ${hint}`}>
          {label} <span aria-hidden="true">ⓘ</span>
        </span>
      ) : (
        <span className="xch__k">{label}</span>
      )}
      <strong className="xch__v mono">
        <Flash id={id}>{children}</Flash>
      </strong>
    </div>
  );
}

/** A market-page Buy runs the whole purchase (fund, deliver, settle) in one receipt, with a
 *  window twice the seller's promise (never under a minute on Arbitrum or ten on Ethereum). */
function buy(datasetId: string, maxBlockLag: number | null, chain: "arbitrum" | "ethereum"): void {
  const blockSeconds = chain === "ethereum" ? 12 : 0.25;
  const floorSeconds = chain === "ethereum" ? 600 : 60;
  const promised = maxBlockLag === null ? floorSeconds : Math.round(maxBlockLag * blockSeconds);
  const seconds = Math.max(floorSeconds, 2 * promised);
  window.dispatchEvent(new CustomEvent("openbook:console-run", { detail: { line: `buy ${datasetId} --fresh ${seconds}` } }));
}

function BookLine({ row }: { row: BookRow }): JSX.Element {
  const lastId = `${row.lastAt ?? "none"}:${row.lastOutcome ?? "none"}`;
  return (
    <tr>
      <td>{row.title}</td>
      <td>
        <a href={ensRecordUrl(row.sellerName)} target="_blank" rel="noreferrer" title="the live ENSv2 records on Sepolia">
          {row.sellerName}
        </a>
        {row.alsoBy.map((o) => (
          <div key={o.name} className="xch__also">
            also{" "}
            <a href={ensRecordUrl(o.name)} target="_blank" rel="noreferrer" title="another seller listing this dataset">
              {o.name}
            </a>{" "}
            {priceText(o.priceRaw)}
          </div>
        ))}
      </td>
      <td className="num">{priceText(row.priceRaw)}</td>
      <td>
        {row.maxBlockLag !== null ? (
          <span className="xch__nw" title={freshnessPromise(row.maxBlockLag, row.chain)}>{freshnessShort(row.maxBlockLag, row.chain)}</span>
        ) : (
          "no promise"
        )}
      </td>
      <td>
        <Flash id={lastId}>
          {row.lastAt !== null && row.lastOutcome !== null ? (
            <>
              {relativeTime(row.lastAt)} <span className={outcomeClass(row.lastOutcome)}>{row.lastOutcome}</span>
            </>
          ) : (
            <span className="xch__muted">none yet</span>
          )}
        </Flash>
      </td>
      <td className="num">
        <span className="is-settled">{row.settledCount}</span> / <span className="is-refunded">{row.refundedCount}</span>
      </td>
      <td className="num">
        <button type="button" className="xch__buy" data-dataset={row.id} onClick={() => buy(row.id, row.maxBlockLag, row.chain)}>
          Buy
        </button>
      </td>
    </tr>
  );
}

function TradeLine({ row }: { row: BoardRow }): JSX.Element {
  return (
    <tr>
      <td>{relativeTime(row.at)}</td>
      <td>#{row.jobId}</td>
      <td>{row.datasetId ? datasetTitle(row.datasetId) : <span className="xch__muted">{row.sellerName ? shortSellerLabel(row.sellerName) : row.seller ? truncateHash(row.seller) : "unlisted seller"}</span>}</td>
      <td className="num">{priceLabel(row.amount)}</td>
      <td className={outcomeClass(row.outcome)}>
        {row.outcome}
        {row.confirming ? " · confirming" : ""}
      </td>
      <td>
        {row.txHash ? (
          <a href={explorerUrl(row.txHash)} target="_blank" rel="noreferrer">
            {truncateHash(row.txHash)}
          </a>
        ) : (
          <a href={`#theater/${row.jobId}`} title="replay this job frame by frame, every frame a live read">
            replay
          </a>
        )}
      </td>
    </tr>
  );
}

export function MarketSection({ variant = "page" }: { variant?: "page" | "teaser" } = {}): JSX.Element {
  const feed = useFeed();
  const sessionRuns = useSessionRuns();
  /** dataset attribution read from the chain: the subgraph's rows carry no dataset id */
  const attributed = useAttributedRuns();
  const sellers = useLiveValue(readSellers, { pollMs: 120_000, staleAfterMs: 360_000, cacheKey: "market.sellers" });
  const fee = useLiveValue(() => platformFee(getPublicClient()), { pollMs: 60_000, staleAfterMs: 180_000 });
  const lag = useLiveValue(
    async () => {
      const [l, head] = await Promise.all([fetchLagShared(), getPublicClient().getBlockNumber()]);
      return { indexed: l.indexed, head: Number(head) };
    },
    { pollMs: 30_000, staleAfterMs: 90_000 },
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const jobs = feed.value === null ? null : marketJobs(feed.value.jobs);
  const feeBP = fee.value?.feeBP ?? null;
  const stats = jobs === null ? null : tickerStats(jobs, nowSec, feeBP ?? 0);
  const names = sellerNameMap(sellers.value);
  // attributions only enrich jobs the subgraph already lists, so no outcome is invented
  const listed = new Set(jobs === null ? [] : jobs.map((j) => j.jobId.toString()));
  const runs = [...sessionRuns, ...attributed.filter((r) => listed.has(r.jobId))];
  const allRows = jobs === null ? [] : boardRows(jobs, runs, jobs.length + runs.length, names);
  const tape = allRows.slice(0, TAPE_LIMIT);
  const book = sellers.value === null ? null : bookRows(CONFIG.datasets, sellers.value.sellers, allRows);

  // ticker values: "…" until the feed lands, "?" when it failed with nothing to show
  const tv = (text: string): string => (feed.state === "error" ? "?" : stats === null ? "…" : text);
  const settled24h = stats === null ? "" : `${priceLabel(stats.settled24hUsdc)} (${stats.settled24hCount})`;
  const refunded24h = stats === null ? "" : `${priceLabel(stats.refunded24hUsdc)} (${stats.refunded24hCount})`;
  const refundRate = stats === null ? "" : stats.refundRatePct === null ? "n/a" : `${stats.refundRatePct}%`;
  const fees = stats === null || feeBP === null ? "" : priceLabel(stats.feesUsdc);
  const feesText = feeBP === null ? (feed.state === "error" ? "?" : "…") : tv(fees);
  const openJobs = stats === null ? "" : String(stats.openCount);
  const lagText =
    lag.value !== null ? `${lag.value.head - lag.value.indexed} blocks` : lag.state === "error" ? "?" : "…";

  return (
    <section id="market" className="section wrap xch" aria-labelledby="market-title">
      <div className="section__head">
        <h2 id="market-title">The market</h2>
        <p className="lede xch__caption">
          The first agentic data market, where freshness is guaranteed. OpenBook turns any ENS name into its own
          market: a data purveyor creates a subgraph, structures the data, sets a price and a freshness window, and
          gets paid only when a delivery meets it. Buyers get every stale delivery refunded automatically, so fast,
          accurate data earns.
        </p>
      </div>

      {variant === "teaser" && (
        <p className="xch__open">
          <a className="btn" href="#market">
            Open the market
          </a>
          <span className="small">live prices, freshness windows, every settlement and refund</span>
        </p>
      )}
      <div className="xch__ticker" role="list">
        <Tick label="24h settled" id={tv(settled24h)}>
          {tv(settled24h)}
        </Tick>
        <Tick label="24h refunded" id={tv(refunded24h)}>
          {tv(refunded24h)}
        </Tick>
        <Tick label="refund rate 30d" id={tv(refundRate)}>
          {tv(refundRate)}
        </Tick>
        <Tick
          label="protocol fees"
          id={`${feesText}:${feeBP ?? ""}`}
          hint={`The protocol takes ${feeBP !== null ? venuePercent(feeBP) : "2%"} of every settlement, paid to a treasury${fee.value ? ` (${truncateHash(fee.value.treasury)})` : ""} that can only spend within onchain limits. Read live from the escrow. Sellers listed on ENS: ${sellers.value ? sellers.value.sellers.length : "…"} (openbook.eth and its subnames).`}
        >
          {feesText}
        </Tick>
        <Tick label="open jobs" id={tv(openJobs)}>
          {tv(openJobs)}
        </Tick>
        <Tick label="subgraph lag" id={lagText}>
          {lagText}
        </Tick>
      </div>

      {variant === "teaser" ? null : book === null ? (
        <p className="small">
          {sellers.state === "error"
            ? `The seller list could not be read right now (${sellers.reason ?? "unknown"}).`
            : "Reading the sellers from ENS…"}
        </p>
      ) : (
        <div className="xch__scroll">
          <table className="xch__book">
            <caption className="xch-sr">order book: one row per dataset</caption>
            <thead>
              <tr>
                <th scope="col">Dataset</th>
                <th scope="col">Seller</th>
                <th scope="col" className="num">
                  Price / query
                </th>
                <th scope="col">Freshness</th>
                <th scope="col">Last delivery</th>
                <th scope="col" className="num" title="the seller's jobs on the escrow: settled / refunded">
                  Seller settled / refunded
                </th>
                <th scope="col">
                  <span className="xch-sr">buy</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {book.map((row) => (
                <BookLine key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {variant === "page" && (
      <div className="xch__below">
        <div className="xch__tape">
          <h3 className="xch__h3">Trades</h3>
          <div className="xch__scroll">
            <table className="xch__trades">
              <caption className="xch-sr">trades: the newest jobs on the market escrow</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Job</th>
                  <th scope="col">Dataset</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Tx / replay</th>
                </tr>
              </thead>
              <tbody>
                {tape.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="xch__muted">
                      {feed.state === "error"
                        ? `The escrow feed could not be read right now (${feed.reason ?? "unknown"}).`
                        : jobs === null
                          ? "Reading the escrow…"
                          : "No trades yet."}
                    </td>
                  </tr>
                ) : (
                  tape.map((row) => <TradeLine key={row.jobId} row={row} />)
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="xch__list">
          <h3 className="xch__h3">List your subgraph — one line of config</h3>
          <pre className="xch__code">{`{ "id": "my-dataset", "subgraphId": "<subgraph-id>", "schema": "lending/3.1.0", "chain": "arbitrum", "freshness": { "maxAge": 50 }, "priceUsdc": 100000 }`}</pre>
          <p className="small">
            Add that entry to <code>mcp/config/openbook.json</code> — the listings above are exactly this shape — then set
            three records on your own ENS name: <code>svc.price</code> (<code>0.10 USDC/query</code>),{" "}
            <code>svc.sla</code> (<code>{`{"maxBlockLag":50,"maxLatencyMs":2000}`}</code>) and <code>svc.payee</code>,
            the address that gets paid. You get back a listing agents find through the MCP server —{" "}
            <code>list_datasets</code>, <code>discover_datasets</code>, <code>get_quote</code>,{" "}
            <code>choose_seller</code>, <code>query_dataset</code>, <code>verify_delivery</code>, <code>get_pnl</code> —
            and the hook enforces the window you promised: a fresh delivery pays you, a stale one returns the buyer's
            money in the same transaction, with no claim filed.
          </p>
          <p className="small xch__muted">
            The same entry points at any origin a server can stamp — a subgraph today, an API or a sensor next. Live on
            Arc testnet, and every settlement and refund is in the books above this line.
          </p>
        </div>
      </div>
      )}
    </section>
  );
}
