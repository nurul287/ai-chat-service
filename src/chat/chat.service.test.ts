import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: vi.fn() };
});
vi.mock("./model", () => ({ chatModel: { modelId: "fake" } }));
vi.mock("./tools/search-knowledge", () => ({
  searchKnowledgeTool: vi.fn(() => ({ description: "fake tool" })),
}));
vi.mock("./conversations.service", () => ({
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  appendMessage: vi.fn(),
  countUserMessages: vi.fn(async () => 1),
}));
vi.mock("./intent-summary", () => ({ maybeRefreshIntentSummary: vi.fn() }));
vi.mock("./history", () => ({ buildContext: vi.fn(async () => []) }));
vi.mock("./chat-metrics.service", () => ({ recordChatMetrics: vi.fn() }));

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

/** A fake `result.stream` matching streamText()'s real AsyncIterableStream shape closely enough for these tests. */
function fakeResult(parts: unknown[], finalStepProviderMetadata?: unknown) {
  async function* stream() {
    for (const part of parts) yield part;
  }
  return {
    stream: stream(),
    finalStep: Promise.resolve({ providerMetadata: finalStepProviderMetadata }),
  };
}

afterEach(() => vi.clearAllMocks());

describe("runChat", () => {
  it("creates a conversation eagerly when conversationId is omitted", async () => {
    const { createConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(createConversation).mockResolvedValue({ id: "conv-new" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([{ type: "text-delta", id: "1", text: "hi" }, { type: "finish", totalUsage: {} }]) as never,
    );

    const { runChat } = await import("./chat.service");
    const events = await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: null, message: "hello" }),
    );

    expect(createConversation).toHaveBeenCalledWith("t1", "u1");
    expect(events.at(-1)).toEqual({
      event: "done",
      data: { conversationId: "conv-new", messageId: "msg-1" },
    });
  });

  it("throws ConversationNotFoundError before ever calling the model when ownership does not match", async () => {
    const { getConversation } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue(null);

    const { runChat, ConversationNotFoundError } = await import("./chat.service");

    await expect(
      collect(
        runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-other", message: "hi" }),
      ),
    ).rejects.toThrow(ConversationNotFoundError);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("persists exactly one assistant message with the fully concatenated text", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([
        { type: "text-delta", id: "1", text: "Para" },
        { type: "text-delta", id: "1", text: "cetamol" },
        { type: "finish", totalUsage: {} },
      ]) as never,
    );

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    expect(appendMessage).toHaveBeenCalledWith("conv-1", "t1", "assistant", "Paracetamol");
    expect(appendMessage).toHaveBeenCalledTimes(2); // user turn + assistant turn
  });

  it("yields a sources event and counts retrieved chunks", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search_knowledge",
          input: {},
          output: [{ externalId: "sku-1" }, { externalId: "sku-2" }],
        },
        { type: "finish", totalUsage: {} },
      ]) as never,
    );

    const { runChat } = await import("./chat.service");
    const events = await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    expect(events).toContainEqual({
      event: "sources",
      data: { documents: [{ externalId: "sku-1" }, { externalId: "sku-2" }] },
    });
  });

  it("yields an error event and does NOT persist an assistant message when the stream errors", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([{ type: "error", error: new Error("rate limited") }]) as never,
    );

    const { runChat } = await import("./chat.service");
    const events = await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    expect(events).toContainEqual({
      event: "error",
      data: {
        conversationId: "conv-1",
        error: { code: "internal_error", message: "rate limited" },
      },
    });
    // Only the user's message was appended, never a second (assistant) call.
    expect(appendMessage).toHaveBeenCalledTimes(1);
  });

  it("triggers the intent summary refresh with the current user turn count", async () => {
    const { getConversation, appendMessage, countUserMessages } = await import(
      "./conversations.service"
    );
    const { maybeRefreshIntentSummary } = await import("./intent-summary");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(countUserMessages).mockResolvedValue(3);
    vi.mocked(streamText).mockReturnValue(fakeResult([{ type: "finish", totalUsage: {} }]) as never);

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    expect(maybeRefreshIntentSummary).toHaveBeenCalledWith("conv-1", 3);
  });

  it("records metrics including OpenRouter's cost from finalStep.providerMetadata", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { recordChatMetrics } = await import("./chat-metrics.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult(
        [{ type: "finish", totalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }],
        { openrouter: { usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cost: 0.0004 } } },
      ) as never,
    );

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    await vi.waitFor(() =>
      expect(recordChatMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ promptTokens: 100, completionTokens: 20, costCredits: 0.0004 }),
      ),
    );
  });

  it("defaults costCredits to null when providerMetadata has no openrouter usage (anthropic path)", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { recordChatMetrics } = await import("./chat-metrics.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([{ type: "finish", totalUsage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } }]) as never,
    );

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    await vi.waitFor(() =>
      expect(recordChatMetrics).toHaveBeenCalledWith(expect.objectContaining({ costCredits: null })),
    );
  });
});
