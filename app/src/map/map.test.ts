import { describe, expect, it } from "bun:test";
import { CHIP_COLS, chipLines } from "./MapCanvas";

describe("chipLines", () => {
  it("keeps a short chip on one line", () => {
    expect(chipLines("0.10 USDC/query")).toEqual(["0.10 USDC/query"]);
  });
  it("wraps on the separators so no line exceeds the column budget", () => {
    const lines = chipLines("0.10 USDC/query · arb 504,588,588 · 91 rows · cached");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(CHIP_COLS);
    expect(lines.join(" · ")).toBe("0.10 USDC/query · arb 504,588,588 · 91 rows · cached");
  });
  it("caps at three lines and elides the rest", () => {
    const lines = chipLines("aaaaaaaaaaaaaaaaaaaa · bbbbbbbbbbbbbbbbbbbb · cccccccccccccccccccc · dddddddddddddddddddd · eeeeeeeeee");
    expect(lines).toHaveLength(3);
    expect(lines[2]?.endsWith("…")).toBe(true);
  });
});
