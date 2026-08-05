import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { tenants, tenantTools } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import {
  listActiveTools,
  listPublicTools,
  registerTool,
  revokeTool,
  ToolNameConflictError,
} from "./tenant-tools.service";

async function clean() {
  await db.delete(tenantTools);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

const input = {
  name: "lookup_order",
  description: "Look up an order by ID",
  inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
  endpointUrl: "https://tenant.example.com/tool",
};

describe("registerTool", () => {
  it("returns the hmacSecret in plaintext exactly once", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const registered = await registerTool(tenant.id, input);

    expect(registered.hmacSecret).toMatch(/^whsec_/);
  });

  it("stores the hmacSecret encrypted, never as plaintext", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const registered = await registerTool(tenant.id, input);

    const stored = (await db.select().from(tenantTools))[0]!;
    expect(stored.hmacSecretEncrypted).not.toContain(registered.hmacSecret);
  });

  it("throws ToolNameConflictError when the same tenant registers the same active name twice", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    await registerTool(tenant.id, input);

    await expect(registerTool(tenant.id, input)).rejects.toThrow(ToolNameConflictError);
  });

  it("allows re-registering a name after the earlier tool is revoked", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const first = await registerTool(tenant.id, input);
    await revokeTool(tenant.id, first.name);

    await expect(registerTool(tenant.id, input)).resolves.toBeDefined();
  });
});

describe("listPublicTools", () => {
  it("never includes the hmacSecret or authHeader value", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    await registerTool(tenant.id, { ...input, authHeader: { name: "Authorization", value: "secret" } });

    const list = await listPublicTools(tenant.id);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("secret");
    expect(JSON.stringify(list)).not.toMatch(/hmacSecret|whsec_/);
  });

  it("excludes revoked tools", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const registered = await registerTool(tenant.id, input);
    await revokeTool(tenant.id, registered.name);

    expect(await listPublicTools(tenant.id)).toHaveLength(0);
  });

  it("never returns another tenant's tools", async () => {
    const a = await createTenant({ name: "A", slug: "a" });
    const b = await createTenant({ name: "B", slug: "b" });
    await registerTool(a.id, input);

    expect(await listPublicTools(b.id)).toHaveLength(0);
  });
});

describe("listActiveTools", () => {
  it("decrypts the hmacSecret back to its original plaintext", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const registered = await registerTool(tenant.id, input);

    const [active] = await listActiveTools(tenant.id);
    expect(active!.hmacSecret).toBe(registered.hmacSecret);
  });

  it("decrypts the authHeader value when one was set", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    await registerTool(tenant.id, { ...input, authHeader: { name: "Authorization", value: "Bearer xyz" } });

    const [active] = await listActiveTools(tenant.id);
    expect(active!.authHeader).toEqual({ name: "Authorization", value: "Bearer xyz" });
  });

  it("returns null authHeader when none was set", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    await registerTool(tenant.id, input);

    const [active] = await listActiveTools(tenant.id);
    expect(active!.authHeader).toBeNull();
  });
});

describe("revokeTool", () => {
  it("returns false for a tool that does not exist", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    expect(await revokeTool(tenant.id, "no_such_tool")).toBe(false);
  });

  it("returns false when the name belongs to another tenant", async () => {
    const a = await createTenant({ name: "A", slug: "a" });
    const b = await createTenant({ name: "B", slug: "b" });
    await registerTool(a.id, input);

    expect(await revokeTool(b.id, input.name)).toBe(false);
  });
});
