import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "@platform/database";
import { embed, toPgVector } from "@platform/shared-ai";
import { loadServiceConfig } from "@platform/shared-config";
import { INGEST_KNOWLEDGE_BASE_QUEUE, type IngestKnowledgeBaseJob } from "@platform/shared-types";

const config = loadServiceConfig("knowledge-service", 3004);
const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const ingestQueue = new Queue<IngestKnowledgeBaseJob>(INGEST_KNOWLEDGE_BASE_QUEUE, { connection });

interface KnowledgeBaseRow {
  id: string;
  businessId: string;
  name: string;
  sourceType: string;
  sourceUrl: string | null;
  status: string;
  errorMessage: string | null;
  productCount: number;
  syncedAt: Date | null;
  createdAt: Date;
}

interface ProductRow {
  id: string;
  businessId: string;
  knowledgeBaseId: string;
  externalId: string | null;
  title: string;
  description: string | null;
  price: number | null;
  currency: string | null;
  imageUrl: string | null;
  productUrl: string;
  createdAt: Date;
}

const SEARCH_LIMIT = 5;

@Injectable()
export class KnowledgeBasesService {
  /** Creates the KnowledgeBase row and drops the scrape job onto the queue — worker does the
   * actual fetch/embed/save off the request path (see docs/ARCHITECTURE.md worker section). */
  async create(businessId: string, name: string, sourceUrl: string) {
    if (!name.trim()) throw new BadRequestException("name is required");
    if (!sourceUrl.trim()) throw new BadRequestException("sourceUrl is required");

    const knowledgeBase = await prisma.knowledgeBase.create({
      data: {
        businessId,
        name: name.trim(),
        sourceType: "crawl",
        sourceUrl: sourceUrl.trim(),
        status: "syncing",
      },
    });

    await ingestQueue.add("ingest", { knowledgeBaseId: knowledgeBase.id });

    return this.serialize(knowledgeBase);
  }

  async list(businessId: string) {
    const knowledgeBases = await prisma.knowledgeBase.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
    });
    return knowledgeBases.map((kb) => this.serialize(kb));
  }

  async get(businessId: string, id: string) {
    return this.serialize(await this.require(businessId, id));
  }

  async listProducts(businessId: string, id: string) {
    await this.require(businessId, id);
    const products = await prisma.product.findMany({
      where: { knowledgeBaseId: id },
      orderBy: { createdAt: "asc" },
    });
    return products.map((product) => this.serializeProduct(product));
  }

  /** Used by bot-service (see apps/bot-service): embeds the query and returns
   * the closest products across the bot's linked knowledge bases. */
  async search(businessId: string, knowledgeBaseIds: string[], query: string) {
    if (knowledgeBaseIds.length === 0 || !query.trim()) return [];

    const vector = toPgVector(await embed(query));
    const rows = await prisma.$queryRaw<ProductRow[]>`
      SELECT id, "businessId", "knowledgeBaseId", "externalId", title, description, price, currency, "imageUrl", "productUrl", "createdAt"
      FROM "Product"
      WHERE "businessId" = ${businessId}
        AND "knowledgeBaseId" = ANY(${knowledgeBaseIds})
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vector}::vector
      LIMIT ${SEARCH_LIMIT}
    `;
    return rows.map((row) => this.serializeProduct(row));
  }

  /** Products cascade via the schema's onDelete. Bot.knowledgeBaseIds is a plain
   * String[] with no FK, so stale ids would linger there — strip them in the same
   * transaction rather than leaving bots pointing at a knowledge base that's gone. */
  async remove(businessId: string, id: string) {
    await this.require(businessId, id);
    await prisma.$transaction([
      prisma.$executeRaw`
        UPDATE "Bot"
        SET "knowledgeBaseIds" = array_remove("knowledgeBaseIds", ${id})
        WHERE "businessId" = ${businessId} AND ${id} = ANY("knowledgeBaseIds")
      `,
      prisma.knowledgeBase.delete({ where: { id } }),
    ]);
  }

  private async require(businessId: string, id: string): Promise<KnowledgeBaseRow> {
    const knowledgeBase = await prisma.knowledgeBase.findUnique({ where: { id } });
    if (!knowledgeBase || knowledgeBase.businessId !== businessId) {
      throw new NotFoundException("Knowledge base not found");
    }
    return knowledgeBase;
  }

  private serialize(kb: KnowledgeBaseRow) {
    return {
      id: kb.id,
      businessId: kb.businessId,
      name: kb.name,
      sourceType: kb.sourceType,
      sourceUrl: kb.sourceUrl ?? undefined,
      status: kb.status,
      errorMessage: kb.errorMessage ?? undefined,
      productCount: kb.productCount,
      syncedAt: kb.syncedAt?.toISOString(),
      createdAt: kb.createdAt.toISOString(),
    };
  }

  private serializeProduct(product: ProductRow) {
    return {
      id: product.id,
      businessId: product.businessId,
      knowledgeBaseId: product.knowledgeBaseId,
      externalId: product.externalId ?? undefined,
      title: product.title,
      description: product.description ?? undefined,
      price: product.price ?? undefined,
      currency: product.currency ?? undefined,
      imageUrl: product.imageUrl ?? undefined,
      productUrl: product.productUrl,
      createdAt: product.createdAt.toISOString(),
    };
  }
}
