import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { callTenantEndpoint } from "./call-tenant-endpoint";
import type { ActiveTool } from "./tenant-tools.service";

function fakeTool(overrides: Partial<ActiveTool> = {}): ActiveTool {
  return {
    id: "tool-1",
    name: "lookup_order",
    description: "Look up an order",
    inputSchema: { type: "object", properties: {} },
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

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("callTenantEndpoint", () => {
  it("signs the request so an independent HMAC verification succeeds", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedBody = "";

    server = createServer((req, res) => {
      receivedHeaders = req.headers;
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        receivedBody = raw;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "shipped" }));
      });
    });
    const port = await listen(server);

    const tool = fakeTool({ endpointUrl: `http://127.0.0.1:${port}` });
    const result = await callTenantEndpoint(tool, { orderId: "123" }, "conv-1");

    expect(result).toEqual({ ok: true, data: { status: "shipped" } });

    // The exact verification a real tenant would implement, using nothing
    // but the secret returned at registration, the timestamp header, and the
    // raw body this service actually sent.
    const timestamp = receivedHeaders["x-webhook-timestamp"];
    const signature = receivedHeaders["x-webhook-signature"];
    const expectedSignature = createHmac("sha256", tool.hmacSecret)
      .update(`${String(timestamp)}.${receivedBody}`)
      .digest("hex");

    expect(signature).toBe(expectedSignature);
    expect(JSON.parse(receivedBody)).toEqual({
      toolName: "lookup_order",
      arguments: { orderId: "123" },
      conversationId: "conv-1",
    });
  });

  it("sends the configured static auth header", async () => {
    let receivedAuth: string | undefined;
    server = createServer((req, res) => {
      receivedAuth = req.headers["authorization"];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const port = await listen(server);

    const tool = fakeTool({
      endpointUrl: `http://127.0.0.1:${port}`,
      authHeader: { name: "Authorization", value: "Bearer tenant-key" },
    });
    await callTenantEndpoint(tool, {}, "conv-1");

    expect(receivedAuth).toBe("Bearer tenant-key");
  });

  it("degrades gracefully instead of hanging when the endpoint never responds", async () => {
    server = createServer(() => {
      // deliberately never responds
    });
    const port = await listen(server);

    const tool = fakeTool({ endpointUrl: `http://127.0.0.1:${port}` });
    const start = Date.now();
    const result = await callTenantEndpoint(tool, {}, "conv-1");
    const elapsedMs = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(6000);
  }, 10_000);

  it("degrades gracefully on a non-2xx response", async () => {
    server = createServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const port = await listen(server);

    const tool = fakeTool({ endpointUrl: `http://127.0.0.1:${port}` });
    const result = await callTenantEndpoint(tool, {}, "conv-1");

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("500") });
  });

  it("degrades gracefully when the endpoint is unreachable", async () => {
    const tool = fakeTool({ endpointUrl: "http://127.0.0.1:1" }); // nothing listens on port 1
    const result = await callTenantEndpoint(tool, {}, "conv-1");

    expect(result.ok).toBe(false);
  });

  it("degrades gracefully instead of rejecting when args cannot be JSON-serialized", async () => {
    const tool = fakeTool();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(callTenantEndpoint(tool, circular, "conv-1")).resolves.toEqual({
      ok: false,
      reason: expect.any(String),
    });
  });
});
