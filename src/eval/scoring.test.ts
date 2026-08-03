import { describe, expect, it } from "vitest";
import { hitRate, reciprocalRank } from "./scoring";

const results = [{ externalId: "sku-2" }, { externalId: "sku-1" }, { externalId: "sku-3" }];

describe("hitRate", () => {
  it("is true when the expected id appears anywhere in the results", () => {
    expect(hitRate(results, "sku-1")).toBe(true);
  });

  it("is false when the expected id is absent", () => {
    expect(hitRate(results, "sku-9")).toBe(false);
  });
});

describe("reciprocalRank", () => {
  it("returns 1 when the expected id is first", () => {
    expect(reciprocalRank(results, "sku-2")).toBe(1);
  });

  it("returns 1/2 when the expected id is second", () => {
    expect(reciprocalRank(results, "sku-1")).toBe(0.5);
  });

  it("returns 1/3 when the expected id is third", () => {
    expect(reciprocalRank(results, "sku-3")).toBe(1 / 3);
  });

  it("returns 0 when the expected id is absent", () => {
    expect(reciprocalRank(results, "sku-9")).toBe(0);
  });
});
