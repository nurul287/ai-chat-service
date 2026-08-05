import type { TextStreamPart, ToolSet } from "ai";
import type { RetrievedChunk } from "../retrieval/retrieve";

export type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "sources"; documents: RetrievedChunk[] }
  | { type: "tool_call"; toolName: string; arguments: unknown; result: unknown }
  | {
      type: "finish";
      usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    }
  | { type: "error"; code: "internal_error"; message: string };

/**
 * Translates the AI SDK's rich TextStreamPart union into the small set of
 * events this service actually surfaces. Deliberately pure — no Fastify, no
 * database, no network — so it is testable with a fake source stream alone.
 *
 * `search_knowledge`'s tool-result becomes a `sources` event; every other
 * tool's result becomes a `tool_call` event — that's how a tenant's custom
 * tool (Sprint 3) becomes visible to the client, the same transparency
 * principle as search_knowledge's citations.
 */
export async function* adaptStream(
  source: AsyncIterable<TextStreamPart<ToolSet>>,
): AsyncGenerator<ChatStreamEvent> {
  for await (const part of source) {
    switch (part.type) {
      case "text-delta":
        yield { type: "token", text: part.text };
        break;
      case "tool-result":
        if (part.toolName === "search_knowledge") {
          yield { type: "sources", documents: part.output as RetrievedChunk[] };
        } else {
          yield { type: "tool_call", toolName: part.toolName, arguments: part.input, result: part.output };
        }
        break;
      case "finish":
        yield {
          type: "finish",
          usage: {
            inputTokens: part.totalUsage.inputTokens ?? undefined,
            outputTokens: part.totalUsage.outputTokens ?? undefined,
            totalTokens: part.totalUsage.totalTokens ?? undefined,
          },
        };
        break;
      case "error":
        yield {
          type: "error",
          code: "internal_error",
          message: part.error instanceof Error ? part.error.message : String(part.error),
        };
        break;
      default:
        // start, start-step, finish-step, tool-call, reasoning-*, source,
        // file, tool-input-*, tool-error, raw, abort — none are surfaced to
        // the client in Sprint 2. tool-error specifically: search_knowledge's
        // execute() never throws (retrieve() already degrades internally on
        // its own failures), so a tool-error here would indicate a genuine
        // bug, not a normal degrade path — worth revisiting if Sprint 3's
        // tenant-registered tools can fail in ways that should reach the client.
        break;
    }
  }
}
