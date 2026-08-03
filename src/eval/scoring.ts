type ScorableResult = { externalId: string };

export function hitRate(results: ScorableResult[], expectedExternalId: string): boolean {
  return results.some((r) => r.externalId === expectedExternalId);
}

/**
 * 1/(rank), rank starting at 1 — 0 if the expected document never appears.
 * Unlike hitRate, this rewards ranking it near the top, not just anywhere in
 * the results, which is what a reranking pass is actually trying to improve.
 */
export function reciprocalRank(results: ScorableResult[], expectedExternalId: string): number {
  const index = results.findIndex((r) => r.externalId === expectedExternalId);
  return index === -1 ? 0 : 1 / (index + 1);
}
