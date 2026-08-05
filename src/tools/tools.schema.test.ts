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

  it("rejects a non-HTTPS endpointUrl loosely — still requires a valid URL", () => {
    const result = registerToolBody.safeParse({ ...validBody, endpointUrl: "not-a-url" });
    expect(result.success).toBe(false);
  });
});
