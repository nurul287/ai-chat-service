import { describe, expect, it } from "vitest";
import { registerToolBody } from "./tools.schema";

const validBody = {
  name: "lookup_order",
  description: "Look up an order by ID",
  inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  endpointUrl: "https://tenant.example.com/tool",
};

describe("registerToolBody", () => {
  it("accepts a well-formed registration", () => {
    expect(registerToolBody.safeParse(validBody).success).toBe(true);
  });

  it("rejects the reserved name search_knowledge", () => {
    const result = registerToolBody.safeParse({ ...validBody, name: "search_knowledge" });
    expect(result.success).toBe(false);
  });

  it("rejects a name that is not a valid identifier", () => {
    const result = registerToolBody.safeParse({ ...validBody, name: "look up order" });
    expect(result.success).toBe(false);
  });

  it("rejects an inputSchema whose root type is not object", () => {
    const result = registerToolBody.safeParse({
      ...validBody,
      inputSchema: { type: "string" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an inputSchema that is not valid JSON Schema", () => {
    const result = registerToolBody.safeParse({
      ...validBody,
      inputSchema: { type: "object", properties: { orderId: { type: "not-a-real-type" } } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an optional authHeader", () => {
    const result = registerToolBody.safeParse({
      ...validBody,
      authHeader: { name: "Authorization", value: "Bearer xyz" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an authHeader whose name would clobber a header the service sets itself", () => {
    for (const name of ["Content-Type", "content-type", "X-Webhook-Signature", "x-webhook-timestamp"]) {
      const result = registerToolBody.safeParse({
        ...validBody,
        authHeader: { name, value: "anything" },
      });
      expect(result.success, `expected ${name} to be rejected`).toBe(false);
    }
  });

  it("rejects a string that is not a URL at all", () => {
    const result = registerToolBody.safeParse({ ...validBody, endpointUrl: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("requires https:// — a plain http:// endpoint is rejected", () => {
    const result = registerToolBody.safeParse({
      ...validBody,
      endpointUrl: "http://tenant.example.com/tool",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-http schemes outright", () => {
    for (const endpointUrl of ["file:///etc/passwd", "ftp://tenant.example.com/tool"]) {
      const result = registerToolBody.safeParse({ ...validBody, endpointUrl });
      expect(result.success, `expected ${endpointUrl} to be rejected`).toBe(false);
    }
  });

  it("rejects an https:// URL pointed at an internal or private host", () => {
    const internalUrls = [
      "https://169.254.169.254/latest/meta-data/", // cloud metadata
      "https://127.0.0.1:55322/",
      "https://localhost/tool",
      "https://10.0.0.1/tool",
      "https://172.16.0.1/tool",
      "https://192.168.1.1/tool",
      "https://postgres.railway.internal:5432/",
      "https://printer.local/tool",
      "https://[::1]/tool",
      "https://[fe80::1]/tool",
    ];

    for (const endpointUrl of internalUrls) {
      const result = registerToolBody.safeParse({ ...validBody, endpointUrl });
      expect(result.success, `expected ${endpointUrl} to be rejected`).toBe(false);
    }
  });

  it("rejects an https:// URL whose IPv6 literal embeds an internal IPv4 address", () => {
    // The full Zod path, not the isolated helper: this is what a real
    // registration request goes through. `new URL()` normalises the dotted
    // quad away (`[::ffff:169.254.169.254]` -> `[::ffff:a9fe:a9fe]`), so a
    // string-level check on the source text never fires here.
    const embeddedUrls = [
      "https://[::ffff:169.254.169.254]/latest/meta-data/", // IPv4-mapped cloud metadata
      "https://[::ffff:127.0.0.1]/tool", // IPv4-mapped loopback
      "https://[::ffff:10.0.0.1]/tool", // IPv4-mapped private range
      "https://[::169.254.169.254]/tool", // deprecated IPv4-compatible form
      "https://[64:ff9b::169.254.169.254]/tool", // NAT64 well-known prefix
    ];

    for (const endpointUrl of embeddedUrls) {
      const result = registerToolBody.safeParse({ ...validBody, endpointUrl });
      expect(result.success, `expected ${endpointUrl} to be rejected`).toBe(false);
    }
  });

  it("accepts a legitimate public https:// endpoint, including public IPs that merely look private", () => {
    const publicUrls = [
      "https://tenant.example.com/webhooks/lookup-order",
      "https://api.tenant.example.com:8443/tool",
      "https://100.20.30.40/tool", // not 10.x — a public address that shares a prefix
      "https://172.32.0.1/tool", // just outside 172.16.0.0/12
      "https://192.169.0.1/tool", // just outside 192.168.0.0/16
      "https://8.8.8.8/tool",
      "https://[2001:4860:4860::8888]/tool", // a genuine public IPv6
      "https://[::ffff:8.8.8.8]/tool", // IPv4-mapped, but the embedded address is public
    ];

    for (const endpointUrl of publicUrls) {
      const result = registerToolBody.safeParse({ ...validBody, endpointUrl });
      expect(result.success, `expected ${endpointUrl} to be accepted`).toBe(true);
    }
  });
});
