import { loadServiceConfig } from "@platform/shared-config";

// Background job runner: document ingestion, embedding generation, MCP
// server provisioning. Queue consumer (SQS/BullMQ) plugs in here once the
// ingestion pipeline is built; this loop is the placeholder host process.
async function main() {
  const config = loadServiceConfig("worker");
  console.log(`[worker] started (db=${config.databaseUrl.split("@")[1] ?? "local"})`);

  process.on("SIGTERM", () => {
    console.log("[worker] shutting down");
    process.exit(0);
  });
}

main();
