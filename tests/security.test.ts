import { describe, it, expect } from "vitest";
import { hash, token } from "../src/security.js";
import { taskInput, date } from "../src/validation.js";
import { csvCell } from "../src/reports.js";
describe("security boundaries", () => {
  it("generates unpredictable tokens and stores only one-way hashes", () => {
    const a = token(),
      b = token();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hash(a)).toHaveLength(64);
    expect(hash(a)).not.toBe(a);
  });
  it("rejects overflow dates and HTML is treated as plain text", () => {
    expect(date.safeParse("2026-02-30").success).toBe(false);
    expect(
      taskInput.safeParse({ title: "<script>", projectId: "invalid" }).success,
    ).toBe(false);
  });
  it("neutralizes spreadsheet formulas and escapes CSV quotes", () => {
    expect(csvCell("=SUM(A1)")).toBe('"\'=SUM(A1)"');
    expect(csvCell('a"b')).toBe('"a""b"');
  });
});
