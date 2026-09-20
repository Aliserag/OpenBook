/**
 * KvBlock — the key/value body rows (mono, dashed rules). Hash-like values
 * become copy chips; the note prints as the receipt footnote.
 */
import type { JSX } from "react";
import type { KvData } from "../registry";
import { HashChip, splitHex } from "./HashChip";

/**
 * Row tones, decided in one place so every receipt reads the same way:
 *   outcome  — `verdict` / `refund` rows: a size up, in the stamp's own colours
 *   fresh/stale — the SLA statements, green when a delivery cleared the floor, amber when it did not
 *   proof    — the age/window/floor rows: the numbers the demo points at, set in ink and a size up
 *   plumbing — context the room does not need to read (balances, chain heads): muted
 */
export function kvRowClass(key: string, value: string): string {
  const head = value.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (key === "verdict" || key === "refund") {
    if (head.startsWith("APPROVE")) return "tape__kvrow tape__kvrow--verdict tape__kvrow--ok";
    if (head.startsWith("REFUSE")) return "tape__kvrow tape__kvrow--verdict tape__kvrow--refuse";
    if (key === "refund") return "tape__kvrow tape__kvrow--verdict tape__kvrow--refund";
    return "tape__kvrow tape__kvrow--verdict";
  }
  if (key === "freshness" || key === "sla floor" || key === "clearance") {
    if (/clears it|^fresh\b|≥ floor|^fresh\s*\(/i.test(value.trim())) return "tape__kvrow tape__kvrow--fresh";
    if (/below it|^stale\b|SlaNotMet/i.test(value.trim())) return "tape__kvrow tape__kvrow--stale";
  }
  if (key === "data age at delivery" || key === "your window") return "tape__kvrow tape__kvrow--proof";
  if (key === "balance" || key === "chain head") return "tape__kvrow tape__kvrow--plumbing";
  return "tape__kvrow";
}

export function KvBlock({
  data,
  onCopy,
  onCopyFailed,
}: {
  data: KvData;
  onCopy?: (hash: string) => void;
  onCopyFailed?: (hash: string) => void;
}): JSX.Element {
  return (
    <div className="tape__kv">
      {data.rows.map(([key, value]) => (
        <div className={kvRowClass(key, value)} key={key}>
          <span className="tape__k">{key}</span>
          <span className="tape__v">
            {onCopy === undefined ? (
              value
            ) : (
              <>
                {splitHex(value).map((part, i) =>
                  typeof part === "string" ? (
                    <span key={i}>{part}</span>
                  ) : (
                    <HashChip key={i} hash={part.hash} onCopy={onCopy} onCopyFailed={onCopyFailed} />
                  ),
                )}
              </>
            )}
          </span>
        </div>
      ))}
      {data.note !== undefined && <div className="tape__note">{data.note}</div>}
    </div>
  );
}
