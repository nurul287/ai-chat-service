import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { chunks, documents, type Document } from "../db/schema";
import { chunkText } from "../ingestion/chunk-text";
import { embedDocuments } from "../lib/voyage";

export type UpsertDocumentInput = {
  externalId: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
};

/**
 * Creates or replaces a document and its chunks, keyed by (tenantId,
 * externalId) so a host application can re-push the same record repeatedly
 * without duplicating it. Chunks are fully replaced rather than diffed:
 * content edits shift every downstream offset anyway, so a replace is both
 * simpler and strictly correct.
 */
export async function upsertDocument(
  tenantId: string,
  input: UpsertDocumentInput,
): Promise<Document> {
  const pieces = chunkText(input.content);
  const embeddings = await embedDocuments(pieces);

  return db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(documents)
      .values({
        tenantId,
        externalId: input.externalId,
        title: input.title ?? null,
        content: input.content,
        metadata: input.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [documents.tenantId, documents.externalId],
        set: {
          title: input.title ?? null,
          content: input.content,
          metadata: input.metadata ?? {},
          updatedAt: new Date().toISOString(),
        },
      })
      .returning();

    await tx.delete(chunks).where(eq(chunks.documentId, doc!.id));

    if (pieces.length > 0) {
      await tx.insert(chunks).values(
        pieces.map((content, index) => ({
          tenantId,
          documentId: doc!.id,
          chunkIndex: index,
          content,
          embedding: embeddings[index]!,
        })),
      );
    }

    return doc!;
  });
}

export async function deleteDocument(tenantId: string, externalId: string): Promise<boolean> {
  const deleted = await db
    .delete(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.externalId, externalId)))
    .returning({ id: documents.id });
  return deleted.length > 0;
}

export async function listDocuments(
  tenantId: string,
  page: number,
  limit: number,
): Promise<{ data: Document[]; total: number }> {
  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(documents)
      .where(eq(documents.tenantId, tenantId))
      .orderBy(desc(documents.updatedAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: count() }).from(documents).where(eq(documents.tenantId, tenantId)),
  ]);

  return { data: rows, total: Number(totals!.total) };
}
