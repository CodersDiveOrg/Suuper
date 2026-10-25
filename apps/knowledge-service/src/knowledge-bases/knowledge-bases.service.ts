import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { knowledgeStorageBytes, prisma } from "@platform/database";
import { embed, toPgVector } from "@platform/shared-ai";
import { assertPublicUrl } from "@platform/shared-auth";
import { loadServiceConfig } from "@platform/shared-config";
import {
  INGEST_KNOWLEDGE_BASE_QUEUE,
  isKnowledgeAutoSync,
  nextAutoSync,
  planFor,
  quotaExceededBody,
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
  autoSync: string | null;
  nextSyncAt: Date | null;
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
  autoSync: string | null;
  nextSyncAt: Date | null;
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
  score: number;
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
  autoSync: true,
  nextSyncAt: true,
  createdAt: true,
  processedAt: true,
} as const;

// Workspace-wide document list and the document detail view.
const MAX_LISTED_DOCUMENTS = 1000;
const MAX_PREVIEW_CHARS = 50_000;
const MAX_PREVIEW_CHUNKS = 100;

export interface DocumentFilters {
  knowledgeBaseId?: string;
  type?: string;
  status?: string;
  q?: string;
}

export interface DocumentUpdate {
  title?: unknown;
  text?: unknown;
  items?: unknown;
  autoSync?: unknown;
}

export interface KnowledgeBaseUpdate {
  name?: unknown;
  autoSync?: unknown;
}

