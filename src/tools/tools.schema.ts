import Ajv from "ajv";
import { z } from "zod";

const ajv = new Ajv({ strict: false });

// search_knowledge is Sprint 2's built-in tool name — a tenant registering
// the same name would silently shadow it in the tools object passed to
// streamText, which is confusing at best and a correctness bug at worst.
const RESERVED_TOOL_NAMES = new Set(["search_knowledge"]);

const jsonSchemaObject = z
  .record(z.string(), z.unknown())
  .refine((schema) => schema.type === "object", {
    message: 'inputSchema must have "type": "object" at its root — a tool\'s parameters are always an object',
  })
  .refine(
    (schema) => {
      try {
        ajv.compile(schema);
        return true;
      } catch {
        return false;
      }
    },
    { message: "inputSchema is not a valid JSON Schema" },
  );

export const registerToolBody = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid identifier: letters, numbers, underscores, not starting with a digit")
    .refine((name) => !RESERVED_TOOL_NAMES.has(name), { message: "this name is reserved" })
    .describe("The tool name the model will see and call, e.g. lookup_order."),
  description: z.string().min(1).max(1000).describe("Shown to the model — be specific about what this tool does."),
  inputSchema: jsonSchemaObject.describe("A JSON Schema (draft-07) object describing this tool's parameters."),
  endpointUrl: z.string().url(),
  authHeader: z
    .object({ name: z.string().min(1), value: z.string().min(1) })
    .optional()
    .describe("One static header (e.g. Authorization) sent on every call to your endpoint."),
});

export const toolNameParams = z.object({ name: z.string().min(1) });

export const toolResponse = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  endpointUrl: z.string(),
  createdAt: z.string(),
});

export const registerToolResponse = toolResponse.extend({
  hmacSecret: z.string().describe("Shown exactly once. Store it now — it verifies every call to your endpoint."),
});
