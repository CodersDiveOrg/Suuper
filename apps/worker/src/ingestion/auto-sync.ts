import type { Queue } from "bullmq";
import { prisma } from "@platform/database";
import { nextAutoSync, type IngestKnowledgeBaseJob } from "@platform/shared-types";

/**
 * Queues every store catalog and website whose auto-sync is due. nextSyncAt is
 * moved forward right away so a slow sync isn't queued twice; the sync itself
 * sets it again from when it finished.
 */
export async function queueDueSyncs(queue: Queue<IngestKnowledgeBaseJob>): Promise<void> {
  const now = new Date();
  const stores = await prisma.knowledgeBase.findMany({
    where: { sourceType: "crawl", autoSync: { not: null }, nextSyncAt: { lte: now }, status: { not: "syncing" } },
    select: { id: true, autoSync: true },
  });
  for (const store of stores) {
    await prisma.knowledgeBase.update({
      where: { id: store.id },
      data: { status: "syncing", nextSyncAt: nextAutoSync(store.autoSync, now) },
    });
    await queue.add("ingest", { knowledgeBaseId: store.id });
  }

  const websites = await prisma.knowledgeDocument.findMany({
    where: { type: "website", autoSync: { not: null }, nextSyncAt: { lte: now }, status: { not: "processing" } },
    select: { id: true, knowledgeBaseId: true, autoSync: true },
  });
  for (const site of websites) {
    await prisma.knowledgeDocument.update({
      where: { id: site.id },
      data: { status: "processing", errorMessage: null, nextSyncAt: nextAutoSync(site.autoSync, now) },
    });
    await prisma.knowledgeBase.update({ where: { id: site.knowledgeBaseId }, data: { status: "syncing" } });
    await queue.add("ingest", { knowledgeBaseId: site.knowledgeBaseId, documentId: site.id });
  }

  if (stores.length + websites.length > 0) {
    console.log(`[worker] auto-sync: queued ${stores.length} store(s) and ${websites.length} website(s)`);
  }
}
