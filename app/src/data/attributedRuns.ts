/**
 * Job → dataset attribution read from the chain, for the order book's "Last delivery"
 * column. The subgraph's paid rows carry no dataset id, so a page fed only by the
 * subgraph cannot say which dataset moved; the job's own onchain description carries the
 * SLA the buyer packed, and that SLA's schemaHash is keccak256(dataset.schema) — both
 * sides of that join already live in this app. So the column can read the chain instead
 * of guessing, and it works retroactively for every job ever created.
 *
 * The scan is bounded (the public Arc RPC caps eth_getLogs ranges) and cached, because it
 * runs from the landing page, not in a loop. Rows are produced in `SessionRun` shape so
 * `boardRows` merges them exactly like a session's own purchases; anything the subgraph
 * does not already list is dropped by the caller, so outcomes are never invented here.
 */
import { keccak256, parseAbiItem, toBytes } from "viem";
import { escrowAddress, getJob } from "../../../agent/escrow";
import { CONFIG } from "../config";
import { getPublicClient } from "./chain";
import { shared } from "./cache";
import { useLiveValue } from "../ui/useLiveValue";
import type { SessionRun } from "./feed";

const JOB_CREATED = parseAbiItem(
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 budget, address hook)",
);

/** ~an hour of Arc blocks, in chunks the public RPC accepts (it rejects ranges over ~2k). */
const WINDOW_BLOCKS = 6_000n;
const CHUNK_BLOCKS = 2_000n;
const TTL_MS = 60_000;

/** schemaHash → dataset id: the SLA the buyer packed names the schema it bought. */
const bySchemaHash: Record<string, string> = Object.fromEntries(
  CONFIG.datasets.map((d) => [keccak256(toBytes(d.schema)).toLowerCase(), d.id]),
);

/** The SLA the app packs into the job description; schemaHash is the dataset join key. */
function schemaHashOf(description: string): string | null {
  try {
    const sla = JSON.parse(description) as { schemaHash?: unknown };
    return typeof sla.schemaHash === "string" ? sla.schemaHash.toLowerCase() : null;
  } catch {
    return null; // a description that is not the packed SLA has nothing to join on
  }
}

async function scan(): Promise<SessionRun[]> {
  const client = getPublicClient();
  const escrow = escrowAddress();
  const head = await client.getBlockNumber();
  const runs: SessionRun[] = [];
  const atByBlock = new Map<bigint, number>();

  for (let from = head - WINDOW_BLOCKS; from <= head; from += CHUNK_BLOCKS) {
    const to = from + CHUNK_BLOCKS - 1n > head ? head : from + CHUNK_BLOCKS - 1n;
    let logs: Awaited<ReturnType<typeof client.getLogs<typeof JOB_CREATED>>>;
    try {
      logs = await client.getLogs({ address: escrow, event: JOB_CREATED, fromBlock: from, toBlock: to });
    } catch {
      continue; // a range the RPC refuses is a gap in this window, not a page failure
    }
    for (const log of logs) {
      const jobId = log.args.jobId;
      if (jobId === undefined) continue;
      let job: Awaited<ReturnType<typeof getJob>>;
      try {
        job = await getJob(client, jobId);
      } catch {
        continue;
      }
      const datasetId = schemaHashOf(String(job.description));
      if (datasetId === null) continue;
      const known = bySchemaHash[datasetId];
      if (known === undefined) continue; // a schema no listed dataset sells
      const block = log.blockNumber ?? null;
      let at = atByBlock.get(block ?? 0n);
      if (at === undefined && block !== null) {
        try {
          at = Number((await client.getBlock({ blockNumber: block })).timestamp);
          atByBlock.set(block, at);
        } catch {
          at = undefined;
        }
      }
      runs.push({
        jobId: jobId.toString(),
        datasetId: known,
        amount: job.budget,
        // the subgraph row keeps its own outcome; this value is only read by boardRows
        // when the caller passes a job the subgraph does not have, which it does not.
        outcome: "open",
        at: at ?? 0,
      });
    }
  }
  return runs;
}

const attributedRunsShared = shared(scan, TTL_MS);

/**
 * The chain-read attributions, polled like the other live panels. Merged with the
 * session's own runs so a purchase in this browser is attributed the moment it lands,
 * whether or not the subgraph has indexed it yet.
 */
export function useAttributedRuns(): SessionRun[] {
  const live = useLiveValue(attributedRunsShared, { pollMs: 60_000, staleAfterMs: 180_000, cacheKey: "market.attributed" });
  return live.value ?? [];
}
