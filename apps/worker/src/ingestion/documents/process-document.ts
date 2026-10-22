import { randomUUID } from "node:crypto";
import { prisma } from "@platform/database";
import { embedBatch, toPgVector } from "@platform/shared-ai";
import { loadServiceConfig } from "@platform/shared-config";
import type { FaqItem } from "@platform/shared-types";
import { chunkText } from "./chunk";
import { crawlWebsite } from "./crawl-website";
import { extractFileText } from "./extract-file";

// Embedding runs on the shared CPU, so one document can't queue unbounded work.
const MAX_CHUNKS_PER_DOCUMENT = 400;
// Extracted text kept on the document, for re-chunking and debugging.
const MAX_STORED_TEXT_CHARS = 500_000;

const config = loadServiceConfig("worker");

interface Passage {
  title: string;
  content: string;
  sourceUrl?: string;
}

/** One document job: extract -> chunk -> embed -> replace the document's chunks,
 * then refresh the knowledge base's status. */
export async function processDocument(knowledgeBaseId: string, documentId: string): Promise<void> {
  const document = await prisma.knowledgeDocument.findUnique({ where: { id: documentId } });
  if (!document) {
    console.warn(`[worker] document ${documentId} no longer exists, skipping`);
    await refreshKnowledgeBaseStatus(knowledgeBaseId);
    return;
  }

  try {
    const { passages, text } = await extractPassages(document);
    if (passages.length === 0) throw new Error("No readable text was found.");
    const kept = passages.slice(0, MAX_CHUNKS_PER_DOCUMENT);

    console.log(`[worker] document ${documentId}: ${kept.length} passages, embedding...`);
    const embeddings = await embedBatch(kept.map((p) => `${p.title}\n\n${p.content}`));

    await prisma.$transaction(
      async (tx) => {
        await tx.knowledgeChunk.deleteMany({ where: { documentId } });
        for (let i = 0; i < kept.length; i++) {
          const passage = kept[i];
          await tx.$executeRaw`
            INSERT INTO "KnowledgeChunk"
              (id, "businessId", "knowledgeBaseId", "documentId", position, content, title, "sourceUrl", embedding)
            VALUES (
              ${randomUUID()}, ${document.businessId}, ${knowledgeBaseId}, ${documentId}, ${i},
              ${passage.content}, ${passage.title}, ${passage.sourceUrl ?? null}, ${toPgVector(embeddings[i])}::vector
            )
          `;
        }
        await tx.knowledgeDocument.update({
          where: { id: documentId },
          data: {
            status: "ready",
            errorMessage: passages.length > kept.length ? `Only the first ${kept.length} passages were kept.` : null,
            chunkCount: kept.length,
            processedAt: new Date(),
            fileData: null,
            ...(text !== undefined ? { text: text.slice(0, MAX_STORED_TEXT_CHARS) } : {}),
          },
        });
      },
      { timeout: 60_000 },
    );
    console.log(`[worker] document ${documentId}: ready (${kept.length} passages)`);
  } catch (error) {
    const message = (error as Error).message || "Processing failed.";
    console.warn(`[worker] document ${documentId}: ${message}`);
    await prisma.knowledgeDocument
      .update({ where: { id: documentId }, data: { status: "error", errorMessage: message, processedAt: new Date() } })
      .catch(() => undefined); // deleted mid-run
  }

  await refreshKnowledgeBaseStatus(knowledgeBaseId);
}

/** Passages for each document type, plus the extracted text to store (file and website only). */
async function extractPassages(document: {
  type: string;
  title: string;
  fileName: string | null;
  fileData: Uint8Array | null;
  text: string | null;
  faqItems: unknown;
  sourceUrl: string | null;
}): Promise<{ passages: Passage[]; text?: string }> {
  switch (document.type) {
    case "faq": {
      const items = (document.faqItems ?? []) as FaqItem[];
      return {
        passages: items.map((item) => ({ title: item.question, content: `Q: ${item.question}\nA: ${item.answer}` })),
      };
    }
    case "text":
      return { passages: toPassages(document.title, document.text ?? "") };
    case "file": {
      // A re-run after the bytes were dropped re-chunks the stored text.
      const text = document.fileData
        ? await extractFileText(document.fileName ?? document.title, Buffer.from(document.fileData))
        : document.text ?? "";
      return { passages: toPassages(document.title, text), text };
    }
    case "website": {
      if (!document.sourceUrl) throw new Error("No website URL was provided.");
      const pages = await crawlWebsite(document.sourceUrl, config.mcpAllowPrivateUrls);
      if (pages.length === 0) throw new Error("Could not read any pages at that URL.");
      return {
        passages: pages.flatMap((page) => toPassages(page.title, page.text, page.url)),
        text: pages.map((page) => `# ${page.title}\n${page.url}\n\n${page.text}`).join("\n\n"),
      };
    }
    default:
      throw new Error(`Unknown document type "${document.type}".`);
  }
}

function toPassages(title: string, text: string, sourceUrl?: string): Passage[] {
  return chunkText(text).map((content) => ({ title, content, sourceUrl }));
}

/** "syncing" while any document is still processing, otherwise "ready". Per-document
 * errors stay on the documents; the knowledge base itself keeps working. */
async function refreshKnowledgeBaseStatus(knowledgeBaseId: string): Promise<void> {
  const processing = await prisma.knowledgeDocument.count({ where: { knowledgeBaseId, status: "processing" } });
  await prisma.knowledgeBase
    .update({
      where: { id: knowledgeBaseId },
      data: processing > 0 ? { status: "syncing" } : { status: "ready", syncedAt: new Date(), errorMessage: null },
    })
    .catch(() => undefined); // knowledge base deleted mid-run
}
