import Ajv from "ajv";
import { z } from "zod";
import { isDisallowedHost, parseUrl } from "./host-validation";

const ajv = new Ajv({ strict: false });

// search_knowledge is Sprint 2's built-in tool name — a tenant registering
// the same name would silently shadow it in the tools object passed to
// streamText, which is confusing at best and a correctness bug at worst.
const RESERVED_TOOL_NAMES = new Set(["search_knowledge"]);

// callTenantEndpoint sets these on every outbound call. A tenant-configured
// authHeader with one of these names would overwrite the signature or the
// content type on the way out — silently, and on every single call.
const RESERVED_AUTH_HEADER_NAMES = new Set([
  "content-type",
  "x-webhook-timestamp",
  "x-webhook-signature",
]);

const jsonSchemaObject = z
  .record(z.string(), z.unknown())
  .refine((schema) => schema.type === "object", {
    message: 'inputSchema must have "type": "object" at its root — a tool\'s parameters are always an object',
  })
  .refine(
    // validateSchema checks the schema as data against the JSON-Schema
    // meta-schema and never compiles it. compile() was tried here first, but
    // ajv unconditionally caches every distinct schema it compiles in a
    // plain Map that is never evicted — even schemas that fail validation —
    // so calling it on every registration would grow unbounded per tenant.
    // Verified against the installed ajv@8.20.0: repeated validateSchema
    // calls on distinct schemas leave ajv's internal cache at size 1 (just
    // the meta-schema), while compile() grows it by one per distinct schema.
    (schema) => ajv.validateSchema(schema) === true,
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
  endpointUrl: z
    .string()
    .url()
    .refine((value) => parseUrl(value)?.protocol === "https:", {
      message: "endpointUrl must use https://",
    })
    .refine(
      (value) => {
        const url = parseUrl(value);
        return url !== null && !isDisallowedHost(url.hostname);
      },
      {
        message:
          "endpointUrl must point at a public host — loopback, link-local, private-range, .internal and .local addresses are rejected",
      },
    )
    .describe("An https:// URL on a publicly reachable host. This service calls it server-side."),
  authHeader: z
    .object({
      name: z
        .string()
        .min(1)
        .refine((name) => !RESERVED_AUTH_HEADER_NAMES.has(name.trim().toLowerCase()), {
          message: "this header is set by the service on every call and cannot be overridden",
        }),
      value: z.string().min(1),
    })
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
