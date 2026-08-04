import { afterEach, describe, expect, it, vi } from "vitest";
import { embedDocuments, embedQuery } from "./voyage";

vi.mock("@ai-sdk/voyage", () => ({
  createVoyage: vi.fn(() => ({
    reranking: vi.fn(() => ({ modelId: "rerank-2.5-lite" })),
  })),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    rerank: vi.fn(),
  };
});

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("embedDocuments", () => {
  it("returns embeddings ordered by the API's index field", async () => {
    stubFetch({
      data: [
        { embedding: [0.2], index: 1 },
        { embedding: [0.1], index: 0 },
      ],
    });

    expect(await embedDocuments(["a", "b"])).toEqual([[0.1], [0.2]]);
  });

  it("sends input_type=document", async () => {
    const fetchMock = stubFetch({ data: [{ embedding: [0.1], index: 0 }] });
    await embedDocuments(["a"]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.input_type).toBe("document");
  });

  it("returns an empty array without calling the API for empty input", async () => {
    const fetchMock = stubFetch({ data: [] });
    expect(await embedDocuments([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws with the status code when the API fails", async () => {
    stubFetch({ error: "bad" }, 500);
    await expect(embedDocuments(["a"])).rejects.toThrow(/500/);
  });
});

describe("embedQuery", () => {
  it("sends input_type=query and returns one vector", async () => {
    const fetchMock = stubFetch({ data: [{ embedding: [0.5], index: 0 }] });

    expect(await embedQuery("paracetamol")).toEqual([0.5]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.input_type).toBe("query");
  });
});

describe("rerank", () => {
  it("returns original indices ordered by relevance, truncated to topN", async () => {
    const { rerank: mockRerank } = await import("ai");
    vi.mocked(mockRerank).mockResolvedValue({
      ranking: [
        { originalIndex: 2, score: 0.9, document: "c" },
        { originalIndex: 0, score: 0.7, document: "a" },
      ],
    } as never);

    const { rerank } = await import("./voyage");
    const result = await rerank("query", ["a", "b", "c"], 2);

    expect(result).toEqual([2, 0]);
  });

  it("propagates a rerank API failure so callers can decide how to degrade", async () => {
    const { rerank: mockRerank } = await import("ai");
    vi.mocked(mockRerank).mockRejectedValue(new Error("Voyage rerank request failed (500)"));

    const { rerank } = await import("./voyage");

    await expect(rerank("query", ["a", "b"], 1)).rejects.toThrow(/500/);
  });
});
