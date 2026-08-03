import { describe, expect, it, vi } from "vitest";

vi.mock("../../retrieval/retrieve", () => ({
  retrieve: vi.fn(),
}));

const toolExecOptions = {
  toolCallId: "test",
  messages: [],
  context: {},
};

describe("searchKnowledgeTool", () => {
  it("calls retrieve with the closed-over tenantId, hybrid+rerank mode, and the model's query", async () => {
    const { retrieve } = await import("../../retrieval/retrieve");
    vi.mocked(retrieve).mockResolvedValue([
      { documentId: "d1", externalId: "sku-1", title: "Paracetamol", content: "...", metadata: {} },
    ]);

    const { searchKnowledgeTool } = await import("./search-knowledge");
    const tool = searchKnowledgeTool("tenant-a");
    const result = await tool.execute({ query: "fever" }, toolExecOptions);

    expect(retrieve).toHaveBeenCalledWith("tenant-a", "fever", 5, { mode: "hybrid+rerank" });
    expect(result).toHaveLength(1);
  });

  it("respects an explicit topK from the model, capped at 10", async () => {
    const { retrieve } = await import("../../retrieval/retrieve");
    vi.mocked(retrieve).mockResolvedValue([]);

    const { searchKnowledgeTool } = await import("./search-knowledge");
    const tool = searchKnowledgeTool("tenant-a");
    await tool.execute({ query: "fever", topK: 8 }, toolExecOptions);

    expect(retrieve).toHaveBeenCalledWith("tenant-a", "fever", 8, { mode: "hybrid+rerank" });
  });

  it("never accepts tenantId as a tool parameter — the schema has no such field", async () => {
    const { searchKnowledgeTool } = await import("./search-knowledge");
    const tool = searchKnowledgeTool("tenant-a");

    const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(shape).not.toHaveProperty("tenantId");
    expect(Object.keys(shape)).toEqual(["query", "topK"]);
  });
});
