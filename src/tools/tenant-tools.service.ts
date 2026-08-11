import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db";
import { tenantTools, type TenantTool } from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";

export class ToolNameConflictError extends Error {
  constructor(name: string) {
    super(`A tool named "${name}" is already registered for this tenant`);
    this.name = "ToolNameConflictError";
  }
}

export type RegisterToolInput = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  endpointUrl: string;
  authHeader?: { name: string; value: string };
};

export type RegisteredTool = {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  endpointUrl: string;
  hmacSecret: string;
  createdAt: string;
};

export type PublicTool = {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  endpointUrl: string;
  createdAt: string;
};

export type ActiveTool = {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  endpointUrl: string;
  hmacSecret: string;
  authHeader: { name: string; value: string } | null;
};

/**
 * Postgres's unique_violation SQLSTATE, translated to a domain error rather
 * than parsed by callers. Pre-checking for an existing name first would
 * still race a concurrent registration; catching the constraint at insert
 * time has no such window.
 */
const UNIQUE_VIOLATION = "23505";

export async function registerTool(tenantId: string, input: RegisterToolInput): Promise<RegisteredTool> {
  const hmacSecret = `whsec_${randomBytes(32).toString("base64url")}`;

  try {
    const [row] = await db
      .insert(tenantTools)
      .values({
        tenantId,
        name: input.name,
        description: input.description,
        inputSchema: input.inputSchema,
        endpointUrl: input.endpointUrl,
        hmacSecretEncrypted: encryptSecret(hmacSecret),
        authHeaderName: input.authHeader?.name ?? null,
        authHeaderValueEncrypted: input.authHeader ? encryptSecret(input.authHeader.value) : null,
      })
      .returning();

    const tool = row!;
    return {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      endpointUrl: tool.endpointUrl,
      hmacSecret,
      createdAt: tool.createdAt,
    };
  } catch (err) {
    // drizzle-orm wraps the driver error in a DrizzleQueryError; the real
    // postgres.PostgresError (with its SQLSTATE `code`) is on `.cause`, not
    // the caught error itself — confirmed against the actual thrown shape.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    if (cause instanceof postgres.PostgresError && cause.code === UNIQUE_VIOLATION) {
      throw new ToolNameConflictError(input.name);
    }
    throw err;
  }
}

export async function listPublicTools(tenantId: string): Promise<PublicTool[]> {
  const rows = await db
    .select({
      id: tenantTools.id,
      name: tenantTools.name,
      description: tenantTools.description,
      inputSchema: tenantTools.inputSchema,
      endpointUrl: tenantTools.endpointUrl,
      createdAt: tenantTools.createdAt,
    })
    .from(tenantTools)
    .where(and(eq(tenantTools.tenantId, tenantId), isNull(tenantTools.revokedAt)));

  return rows.map((row) => ({ ...row, inputSchema: row.inputSchema as Record<string, unknown> }));
}

export async function listActiveTools(tenantId: string): Promise<ActiveTool[]> {
  const rows: TenantTool[] = await db
    .select()
    .from(tenantTools)
    .where(and(eq(tenantTools.tenantId, tenantId), isNull(tenantTools.revokedAt)));

  // flatMap, not map: a single row whose secret will not decrypt (corrupted
  // column, rotated encryption key, hand-edited data) must not take down chat
  // for every conversation this tenant has. runChat calls this before
  // streamText and outside any try/catch, so a throw here turns every chat
  // turn — including ones that never touch a custom tool — into a bare 500
  // with no SSE stream, after the user's message has already been persisted.
  return rows.flatMap((row) => {
    try {
      return [
        {
          id: row.id,
          name: row.name,
          description: row.description,
          inputSchema: row.inputSchema as Record<string, unknown>,
          endpointUrl: row.endpointUrl,
          hmacSecret: decryptSecret(row.hmacSecretEncrypted),
          authHeader:
            row.authHeaderName && row.authHeaderValueEncrypted
              ? { name: row.authHeaderName, value: decryptSecret(row.authHeaderValueEncrypted) }
              : null,
        },
      ];
    } catch {
      // Identifiers only — never the ciphertext, never a decrypted value.
      console.warn(
        `[tenant-tools] skipping tool with undecryptable secret (toolId=${row.id} tenantId=${tenantId})`,
      );
      return [];
    }
  });
}

export async function revokeTool(tenantId: string, name: string): Promise<boolean> {
  const revoked = await db
    .update(tenantTools)
    .set({ revokedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(and(eq(tenantTools.tenantId, tenantId), eq(tenantTools.name, name), isNull(tenantTools.revokedAt)))
    .returning({ id: tenantTools.id });
  return revoked.length > 0;
}
