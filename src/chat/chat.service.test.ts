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
vi.mock("../tools/tenant-tools.service", () => ({ listActiveTools: vi.fn(async () => []) }));

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

  it("yields a tool_call event for a non-search_knowledge tool result", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "lookup_order",
          input: { orderId: "123" },
          output: { status: "shipped" },
        },
        { type: "finish", totalUsage: {} },
      ]) as never,
    );

    const { runChat } = await import("./chat.service");
    const events = await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    expect(events).toContainEqual({
      event: "tool_call",
      data: { toolName: "lookup_order", arguments: { orderId: "123" }, result: { status: "shipped" } },
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

  it("does not stop the tool loop the instant search_knowledge is called, before the model can use its result", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(fakeResult([{ type: "finish", totalUsage: {} }]) as never);

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    const callArgs = vi.mocked(streamText).mock.calls[0]![0] as { stopWhen: unknown };
    const stopConditions = Array.isArray(callArgs.stopWhen) ? callArgs.stopWhen : [callArgs.stopWhen];

    // A step where the model has only just called the tool: no synthesized
    // answer yet. None of the real stop conditions should fire here, or the
    // loop ends before the model gets a chance to read the tool's result.
    const stepAfterToolCallOnly = [{ toolCalls: [{ toolName: "search_knowledge" }] }];

    const results = await Promise.all(
      (stopConditions as Array<(o: { steps: unknown[] }) => boolean | PromiseLike<boolean>>).map((fn) =>
        Promise.resolve(fn({ steps: stepAfterToolCallOnly })),
      ),
    );

    expect(results.some(Boolean)).toBe(false);
  });

  it("builds context before persisting the current turn's message, so the sliding window never already contains it", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { buildContext } = await import("./history");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(fakeResult([{ type: "finish", totalUsage: {} }]) as never);

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    // If appendMessage("user", ...) ran first, buildContext's next real read
    // would already include the current turn's message, and the manual
    // append below would duplicate it.
    const buildContextOrder = vi.mocked(buildContext).mock.invocationCallOrder[0]!;
    const firstAppendOrder = vi.mocked(appendMessage).mock.invocationCallOrder[0]!;
    expect(buildContextOrder).toBeLessThan(firstAppendOrder);

    const callArgs = vi.mocked(streamText).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const currentUserMessageCount = callArgs.messages.filter(
      (m) => m.role === "user" && m.content === "hi",
    ).length;
    expect(currentUserMessageCount).toBe(1);
  });

  it("falls back to a placeholder instead of persisting an empty assistant message when the model returns no text", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    // No text-delta at all: reachable when the model spends every step on
    // tool calls and MAX_TOOL_LOOP_STEPS cuts the loop off before any reply.
    vi.mocked(streamText).mockReturnValue(fakeResult([{ type: "finish", totalUsage: {} }]) as never);

    const { runChat } = await import("./chat.service");
    const events = await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    const assistantCall = vi.mocked(appendMessage).mock.calls.find((call) => call[2] === "assistant");
    expect(assistantCall?.[3]).toBeTruthy();

    // What the client saw live must match what got persisted, so reloading
    // history later doesn't show different text than the stream did.
    const tokenText = events
      .filter((e): e is { event: "token"; data: { text: string } } => e.event === "token")
      .map((e) => e.data.text)
      .join("");
    expect(tokenText).toBe(assistantCall?.[3]);
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

  it("includes a tenant's registered custom tools alongside search_knowledge in the same turn", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { listActiveTools } = await import("../tools/tenant-tools.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(listActiveTools).mockResolvedValue([
      {
        id: "tool-1",
        name: "lookup_order",
        description: "Looks up an order",
        inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
        endpointUrl: "https://tenant.example.com/tool",
        hmacSecret: "whsec_x",
        authHeader: null,
      },
    ] as never);
    vi.mocked(streamText).mockReturnValue(fakeResult([{ type: "finish", totalUsage: {} }]) as never);

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    const callArgs = vi.mocked(streamText).mock.calls[0]![0] as { tools: Record<string, unknown> };
    expect(Object.keys(callArgs.tools)).toEqual(
      expect.arrayContaining(["search_knowledge", "lookup_order"]),
    );
  });

  it("still reaches done when a custom tool's execute resolves to a failure shape", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { listActiveTools } = await import("../tools/tenant-tools.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(listActiveTools).mockResolvedValue([
      {
        id: "tool-1",
        name: "lookup_order",
        description: "Looks up an order",
        inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
        endpointUrl: "https://tenant.example.com/tool",
        hmacSecret: "whsec_x",
        authHeader: null,
      },
    ] as never);
    // callTenantEndpoint never throws, so a dead tenant endpoint reaches the
    // loop as ordinary data: the exact { error } shape custom-tool.ts maps a
    // failed call to. The turn must carry on and finish, not abort.
    vi.mocked(streamText).mockReturnValue(
      fakeResult([
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "lookup_order",
          input: { orderId: "123" },
          output: { error: "Tool endpoint responded with status 500" },
        },
        { type: "text-delta", id: "1", text: "Sorry, I can't reach that system right now." },
        { type: "finish", totalUsage: {} },
      ]) as never,
    );

    const { runChat } = await import("./chat.service");
    const events = await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    expect(events).toContainEqual({
      event: "tool_call",
      data: {
        toolName: "lookup_order",
        arguments: { orderId: "123" },
        result: { error: "Tool endpoint responded with status 500" },
      },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ event: "error" }));
    expect(events.at(-1)).toEqual({
      event: "done",
      data: { conversationId: "conv-1", messageId: "msg-1" },
    });
  });

  it("does not include a revoked or another tenant's tool", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { listActiveTools } = await import("../tools/tenant-tools.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(listActiveTools).mockResolvedValue([]); // the service itself already excludes these
    vi.mocked(streamText).mockReturnValue(fakeResult([{ type: "finish", totalUsage: {} }]) as never);

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    const callArgs = vi.mocked(streamText).mock.calls[0]![0] as { tools: Record<string, unknown> };
    expect(Object.keys(callArgs.tools)).toEqual(["search_knowledge"]);
  });
});
