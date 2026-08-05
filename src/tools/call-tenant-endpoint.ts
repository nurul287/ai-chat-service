import { createHmac } from "node:crypto";
import type { ActiveTool } from "./tenant-tools.service";

const TIMEOUT_MS = 5000;

export type TenantToolCallResult = { ok: true; data: unknown } | { ok: false; reason: string };

/**
 * Never throws. A tenant's endpoint being slow, down, or erroring is an
 * expected, ordinary outcome — not a service-level failure — so it always
 * resolves to a result the chat turn can react to and finish cleanly.
 */
export async function callTenantEndpoint(
  tool: ActiveTool,
  args: unknown,
  conversationId: string,
): Promise<TenantToolCallResult> {
  try {
    const body = JSON.stringify({ toolName: tool.name, arguments: args, conversationId });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", tool.hmacSecret).update(`${timestamp}.${body}`).digest("hex");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Webhook-Timestamp": timestamp,
      "X-Webhook-Signature": signature,
    };
    if (tool.authHeader) headers[tool.authHeader.name] = tool.authHeader.value;

    const res = await fetch(tool.endpointUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      return { ok: false, reason: `Tool endpoint responded with status ${res.status}` };
    }

    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: "Tool endpoint did not respond in time or the request failed" };
  }
}
