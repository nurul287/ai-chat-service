import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ActiveTool } from "../../tools/tenant-tools.service";
import { buildCustomTool } from "./custom-tool";

function fakeTool(overrides: Partial<ActiveTool> = {}): ActiveTool {
  return {
    id: "tool-1",
    name: "lookup_order",
    description: "Look up an order",
    inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
    endpointUrl: "http://127.0.0.1:1",
    hmacSecret: "whsec_test_secret",
    authHeader: null,
    ...overrides,
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

/**
 * dynamicTool's execute is `(input, options: ToolExecutionOptions)` — matching
 * @ai-sdk/provider-utils's real ToolExecuteFunction declaration, and the same
 * shape search-knowledge.test.ts passes.
 */
const toolExecOptions = {
  toolCallId: "test",
  messages: [],
  context: {},
};

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("buildCustomTool", () => {
  it("returns the endpoint's raw JSON data on success", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "shipped", eta: "2026-08-12" }));
    });
    const port = await listen(server);

    const tool = buildCustomTool(fakeTool({ endpointUrl: `http://127.0.0.1:${port}` }), "conv-1");
    const result = await tool.execute!({ orderId: "123" }, toolExecOptions);

    // The raw body, not wrapped in an envelope — this is what the model sees.
    expect(result).toEqual({ status: "shipped", eta: "2026-08-12" });
  });

  it("passes the model's arguments and the conversationId through to the endpoint", async () => {
    let receivedBody = "";
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        receivedBody = raw;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    const port = await listen(server);

    const tool = buildCustomTool(fakeTool({ endpointUrl: `http://127.0.0.1:${port}` }), "conv-42");
    await tool.execute!({ orderId: "123" }, toolExecOptions);

    expect(JSON.parse(receivedBody)).toEqual({
      toolName: "lookup_order",
      arguments: { orderId: "123" },
      conversationId: "conv-42",
    });
  });

  it("resolves to an { error } shape rather than throwing when the endpoint 500s", async () => {
    server = createServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const port = await listen(server);

    const tool = buildCustomTool(fakeTool({ endpointUrl: `http://127.0.0.1:${port}` }), "conv-1");
    const result = await tool.execute!({ orderId: "123" }, toolExecOptions);

    // callTenantEndpoint never throws, so this is ordinary data the model can
    // react to — the tool loop must not see a rejected promise here.
    expect(result).toEqual({ error: expect.stringContaining("500") });
  });

  it("resolves to an { error } shape rather than throwing when the endpoint is unreachable", async () => {
    const tool = buildCustomTool(fakeTool({ endpointUrl: "http://127.0.0.1:1" }), "conv-1");

    await expect(tool.execute!({ orderId: "123" }, toolExecOptions)).resolves.toEqual({
      error: expect.any(String),
    });
  });

  it("exposes the tenant's description and JSON Schema to the model unchanged", () => {
    const active = fakeTool();
    const tool = buildCustomTool(active, "conv-1");

    expect(tool.description).toBe(active.description);
    expect((tool.inputSchema as { jsonSchema: unknown }).jsonSchema).toEqual(active.inputSchema);
  });
});
