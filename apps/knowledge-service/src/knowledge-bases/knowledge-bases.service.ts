import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "@platform/database";
import { embed, toPgVector } from "@platform/shared-ai";
import { assertPublicUrl } from "@platform/shared-auth";
import { loadServiceConfig } from "@platform/shared-config";
import {
  INGEST_KNOWLEDGE_BASE_QUEUE,
  type AddKnowledgeDocumentRequest,
  type FaqItem,
  type IngestKnowledgeBaseJob,
  type KnowledgeSearchResult,
} from "@platform/shared-types";

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
  _count?: { documents: number };
}

interface DocumentRow {
  id: string;
  knowledgeBaseId: string;
  type: string;
  title: string;
  sourceUrl: string | null;
  fileName: string | null;
  status: string;
  errorMessage: string | null;
  chunkCount: number;
  createdAt: Date;
  processedAt: Date | null;
}

interface PassageRow {
  id: string;
  knowledgeBaseId: string;
  documentId: string;
  title: string;
  content: string;
  sourceUrl: string | null;
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
const PASSAGE_LIMIT = 5;

// Upload limits. Files travel base64 in JSON, and nginx caps bodies at 10 MB.
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};
const MAX_TEXT_CHARS = 200_000;
const MAX_FAQ_ITEMS = 500;
const MAX_DOCUMENTS_PER_KB = 200;

// Leave out the raw file bytes and extracted text when listing documents.
const DOCUMENT_SELECT = {
  id: true,
  knowledgeBaseId: true,
  type: true,
  title: true,
  sourceUrl: true,
  fileName: true,
  status: true,
  errorMessage: true,
  chunkCount: true,
  createdAt: true,
  processedAt: true,
} as const;

