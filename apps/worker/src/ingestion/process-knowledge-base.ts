import { randomUUID } from "node:crypto";
import { prisma } from "@platform/database";
import { embedBatch, toPgVector } from "@platform/shared-ai";
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

  for (let i = 0; i < result.products.length; i++) {
    const product = result.products[i];
    const embedding = embeddings[i];
    await prisma.$executeRaw`
      INSERT INTO "Product"
        (id, "businessId", "knowledgeBaseId", "externalId", title, description, price, currency, "imageUrl", "productUrl", raw, embedding)
      VALUES (
        ${randomUUID()}, ${knowledgeBase.businessId}, ${knowledgeBaseId}, ${product.externalId ?? null},
        ${product.title}, ${product.description ?? null}, ${product.price ?? null}, ${product.currency ?? null},
        ${product.imageUrl ?? null}, ${product.productUrl}, ${JSON.stringify(product)}::jsonb, ${toPgVector(embedding)}::vector
      )
    `;
  }

  await prisma.knowledgeBase.update({
    where: { id: knowledgeBaseId },
    data: {
      status: "ready",
      productCount: result.products.length,
      syncedAt: new Date(),
      errorMessage: null,
    },
  });
  console.log(`[worker] ${knowledgeBaseId}: ready (${result.products.length} products)`);
}

async function markError(knowledgeBaseId: string, message: string): Promise<void> {
  console.warn(`[worker] ${knowledgeBaseId}: ${message}`);
  await prisma.knowledgeBase.update({
    where: { id: knowledgeBaseId },
    data: { status: "error", errorMessage: message },
  });
}
