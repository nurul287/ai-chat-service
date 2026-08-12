import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  allowedOrigins: jsonb("allowed_origins").default([]).notNull().$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text().notNull(),
    kind: text().notNull().default("secret").$type<"secret" | "publishable">(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_api_keys_tenant").on(table.tenantId),
    check("api_keys_kind_check", sql`${table.kind} in ('secret', 'publishable')`),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    title: text(),
    content: text().notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_documents_tenant").on(table.tenantId),
    unique("documents_tenant_id_external_id_key").on(table.tenantId, table.externalId),
  ],
);

// `fts` is a generated tsvector column (migration 002) and is deliberately not
// mapped here — Drizzle has no generated-column type for it, and it is only
// ever read through raw SQL in the keyword search leg.
export const chunks = pgTable(
  "chunks",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text().notNull(),
    embedding: vector({ dimensions: 1024 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_chunks_tenant").on(table.tenantId),
    index("idx_chunks_document").on(table.documentId),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;

export const conversations = pgTable(
  "conversations",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    externalUserId: text("external_user_id").notNull(),
    intentSummary: text("intent_summary"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_conversations_tenant_user").on(table.tenantId, table.externalUserId)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    role: text().notNull().$type<"user" | "assistant">(),
    content: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_messages_conversation").on(table.conversationId, table.createdAt),
    index("idx_messages_tenant").on(table.tenantId),
    check("messages_role_check", sql`${table.role} in ('user', 'assistant')`),
  ],
);

export const chatMetrics = pgTable(
  "chat_metrics",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    costCredits: numeric("cost_credits"),
    toolCallCount: integer("tool_call_count").default(0).notNull(),
    retrievedChunkCount: integer("retrieved_chunk_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_chat_metrics_tenant").on(table.tenantId)],
);

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ChatMetric = typeof chatMetrics.$inferSelect;

export const tenantTools = pgTable(
  "tenant_tools",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull(),
    inputSchema: jsonb("input_schema").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    hmacSecretEncrypted: text("hmac_secret_encrypted").notNull(),
    authHeaderName: text("auth_header_name"),
    authHeaderValueEncrypted: text("auth_header_value_encrypted"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_tenant_tools_tenant").on(table.tenantId),
    // Partial unique index, not a table-level unique() constraint — unique()
    // has no .where(), and a revoked tool must not block re-registering the
    // same name. Verified against drizzle-orm/pg-core/indexes.d.ts.
    uniqueIndex("idx_tenant_tools_tenant_name_active")
      .on(table.tenantId, table.name)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export type TenantTool = typeof tenantTools.$inferSelect;