@Injectable()
export class KnowledgeBasesService {
  /** Creates the KnowledgeBase row and drops the scrape job onto the queue — worker does the
   * actual fetch/embed/save off the request path (see docs/ARCHITECTURE.md worker section). */
  async create(businessId: string, name: string, sourceType: string, sourceUrl: string) {
    if (!name.trim()) throw new BadRequestException("name is required");
    if (sourceType === "documents") {
      // Starts empty; sources are added through addDocument.
      const knowledgeBase = await prisma.knowledgeBase.create({
        data: { businessId, name: name.trim(), sourceType: "documents", status: "ready" },
      });
      return this.serialize(knowledgeBase);
    }
    if (sourceType !== "crawl") throw new BadRequestException('sourceType must be "crawl" or "documents"');
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
      include: { _count: { select: { documents: true } } },
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

  async listDocuments(businessId: string, id: string) {
    await this.require(businessId, id);
    const documents = await prisma.knowledgeDocument.findMany({
      where: { knowledgeBaseId: id },
      orderBy: { createdAt: "desc" },
      select: DOCUMENT_SELECT,
    });
    return documents.map((document) => this.serializeDocument(document));
  }

  /** Validates and stores the source, then queues it for the worker to extract,
   * chunk and embed. Only for "documents" knowledge bases. */
  async addDocument(businessId: string, id: string, body: Partial<AddKnowledgeDocumentRequest> & Record<string, unknown>) {
    const knowledgeBase = await this.require(businessId, id);
    if (knowledgeBase.sourceType !== "documents") {
      throw new BadRequestException("Documents can only be added to a documents knowledge base");
    }
    const count = await prisma.knowledgeDocument.count({ where: { knowledgeBaseId: id } });
    if (count >= MAX_DOCUMENTS_PER_KB) {
      throw new BadRequestException(`A knowledge base can hold at most ${MAX_DOCUMENTS_PER_KB} documents`);
    }

    const data = await this.documentData(body);
    const document = await prisma.knowledgeDocument.create({
      data: { ...data, businessId, knowledgeBaseId: id, status: "processing" },
      select: DOCUMENT_SELECT,
    });
    await prisma.knowledgeBase.update({ where: { id }, data: { status: "syncing" } });
    await ingestQueue.add("ingest", { knowledgeBaseId: id, documentId: document.id });
    return this.serializeDocument(document);
  }

  /** Re-runs extraction for one document, e.g. to pick up changes on a website. */
  async reprocessDocument(businessId: string, id: string, documentId: string) {
    await this.require(businessId, id);
    const document = await this.requireDocument(id, documentId);
    if (document.type === "file" && document.status === "ready") {
      // The file bytes are dropped once extracted; re-chunking the kept text is all a re-run could do.
      throw new BadRequestException("Upload the file again to replace it");
    }
    const updated = await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: "processing", errorMessage: null },
      select: DOCUMENT_SELECT,
    });
    await prisma.knowledgeBase.update({ where: { id }, data: { status: "syncing" } });
    await ingestQueue.add("ingest", { knowledgeBaseId: id, documentId });
    return this.serializeDocument(updated);
  }

  async removeDocument(businessId: string, id: string, documentId: string) {
    await this.require(businessId, id);
    await this.requireDocument(id, documentId);
    await prisma.knowledgeDocument.delete({ where: { id: documentId } });
  }

  /** Used by bot-service (see apps/bot-service): embeds the query once and returns
   * the closest products and document passages across the linked knowledge bases. */
  async search(businessId: string, knowledgeBaseIds: string[], query: string): Promise<KnowledgeSearchResult> {
    if (knowledgeBaseIds.length === 0 || !query.trim()) return { products: [], passages: [] };

    const vector = toPgVector(await embed(query));
    const [products, passages] = await Promise.all([
      prisma.$queryRaw<ProductRow[]>`
        SELECT id, "businessId", "knowledgeBaseId", "externalId", title, description, price, currency, "imageUrl", "productUrl", "createdAt"
        FROM "Product"
        WHERE "businessId" = ${businessId}
          AND "knowledgeBaseId" = ANY(${knowledgeBaseIds})
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vector}::vector
        LIMIT ${SEARCH_LIMIT}
      `,
      prisma.$queryRaw<PassageRow[]>`
        SELECT id, "knowledgeBaseId", "documentId", title, content, "sourceUrl"
        FROM "KnowledgeChunk"
        WHERE "businessId" = ${businessId}
          AND "knowledgeBaseId" = ANY(${knowledgeBaseIds})
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vector}::vector
        LIMIT ${PASSAGE_LIMIT}
      `,
    ]);
    return {
      products: products.map((row) => this.serializeProduct(row)),
      passages: passages.map((row) => ({
        id: row.id,
        knowledgeBaseId: row.knowledgeBaseId,
        documentId: row.documentId,
        title: row.title,
        content: row.content,
        sourceUrl: row.sourceUrl ?? undefined,
      })),
    };
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

  private async documentData(body: Record<string, unknown>) {
    switch (body.type) {
      case "file": {
        const fileName = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 255) : "";
        const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
        if (!fileName || !FILE_TYPES[extension]) {
          throw new BadRequestException(`Supported files: ${Object.keys(FILE_TYPES).map((e) => `.${e}`).join(", ")}`);
        }
        if (typeof body.dataBase64 !== "string" || !body.dataBase64) {
          throw new BadRequestException("dataBase64 is required");
        }
        const fileData = Buffer.from(body.dataBase64, "base64");
        if (fileData.length === 0) throw new BadRequestException("The file is empty");
        if (fileData.length > MAX_FILE_BYTES) {
          throw new BadRequestException(`Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        }
        return { type: "file", title: fileName, fileName, mimeType: FILE_TYPES[extension], fileData };
      }
      case "faq": {
        if (!Array.isArray(body.items) || body.items.length === 0) {
          throw new BadRequestException("Add at least one question and answer");
        }
        if (body.items.length > MAX_FAQ_ITEMS) {
          throw new BadRequestException(`An FAQ can have at most ${MAX_FAQ_ITEMS} entries`);
        }
        const items: FaqItem[] = body.items.map((item: unknown, i: number) => {
          const { question, answer } = (item ?? {}) as Record<string, unknown>;
          if (typeof question !== "string" || !question.trim() || typeof answer !== "string" || !answer.trim()) {
            throw new BadRequestException(`Entry ${i + 1} needs both a question and an answer`);
          }
          if (question.length > 500 || answer.length > 5000) {
            throw new BadRequestException(`Entry ${i + 1} is too long (500 characters per question, 5000 per answer)`);
          }
          return { question: question.trim(), answer: answer.trim() };
        });
        const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "FAQ";
        return { type: "faq", title, faqItems: items as unknown as object };
      }
      case "text": {
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!title) throw new BadRequestException("title is required");
        if (!text) throw new BadRequestException("text is required");
        if (text.length > MAX_TEXT_CHARS) {
          throw new BadRequestException(`Text can be at most ${MAX_TEXT_CHARS.toLocaleString("en-US")} characters`);
        }
        return { type: "text", title, text };
      }
      case "website": {
        const raw = typeof body.url === "string" ? body.url.trim() : "";
        if (!raw) throw new BadRequestException("url is required");
        let url: URL;
        try {
          url = await assertPublicUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`, {
            allowPrivate: config.mcpAllowPrivateUrls,
          });
        } catch (error) {
          throw new BadRequestException(`url: ${(error as Error).message}`);
        }
        const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : url.hostname;
        return { type: "website", title, sourceUrl: url.toString() };
      }
      default:
        throw new BadRequestException('type must be one of "file", "faq", "text", "website"');
    }
  }

  private async requireDocument(knowledgeBaseId: string, documentId: string) {
    const document = await prisma.knowledgeDocument.findUnique({ where: { id: documentId }, select: DOCUMENT_SELECT });
    if (!document || document.knowledgeBaseId !== knowledgeBaseId) {
      throw new NotFoundException("Document not found");
    }
    return document;
  }

  private async require(businessId: string, id: string): Promise<KnowledgeBaseRow> {
    const knowledgeBase = await prisma.knowledgeBase.findUnique({
      where: { id },
      include: { _count: { select: { documents: true } } },
    });
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
      documentCount: kb._count?.documents ?? 0,
      syncedAt: kb.syncedAt?.toISOString(),
      createdAt: kb.createdAt.toISOString(),
    };
  }

  private serializeDocument(document: DocumentRow) {
    return {
      id: document.id,
      knowledgeBaseId: document.knowledgeBaseId,
      type: document.type,
      title: document.title,
      sourceUrl: document.sourceUrl ?? undefined,
      fileName: document.fileName ?? undefined,
      status: document.status,
      errorMessage: document.errorMessage ?? undefined,
      chunkCount: document.chunkCount,
      createdAt: document.createdAt.toISOString(),
      processedAt: document.processedAt?.toISOString(),
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
