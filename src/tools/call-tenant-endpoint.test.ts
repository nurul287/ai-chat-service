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
  if (server) {
    // A test that deliberately leaves a response body unread (the size-cap
    // one) can leave a keep-alive socket open, and close() alone waits on it.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
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

  it("rejects an oversized response instead of buffering it into memory", async () => {
    // A real body matching the advertised length, so this is a well-formed
    // HTTP response that is simply too big — not a malformed one.
    const oversized = JSON.stringify({ blob: "x".repeat(1_100_000) });
    server = createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(oversized),
      });
      res.end(oversized);
    });
    const port = await listen(server);

    const tool = fakeTool({ endpointUrl: `http://127.0.0.1:${port}` });
    const result = await callTenantEndpoint(tool, {}, "conv-1");

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("exceeded") });
  });

  it("still accepts a normal-sized response that advertises a content-length", async () => {
    const body = JSON.stringify({ status: "shipped" });
    server = createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    });
    const port = await listen(server);

    const tool = fakeTool({ endpointUrl: `http://127.0.0.1:${port}` });
    const result = await callTenantEndpoint(tool, {}, "conv-1");

    expect(result).toEqual({ ok: true, data: { status: "shipped" } });
  });

  it("does not follow a redirect, so a public endpoint cannot bounce the call to an internal one", async () => {
    // The attack this closes: endpointUrl is validated once, at registration.
    // A tenant registers a genuinely public https:// endpoint (server A), then
    // has it 302 to an internal address (server B) at call time. With fetch's
    // default redirect: "follow", B's response streams back through the
    // tool_call event as if it were A's own.
    let internalServerReached = false;

    const internal = createServer((_req, res) => {
      internalServerReached = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ awsAccessKeyId: "AKIA_SHOULD_NEVER_BE_READ" }));
    });
    const internalPort = await listen(internal);

    try {
      server = createServer((_req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.1:${internalPort}/latest/meta-data/` });
        res.end();
      });
      const port = await listen(server);

      const tool = fakeTool({ endpointUrl: `http://127.0.0.1:${port}` });
      const result = await callTenantEndpoint(tool, {}, "conv-1");

      expect(result).toEqual({ ok: false, reason: expect.stringContaining("redirect") });

      // The result alone is not the security property — this is. The internal
      // server must never have been contacted at all.
      expect(internalServerReached).toBe(false);
    } finally {
      internal.closeAllConnections();
      await new Promise<void>((resolve) => internal.close(() => resolve()));
    }
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
