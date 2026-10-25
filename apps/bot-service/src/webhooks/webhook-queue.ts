import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "@platform/database";
import { loadServiceConfig } from "@platform/shared-config";
import { WEBHOOK_DELIVERY_QUEUE, type WebhookDeliveryJob } from "@platform/shared-types";
import { attemptDelivery, closeDeliveryQueue, DELIVERY_ATTEMPTS, deliveryQueue, type WebhookQueueJob } from "./delivery";

const config = loadServiceConfig("bot-service", 3002);
// Deliveries mostly wait on the network, so a few run at once.
const CONCURRENCY = 4;
const RETENTION_DAYS = 30;
const CLEANUP_SCHEDULER = "webhook-deliveries-cleanup";

/** Runs queued deliveries (BullMQ retries failures with backoff) and prunes old delivery logs daily. */
@Injectable()
export class WebhookQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookQueue.name);
  private readonly connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  private worker?: Worker<WebhookQueueJob>;

  async onModuleInit() {
    this.worker = new Worker(WEBHOOK_DELIVERY_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      concurrency: CONCURRENCY,
    });
    // A failed attempt throws so BullMQ schedules the retry; that's expected, not worth a log line.
    this.worker.on("error", (error) => this.logger.error(`Worker error: ${error.message}`));
    await deliveryQueue().upsertJobScheduler(CLEANUP_SCHEDULER, { pattern: "15 3 * * *" }, { name: "cleanup", data: {} });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await closeDeliveryQueue();
    await this.connection.quit();
  }

  private async process(job: Job<WebhookQueueJob>) {
    if (job.name === "cleanup") {
      const { count } = await prisma.webhookDelivery.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - RETENTION_DAYS * 86_400_000) } },
      });
      if (count > 0) this.logger.log(`Removed ${count} webhook deliveries older than ${RETENTION_DAYS} days`);
      return;
    }
    const { deliveryId } = job.data as WebhookDeliveryJob;
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? DELIVERY_ATTEMPTS);
    const ok = await attemptDelivery(deliveryId, { final });
    if (!ok && !final) throw new Error("Delivery failed; will retry");
  }
}
