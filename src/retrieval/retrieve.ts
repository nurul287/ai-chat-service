import { and, cosineDistance, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { chunks, documents } from "../db/schema";
import { embedQuery, rerank } from "../lib/voyage";

export type RetrieveOptions = {
  mode?: "hybrid" | "hybrid+rerank";
};

export type RetrievedChunk = {
  documentId: string;
  externalId: string;
  title: string | null;
  content: string;
  metadata: unknown;
};

type Candidate = RetrievedChunk & { id: string };

/** Candidates pulled per leg before fusion trims to topK — wider than topK so a
 *  result ranked poorly by one leg can still win on the strength of the other. */
const CANDIDATE_POOL = 12;

const candidateColumns = {
  id: chunks.id,
  documentId: chunks.documentId,
  externalId: documents.externalId,
  title: documents.title,
  content: chunks.content,
  metadata: documents.metadata,
};

async function vectorSearch(
  tenantId: string,
  embedding: number[],
  limit: number,
): Promise<Candidate[]> {
  return db
    .select(candidateColumns)
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(eq(chunks.tenantId, tenantId))
    .orderBy(cosineDistance(chunks.embedding, embedding))
    .limit(limit);
}

/**
 * Keyword leg over the generated `fts` column. `websearch_to_tsquery` never
 * throws on arbitrary user text, which matters because the query string comes
 * straight from an end user. Its terms are ANDed, so a query containing any
 * non-matching word returns nothing — acceptable, since an empty keyword leg
 * just leaves fusion with the vector ordering.
 */
async function keywordSearch(tenantId: string, query: string, limit: number): Promise<Candidate[]> {
  const tsquery = sql`websearch_to_tsquery('english', ${query})`;
  return db
    .select(candidateColumns)
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(and(eq(chunks.tenantId, tenantId), sql`${sql.raw('"chunks"."fts"')} @@ ${tsquery}`))
    .orderBy(sql`ts_rank(${sql.raw('"chunks"."fts"')}, ${tsquery}) desc`)
    .limit(limit);
}

/**
 * Reciprocal Rank Fusion: score(id) = Σ over lists of 1/(k + rank). Ties break
 * by first-seen order, keeping results stable when one leg is empty or both
 * legs fully agree.
 */
export function rrfFuse<T extends { id: string }>(lists: T[][], k = 60): T[] {
  const scores = new Map<string, { item: T; score: number; firstSeen: number }>();
  let seenCounter = 0;

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank]!;
      const existing = scores.get(item.id);
      const increment = 1 / (k + rank + 1);
      if (existing) {
        existing.score += increment;
      } else {
        scores.set(item.id, { item, score: increment, firstSeen: seenCounter++ });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.firstSeen - b.firstSeen)
    .map((entry) => entry.item);
}

export async function retrieve(
  tenantId: string,
  query: string,
  topK = 5,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const embedding = await embedQuery(query);

  const [vectorHits, keywordHits] = await Promise.all([
    vectorSearch(tenantId, embedding, CANDIDATE_POOL),
    keywordSearch(tenantId, query, CANDIDATE_POOL),
  ]);

  const fused = rrfFuse([vectorHits, keywordHits]);

  if (opts.mode !== "hybrid+rerank") {
    return fused.slice(0, topK).map(({ id: _id, ...chunk }) => chunk);
  }

  try {
    const order = await rerank(
      query,
      fused.map((c) => c.content),
      topK,
    );
    return order.map((i) => fused[i]!).map(({ id: _id, ...chunk }) => chunk);
  } catch {
    // Degrade to fusion order — a rerank outage must never break search.
    return fused.slice(0, topK).map(({ id: _id, ...chunk }) => chunk);
  }
}
