// Contract between knowledge-service (producer) and worker (consumer) for
// the BullMQ queue that runs store and document ingestion off the request path.
export const INGEST_KNOWLEDGE_BASE_QUEUE = "ingest-knowledge-base";

export interface IngestKnowledgeBaseJob {
  knowledgeBaseId: string;
  /** Set for a document added to a "documents" knowledge base; unset means re-scrape the store. */
  documentId?: string;
}
