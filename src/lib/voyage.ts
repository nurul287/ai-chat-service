import { createVoyage } from "@ai-sdk/voyage";
import { rerank as aiRerank } from "ai";
import { config } from "../config";

const voyage = createVoyage({ apiKey: config.VOYAGE_API_KEY });

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

type VoyageEmbeddingsResponse = { data: { embedding: number[]; index: number }[] };

async function embed(input: string[], inputType: "query" | "document"): Promise<number[][]> {
  if (input.length === 0) return [];

  const res = await fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input,
      model: config.VOYAGE_EMBEDDING_MODEL,
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Voyage embeddings request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as VoyageEmbeddingsResponse;
  // The API does not guarantee response order matches input order — sort by
  // the index it returns so embeddings line up with their source texts.
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  return embed(texts, "document");
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embed([text], "query");
  if (!embedding) throw new Error("Voyage returned no embedding for the query");
  return embedding;
}

/**
 * Returns the original indices of `texts`, reordered by relevance to `query`
 * and truncated to `topN`. Index-based rather than returning reranked text
 * directly, so a caller with richer objects (see retrieve.ts) can reorder its
 * own array without this function needing to know that shape.
 *
 * Throws on failure rather than swallowing it — the caller decides whether
 * and how to degrade (retrieve() falls back to fusion order; this function
 * itself stays a thin, honest wrapper).
 */
export async function rerank(query: string, texts: string[], topN: number): Promise<number[]> {
  const { ranking } = await aiRerank({
    model: voyage.reranking("rerank-2.5-lite"),
    query,
    documents: texts,
    topN,
  });
  return ranking.map((r) => r.originalIndex);
}