@Injectable()
export class KnowledgeBasesService {
  /** Creates the KnowledgeBase row and drops the scrape job onto the queue — worker does the
   * actual fetch/embed/save off the request path (see docs/ARCHITECTURE.md worker section). */
  async create(businessId: string, name: string, sourceType: string, sourceUrl: string, autoSync?: unknown) {
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
    await this.assertStorageAvailable(businessId);

    const knowledgeBase = await prisma.knowledgeBase.create({
      data: {
        businessId,
        name: name.trim(),
        sourceType: "crawl",
        sourceUrl: sourceUrl.trim(),
        status: "syncing",
        autoSync: autoSync === undefined ? null : this.autoSyncValue(autoSync),
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
    await this.assertStorageAvailable(businessId);
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
    if (document.status === "processing") throw new BadRequestException("This source is already being processed");
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
        SELECT id, "knowledgeBaseId", "documentId", title, content, "sourceUrl",
          (1 - (embedding <=> ${vector}::vector))::float8 AS score
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
        score: Math.max(0, Math.min(1, Number(row.score))),
      })),
    };
  }

  /** Every document in the business, newest first, with its knowledge base's name. */
  async listAllDocuments(businessId: string, filters: DocumentFilters) {
    const q = filters.q?.trim();
    const documents = await prisma.knowledgeDocument.findMany({
      where: {
        businessId,
        ...(filters.knowledgeBaseId ? { knowledgeBaseId: filters.knowledgeBaseId } : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: "insensitive" as const } },
                { fileName: { contains: q, mode: "insensitive" as const } },
                { sourceUrl: { contains: q, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: MAX_LISTED_DOCUMENTS,
      select: { ...DOCUMENT_SELECT, knowledgeBase: { select: { name: true } } },
    });
    return documents.map((d) => ({ ...this.serializeDocument(d), knowledgeBaseName: d.knowledgeBase.name }));
  }

  /** One document with what it was turned into: its text (or FAQ entries) and its passages. */
  async getDocument(businessId: string, id: string, documentId: string) {
    const knowledgeBase = await this.require(businessId, id);
    await this.requireDocument(id, documentId);
    const document = await prisma.knowledgeDocument.findUniqueOrThrow({
      where: { id: documentId },
      select: { ...DOCUMENT_SELECT, text: true, faqItems: true },
    });
    const [chunks, chunkTotal] = await Promise.all([
      prisma.knowledgeChunk.findMany({
        where: { documentId },
        orderBy: { position: "asc" },
        take: MAX_PREVIEW_CHUNKS,
        select: { id: true, position: true, title: true, content: true, sourceUrl: true },
      }),
      prisma.knowledgeChunk.count({ where: { documentId } }),
    ]);
    const text = document.text ?? "";
    return {
      ...this.serializeDocument(document),
      knowledgeBaseName: knowledgeBase.name,
      text: text.slice(0, MAX_PREVIEW_CHARS),
      textLength: text.length,
      faqItems: (document.faqItems as FaqItem[] | null) ?? undefined,
      chunks: chunks.map((c) => ({ ...c, sourceUrl: c.sourceUrl ?? undefined })),
      chunkTotal,
    };
  }

  /**
   * Rename any document; change a text's body or an FAQ's entries (re-indexed);
   * turn a website's auto-sync on or off.
   */
  async updateDocument(businessId: string, id: string, documentId: string, body: DocumentUpdate) {
    await this.require(businessId, id);
    const document = await this.requireDocument(id, documentId);
    const data: Record<string, unknown> = {};
    let reindex = false;

    if (body.title !== undefined) {
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
      if (!title) throw new BadRequestException("title can't be empty");
      data.title = title;
    }
    if (body.text !== undefined) {
      if (document.type !== "text") throw new BadRequestException("Only text documents can be edited this way");
      data.text = (await this.documentData({ type: "text", title: "x", text: body.text })).text;
      reindex = true;
    }
    if (body.items !== undefined) {
      if (document.type !== "faq") throw new BadRequestException("Only FAQs have entries");
      data.faqItems = (await this.documentData({ type: "faq", items: body.items })).faqItems;
      reindex = true;
    }
    if (body.autoSync !== undefined) {
      if (document.type !== "website") throw new BadRequestException("Only websites can sync automatically");
      const autoSync = this.autoSyncValue(body.autoSync);
      data.autoSync = autoSync;
      data.nextSyncAt = nextAutoSync(autoSync, document.processedAt ?? new Date());
    }
    if (reindex) {
      if (document.status === "processing") throw new BadRequestException("Wait for the current processing to finish");
      Object.assign(data, { status: "processing", errorMessage: null });
    }

    const updated = await prisma.knowledgeDocument.update({ where: { id: documentId }, data, select: DOCUMENT_SELECT });
    // Text and file passages carry the document's title (FAQ passages use the question, websites the page title).
    if (data.title && !reindex && (document.type === "text" || document.type === "file")) {
      await prisma.knowledgeChunk.updateMany({ where: { documentId }, data: { title: data.title as string } });
    }
    if (reindex) {
      await prisma.knowledgeBase.update({ where: { id }, data: { status: "syncing" } });
      await ingestQueue.add("ingest", { knowledgeBaseId: id, documentId });
    }
    return this.serializeDocument(updated);
  }

  async update(businessId: string, id: string, body: KnowledgeBaseUpdate) {
    const knowledgeBase = await this.require(businessId, id);
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
      if (!name) throw new BadRequestException("name can't be empty");
      data.name = name;
    }
    if (body.autoSync !== undefined) {
      if (knowledgeBase.sourceType !== "crawl") throw new BadRequestException("Only store catalogs sync automatically");
      const autoSync = this.autoSyncValue(body.autoSync);
      data.autoSync = autoSync;
      data.nextSyncAt = nextAutoSync(autoSync, knowledgeBase.syncedAt ?? new Date());
    }
    await prisma.knowledgeBase.update({ where: { id }, data });
    return this.get(businessId, id);
  }

  /** Re-scrapes a store catalog now. The current products stay searchable until the new ones replace them. */
  async sync(businessId: string, id: string) {
    const knowledgeBase = await this.require(businessId, id);
    if (knowledgeBase.sourceType !== "crawl") {
      throw new BadRequestException("Only store catalogs sync as a whole; re-sync a website from its document");
    }
    if (knowledgeBase.status === "syncing") throw new BadRequestException("This store is already syncing");
    await prisma.knowledgeBase.update({ where: { id }, data: { status: "syncing" } });
    await ingestQueue.add("ingest", { knowledgeBaseId: id });
    return this.get(businessId, id);
  }

  /** Everything fetched from outside and kept up to date: store catalogs and websites. */
  async listSources(businessId: string) {
    const [stores, websites] = await Promise.all([
      prisma.knowledgeBase.findMany({ where: { businessId, sourceType: "crawl" }, orderBy: { createdAt: "desc" } }),
      prisma.knowledgeDocument.findMany({
        where: { businessId, type: "website" },
        orderBy: { createdAt: "desc" },
        select: { ...DOCUMENT_SELECT, knowledgeBase: { select: { name: true } } },
      }),
    ]);
    const sources = [
      ...stores.map((kb) => ({
        id: kb.id,
        kind: "store" as const,
        title: kb.name,
        url: kb.sourceUrl ?? "",
        knowledgeBaseId: kb.id,
        knowledgeBaseName: kb.name,
        status: kb.status,
        errorMessage: kb.errorMessage ?? undefined,
        itemCount: kb.productCount,
        lastSyncedAt: kb.syncedAt?.toISOString(),
        autoSync: kb.autoSync,
        nextSyncAt: kb.nextSyncAt?.toISOString(),
        createdAt: kb.createdAt.toISOString(),
      })),
      ...websites.map((d) => ({
        id: d.id,
        kind: "website" as const,
        title: d.title,
        url: d.sourceUrl ?? "",
        knowledgeBaseId: d.knowledgeBaseId,
        knowledgeBaseName: d.knowledgeBase.name,
        status: d.status === "processing" ? "syncing" : d.status,
        errorMessage: d.errorMessage ?? undefined,
        itemCount: d.chunkCount,
        lastSyncedAt: d.status === "ready" || d.chunkCount > 0 ? d.processedAt?.toISOString() : undefined,
        autoSync: d.autoSync,
        nextSyncAt: d.nextSyncAt?.toISOString(),
        createdAt: d.createdAt.toISOString(),
      })),
    ];
    return sources.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
        // nextSyncAt is set by the worker once the first crawl finishes.
        const autoSync = body.autoSync === undefined ? null : this.autoSyncValue(body.autoSync);
        return { type: "website", title, sourceUrl: url.toString(), autoSync };
      }
      default:
        throw new BadRequestException('type must be one of "file", "faq", "text", "website"');
    }
  }

  /** New sources are refused once the plan's knowledge storage is used up (re-syncs still run). */
  private async assertStorageAvailable(businessId: string) {
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { plan: true } });
    const plan = planFor(business?.plan);
    if ((await knowledgeStorageBytes(businessId)) >= plan.limits.knowledge_storage) {
      throw new HttpException(quotaExceededBody("knowledge_storage", plan), HttpStatus.PAYMENT_REQUIRED);
    }
  }

  private autoSyncValue(value: unknown): string | null {
    if (value === null || value === "off") return null;
    if (!isKnowledgeAutoSync(value)) throw new BadRequestException('autoSync must be "daily", "weekly" or null');
    return value;
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
      autoSync: kb.autoSync,
      nextSyncAt: kb.nextSyncAt?.toISOString(),
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
      autoSync: document.autoSync,
      nextSyncAt: document.nextSyncAt?.toISOString(),
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
