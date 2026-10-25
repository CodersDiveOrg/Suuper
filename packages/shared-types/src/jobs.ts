// Contract between knowledge-service (producer) and worker (consumer) for
// the BullMQ queue that runs store and document ingestion off the request path.
export const INGEST_KNOWLEDGE_BASE_QUEUE = "ingest-knowledge-base";

export interface IngestKnowledgeBaseJob {
  knowledgeBaseId: string;
  /** Set for a document added to a "documents" knowledge base; unset means re-scrape the store. */
  documentId?: string;
}

/** Name of the repeating job (no data) that queues store catalogs and websites whose auto-sync is due. */
export const KNOWLEDGE_AUTO_SYNC_JOB = "auto-sync";

export type KnowledgeAutoSync = "daily" | "weekly";

export const AUTO_SYNC_INTERVAL_MS: Record<KnowledgeAutoSync, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export function isKnowledgeAutoSync(value: unknown): value is KnowledgeAutoSync {
  return value === "daily" || value === "weekly";
}

/** When an auto-synced source is next due, counted from `from` (usually the last sync). */
export function nextAutoSync(autoSync: string | null | undefined, from = new Date()): Date | null {
  return isKnowledgeAutoSync(autoSync) ? new Date(from.getTime() + AUTO_SYNC_INTERVAL_MS[autoSync]) : null;
}
