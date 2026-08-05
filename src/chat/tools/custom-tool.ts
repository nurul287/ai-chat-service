import { dynamicTool, jsonSchema } from "ai";
import { callTenantEndpoint } from "../../tools/call-tenant-endpoint";
import type { ActiveTool } from "../../tools/tenant-tools.service";

/**
 * jsonSchema() wraps the tenant's raw JSON Schema directly as a valid tool
 * schema — confirmed against @ai-sdk/provider-utils's real type declarations,
 * no schema-conversion library needed. dynamicTool() (rather than tool()) is
 * for exactly this case: a tool whose input shape isn't known until runtime.
 */
export function buildCustomTool(tool: ActiveTool, conversationId: string) {
  return dynamicTool({
    description: tool.description,
    inputSchema: jsonSchema(tool.inputSchema),
    execute: async (args) => {
      const result = await callTenantEndpoint(tool, args, conversationId);
      return result.ok ? result.data : { error: result.reason };
    },
  });
}
