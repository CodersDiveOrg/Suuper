import { Worker } from "bullmq";
import IORedis from "ioredis";
import { loadServiceConfig } from "@platform/shared-config";
import { INGEST_KNOWLEDGE_BASE_QUEUE, type IngestKnowledgeBaseJob } from "@platform/shared-types";
import { processKnowledgeBase } from "./ingestion/process-knowledge-base";

// Background job runner: document ingestion, embedding generation, MCP
// server provisioning. Currently consumes the knowledge-base ingestion queue
// that knowledge-service produces onto (see docs/ARCHITECTURE.md).
async function main() {
  const config = loadServiceConfig("worker");
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<IngestKnowledgeBaseJob>(
    INGEST_KNOWLEDGE_BASE_QUEUE,
    async (job) => {
      console.log(`[worker] processing job ${job.id} (knowledgeBaseId=${job.data.knowledgeBaseId})`);
      await processKnowledgeBase(job.data.knowledgeBaseId);
    },
    { connection },
  );

  worker.on("failed", (job, error) => {
    console.error(`[worker] job ${job?.id} failed:`, error);
  });

  console.log(
    `[worker] started, consuming "${INGEST_KNOWLEDGE_BASE_QUEUE}" (db=${config.databaseUrl.split("@")[1] ?? "local"})`,
  );

  process.on("SIGTERM", async () => {
    console.log("[worker] shutting down");
    await worker.close();
    process.exit(0);
  });
}

main();
