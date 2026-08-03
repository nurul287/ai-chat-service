import { describe, expect, it } from "vitest";
import { adaptStream } from "./stream-adapter";

async function* fakeStream(parts: unknown[]) {
  for (const part of parts) yield part;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("adaptStream", () => {
  it("emits a token event per text-delta", async () => {
    const events = await collect(
      adaptStream(fakeStream([{ type: "text-delta", id: "1", text: "Para" }]) as never),
    );
    expect(events).toEqual([{ type: "token", text: "Para" }]);
  });

  it("emits a sources event for a search_knowledge tool-result", async () => {
    const events = await collect(
      adaptStream(
        fakeStream([
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "search_knowledge",
            input: { query: "fever" },
            output: [{ externalId: "sku-1" }],
          },
        ]) as never,
      ),
    );
    expect(events).toEqual([{ type: "sources", documents: [{ externalId: "sku-1" }] }]);
  });

  it("ignores tool-results from any tool other than search_knowledge", async () => {
    const events = await collect(
      adaptStream(
        fakeStream([
          { type: "tool-result", toolCallId: "c1", toolName: "some_other_tool", input: {}, output: {} },
        ]) as never,
      ),
    );
    expect(events).toEqual([]);
  });

  it("emits a finish event carrying totalUsage", async () => {
    const events = await collect(
      adaptStream(
        fakeStream([
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          },
        ]) as never,
      ),
    );
    expect(events).toEqual([
      { type: "finish", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
    ]);
  });

  it("emits an error event, mapping to internal_error by default", async () => {
    const events = await collect(
      adaptStream(fakeStream([{ type: "error", error: new Error("boom") }]) as never),
    );
    expect(events).toEqual([{ type: "error", code: "internal_error", message: "boom" }]);
  });

  it("passes through multiple text-deltas across steps in order", async () => {
    const events = await collect(
      adaptStream(
        fakeStream([
          { type: "text-delta", id: "1", text: "Para" },
          { type: "text-delta", id: "1", text: "cetamol" },
        ]) as never,
      ),
    );
    expect(events.map((e) => (e.type === "token" ? e.text : null))).toEqual(["Para", "cetamol"]);
  });

  it("ignores event types it does not need to surface (start, start-step, finish-step)", async () => {
    const events = await collect(
      adaptStream(
        fakeStream([{ type: "start" }, { type: "start-step" }, { type: "finish-step" }]) as never,
      ),
    );
    expect(events).toEqual([]);
  });
});
