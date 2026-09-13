import { useEffect, useRef, useState, type JSX } from "react";
import { CONFIG } from "../config";
import { env } from "../env";
import { createEnsTextReader } from "../../../mcp/src/ens";
import { resolveDatasetQuote, type DatasetQuote } from "../console/commands/act";
import { datasetTitle, freshnessPromise, priceLabel } from "../copy/plain";
import { runPurchase, type PurchaseEvent } from "../flow/purchase";
import { recordRun } from "../flow/session";
import { Stepper } from "../ui/Stepper";
import { ensRecordUrl, explorerUrl, truncateHash } from "../format";

const TX_RE = /^0x[0-9a-fA-F]{64}$/;

/** Detail values: transaction hashes become ArcScan links; everything else prints as is. */
function DetailValue({ value, label }: { value: string; label: string }): JSX.Element {
  const parts = value.split(",").map((v) => v.trim()).filter(Boolean);
  const isTx = !/hash/i.test(label) || /tx/i.test(label);
  if (isTx && parts.length > 0 && parts.every((v) => TX_RE.test(v))) {
    return (
      <>
        {parts.map((hash, i) => (
          <span key={hash}>
            {i > 0 && ", "}
            <a href={explorerUrl(hash)} target="_blank" rel="noreferrer">
              {truncateHash(hash, 10, 8)}
            </a>
          </span>
        ))}
      </>
    );
  }
  return <>{value}</>;
}

const ENS = createEnsTextReader({ rpcUrl: env.sepoliaRpc });

type Summary = { kind: "settled" | "refunded" | "failed"; text: string };

export function TryIt({ armed, onArmedConsumed }: { armed: "fresh" | "fail" | null; onArmedConsumed(): void }): JSX.Element {
  const [datasetId, setDatasetId] = useState(CONFIG.datasets.find((d) => d.id === "overtime-sports-odds")?.id ?? CONFIG.datasets[0]?.id ?? "");
  const [quote, setQuote] = useState<DatasetQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [mode, setMode] = useState<"fresh" | "fail">("fresh");
  const [events, setEvents] = useState<PurchaseEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const failBtn = useRef<HTMLButtonElement>(null);
  const buyBtn = useRef<HTMLButtonElement>(null);
  const dataset = CONFIG.datasets.find((d) => d.id === datasetId) ?? CONFIG.datasets[0]!;

  useEffect(() => {
    let cancelled = false;
    setQuote(null);
    setQuoteError(null);
    resolveDatasetQuote(dataset, ENS)
      .then((q) => {
        if (!cancelled) setQuote(q);
      })
      .catch((e) => {
        if (!cancelled) setQuoteError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [dataset]);

  // A hero button is the real action: once the quote is in, it runs the purchase.
  useEffect(() => {
    if (armed === null || busy || quote === null) return;
    (armed === "fail" ? failBtn : buyBtn).current?.focus();
    onArmedConsumed();
    void run(armed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, busy, quote]);

  const run = async (m: "fresh" | "fail"): Promise<void> => {
    if (busy) return;
    setMode(m);
    setEvents([]);
    setSummary(null);
    setBusy(true);
    const result = await runPurchase({
      datasetId: dataset.id,
      mode: m,
      onEvent: (e) => setEvents((prev) => [...prev, e]),
    });
    setBusy(false);
    if (result.ok && result.jobId) {
      recordRun({
        jobId: result.jobId,
        gap: result.metaBlock !== undefined && result.minBlock !== undefined && result.minBlock > result.metaBlock ? result.minBlock - result.metaBlock : undefined,
        datasetId: dataset.id,
        amount: BigInt(result.amount ?? 0),
        outcome: result.outcome ?? "open",
        txHash: result.txHash,
        at: Math.floor(Date.now() / 1000),
        refundReason: result.refundReason,
      });
      // the stepper's last two rows already say settled or refunded; no closing bubble
      setSummary(null);
    } else if (!result.ok) {
      setSummary({ kind: "failed", text: result.reason ?? "The run stopped." });
    }
  };

  return (
    <section id="try" className="section wrap" aria-labelledby="try-title">
      <div className="section__head">
        <h2 id="try-title">Try it. No wallet needed.</h2>
        <p className="lede">
          Watch recourse happen. Buy the newest sports odds with real money on the live escrow: the price and the
          freshness promise come from the seller's name, and the delivery is checked against that promise before
          anyone is paid. Then make the same purchase fail on purpose and watch the money come back without anyone
          asking for it.
        </p>
      </div>
      <div className="try">
        <div className="try__pick">
          <label htmlFor="dataset" className="small">
            Dataset
          </label>
          <select id="dataset" value={datasetId} disabled={busy} onChange={(e) => setDatasetId(e.target.value)}>
            {CONFIG.datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {datasetTitle(d.id)}
              </option>
            ))}
          </select>
          <p className="small try__quote" aria-live="polite">
            {quote ? (
              <>
                {priceLabel(quote.amountUsdc)} per query · {freshnessPromise(quote.maxBlockLag, dataset.chain)} ·
                price from the ENS record of{" "}
                <a href={ensRecordUrl(quote.priceName)} target="_blank" rel="noreferrer">
                  {quote.priceName}
                </a>
              </>
            ) : quoteError ? (
              `The price could not be read from ENS: ${quoteError}`
            ) : (
              "Reading the price from ENS…"
            )}
          </p>
          <div className="try__actions">
            <button ref={buyBtn} type="button" className="btn btn--ghost" disabled={busy || quote === null} onClick={() => run("fresh")}>
              {busy && mode === "fresh" ? "Buying…" : `Buy a query · ${quote ? priceLabel(quote.amountUsdc) : "…"}`}
            </button>
            <button
              ref={failBtn}
              type="button"
              className="linkbtn hero__alt"
              disabled={busy || quote === null}
              onClick={() => run("fail")}
            >
              {busy && mode === "fail" ? "failing on purpose…" : "or make it fail"}
            </button>
          </div>
          <p className="tiny try__hint">
            Why it matters: today an agent that pays for bad data has no way to get its money back, so nobody
            lets agents spend. Here the refund is not a policy, it is the contract: the freshness promise is written
            into the escrow at payment time, the delivered block is checked against it onchain, and a miss is
            refunded in the same step. Both wallets are Circle wallets with sponsored gas, so there is nothing to
            install; every row below links to its transaction.
          </p>
        </div>
        <div className="try__run">
          {events.length === 0 ? (
            <>
              <p className="small try__idle">What happens when you buy, step by step. Each row turns green as its transaction lands on Arc; a run takes about thirty seconds.</p>
              <Stepper events={[]} mode="fresh" />
            </>
          ) : (
            <Stepper events={events} mode={mode} />
          )}
          {summary && (
            <p
              className={`try__summary${summary.kind === "refunded" ? " try__summary--back" : summary.kind === "failed" ? " try__summary--fail" : ""}`}
              role="status"
            >
              {summary.text}
            </p>
          )}
          {events.some((e) => e.data) && (
            <details className="details">
              <summary>Details</summary>
              <dl className="kv">
                {[...new Map(events.filter((e) => e.data).map((e) => [e.step, e])).values()]
                  .flatMap((e) =>
                    Object.entries(e.data!).map(([k, v]) => (
                      <div key={`${e.step}-${k}`} style={{ display: "contents" }}>
                        <dt>
                          {e.step} · {k}
                        </dt>
                        <dd>
                          <DetailValue value={v} label={k} />
                        </dd>
                      </div>
                    )),
                  )}
              </dl>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
