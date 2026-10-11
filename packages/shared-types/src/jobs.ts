// Contract between knowledge-service (producer) and worker (consumer) for
// the BullMQ queue that runs store ingestion off the request path.
export const INGEST_KNOWLEDGE_BASE_QUEUE = "ingest-knowledge-base";

export interface IngestKnowledgeBaseJob {
  knowledgeBaseId: string;
}
