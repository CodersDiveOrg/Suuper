import { randomUUID } from "node:crypto";
import { prisma } from "@platform/database";
import { embedBatch, toPgVector } from "@platform/shared-ai";
import { nextAutoSync } from "@platform/shared-types";
import { scrapeStore } from "./scrape";
import { embeddingText } from "./scraped-product";

/** The whole ingestion job: scrape -> embed -> save -> flip KnowledgeBase.status.
 * Runs off the request path (queued by knowledge-service, consumed here). */
export async function processKnowledgeBase(knowledgeBaseId: string): Promise<void> {
  const knowledgeBase = await prisma.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
  if (!knowledgeBase) {
    console.warn(`[worker] knowledge base ${knowledgeBaseId} no longer exists, skipping`);
    return;
  }
  if (!knowledgeBase.sourceUrl) {
    await markError(knowledgeBaseId, "No source URL was provided.");
    return;
  }

  let result;
  try {
    result = await scrapeStore(knowledgeBase.sourceUrl);
  } catch (error) {
    await markError(knowledgeBaseId, `Ingestion failed: ${(error as Error).message}`);
    return;
  }

  if (!result || result.products.length === 0) {
    await markError(knowledgeBaseId, "Could not find any products at that URL.");
    return;
  }

  console.log(
    `[worker] ${knowledgeBaseId}: found ${result.products.length} products via "${result.source}", embedding...`,
  );
  const embeddings = await embedBatch(result.products.map(embeddingText));

  // A re-sync replaces the catalog in one go, so bots never see it half-loaded.
  const products = result.products;
  await prisma.$transaction(
    async (tx) => {
      await tx.product.deleteMany({ where: { knowledgeBaseId } });
      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        await tx.$executeRaw`
          INSERT INTO "Product"
            (id, "businessId", "knowledgeBaseId", "externalId", title, description, price, currency, "imageUrl", "productUrl", raw, embedding)
          VALUES (
            ${randomUUID()}, ${knowledgeBase.businessId}, ${knowledgeBaseId}, ${product.externalId ?? null},
            ${product.title}, ${product.description ?? null}, ${product.price ?? null}, ${product.currency ?? null},
            ${product.imageUrl ?? null}, ${product.productUrl}, ${JSON.stringify(product)}::jsonb, ${toPgVector(embeddings[i])}::vector
          )
          ON CONFLICT ("knowledgeBaseId", "externalId") DO NOTHING
        `;
      }
      const syncedAt = new Date();
      await tx.knowledgeBase.update({
        where: { id: knowledgeBaseId },
        data: {
          status: "ready",
          productCount: await tx.product.count({ where: { knowledgeBaseId } }),
          syncedAt,
          errorMessage: null,
          nextSyncAt: nextAutoSync(knowledgeBase.autoSync, syncedAt),
        },
      });
    },
    { timeout: 120_000 },
  );
  console.log(`[worker] ${knowledgeBaseId}: ready (${result.products.length} products)`);
}

/** A failed (re-)sync leaves the last good catalog in place for bots; the error shows on the source. */
async function markError(knowledgeBaseId: string, message: string): Promise<void> {
  console.warn(`[worker] ${knowledgeBaseId}: ${message}`);
  const knowledgeBase = await prisma.knowledgeBase.findUnique({ where: { id: knowledgeBaseId }, select: { autoSync: true } });
  await prisma.knowledgeBase
    .update({
      where: { id: knowledgeBaseId },
      data: { status: "error", errorMessage: message, nextSyncAt: nextAutoSync(knowledgeBase?.autoSync) },
    })
    .catch(() => undefined); // deleted mid-run
}
