import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk-text";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("Paracetamol 500mg tablet.")).toEqual(["Paracetamol 500mg tablet."]);
  });

  it("returns an empty array for blank input", () => {
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("splits on paragraph boundaries when possible", () => {
    const text = `${"a".repeat(300)}\n\n${"b".repeat(300)}`;
    const result = chunkText(text, { maxChars: 400, overlapChars: 0 });
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("a".repeat(300));
    expect(result[1]).toBe("b".repeat(300));
  });

  it("hard-splits a single paragraph longer than maxChars", () => {
    const result = chunkText("c".repeat(1000), { maxChars: 400, overlapChars: 0 });
    expect(result.length).toBeGreaterThan(1);
    expect(result.every((c) => c.length <= 400)).toBe(true);
    expect(result.join("")).toBe("c".repeat(1000));
  });

  it("overlaps consecutive chunks by overlapChars", () => {
    const result = chunkText("d".repeat(1000), { maxChars: 400, overlapChars: 50 });
    expect(result[1]!.startsWith("d".repeat(50))).toBe(true);
  });

  it("never emits an empty or whitespace-only chunk", () => {
    const result = chunkText("x\n\n\n\n\ny", { maxChars: 400 });
    expect(result.every((c) => c.trim().length > 0)).toBe(true);
  });
});
