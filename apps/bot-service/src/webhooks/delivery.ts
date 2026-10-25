import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import axios from "axios";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "@platform/database";
import { assertPublicUrl, decryptJson, encryptJson, guardedHttpAgent, guardedHttpsAgent } from "@platform/shared-auth";
import { loadServiceConfig } from "@platform/shared-config";
import { WEBHOOK_DELIVERY_QUEUE, type WebhookDeliveryJob, type WebhookEventPayload } from "@platform/shared-types";

const config = loadServiceConfig("bot-service", 3002);
const logger = new Logger("Webhooks");

// 6 tries: now, then after 1, 2, 4, 8 and 16 minutes.
export const DELIVERY_ATTEMPTS = 6;
export const RETRY_BASE_MS = 60_000;
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 2000;
// Endpoints whose deliveries keep failing every retry are turned off.
export const DISABLE_AFTER_FAILURES = 15;

/** Deliveries, plus the daily cleanup job (empty data). */
export type WebhookQueueJob = WebhookDeliveryJob | Record<string, never>;

let queue: Queue<WebhookQueueJob> | undefined;

/** Shared by event emitters and WebhookQueue (which runs the worker). */
export function deliveryQueue(): Queue<WebhookQueueJob> {
  queue ??= new Queue<WebhookQueueJob>(WEBHOOK_DELIVERY_QUEUE, {
    connection: new IORedis(config.redisUrl, { maxRetriesPerRequest: null }),
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000 },
  });
  return queue;
}

export async function closeDeliveryQueue() {
  await queue?.close();
  queue = undefined;
}

/** "whsec_" + base64 key, the Standard Webhooks secret format. */
export function newSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

export const sealSecret = (secret: string) => encryptJson({ secret });
export const openSecret = (sealed: string) => decryptJson<{ secret: string }>(sealed).secret;

export function newEventId() {
  return `evt_${randomUUID().replace(/-/g, "")}`;
}

/** Standard Webhooks: base64 HMAC-SHA256 of "<id>.<timestamp>.<body>", keyed with the decoded secret. */
export function sign(secret: string, id: string, timestamp: number, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/**
 * Events emitted from bot-service code paths (records, chats, runs). Never
 * throws or waits on delivery: each subscribed endpoint gets a delivery row and
 * a queued job. Pass `data` as a function when building it costs queries; it
 * only runs when some endpoint wants the event.
 */
export function emitWebhookEvent(
  businessId: string,
  type: string,
  data: Record<string, unknown> | (() => Promise<Record<string, unknown>>),
) {
  void (async () => {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { businessId, enabled: true, events: { has: type } },
      select: { id: true },
    });
    if (endpoints.length === 0) return;
    const payload: WebhookEventPayload = {
      id: newEventId(),
      type,
      createdAt: new Date().toISOString(),
      businessId,
      data: typeof data === "function" ? await data() : data,
    };
    for (const endpoint of endpoints) {
      const delivery = await prisma.webhookDelivery.create({
        data: { businessId, endpointId: endpoint.id, eventId: payload.id, eventType: type, payload: payload as object },
      });
      await enqueueDelivery(delivery.id);
    }
  })().catch((err) => logger.warn(`Couldn't queue ${type} for business ${businessId}: ${(err as Error).message}`));
}

export async function enqueueDelivery(deliveryId: string) {
  await deliveryQueue().add(
    "deliver",
    { deliveryId },
    { jobId: deliveryId, attempts: DELIVERY_ATTEMPTS, backoff: { type: "exponential", delay: RETRY_BASE_MS } },
  );
}

/** URL rules for an endpoint, with user-facing messages. */
export async function checkEndpointUrl(raw: string): Promise<string> {
  const url = await assertPublicUrl(raw, { allowPrivate: config.mcpAllowPrivateUrls });
  // Plain http is only for local development, where private URLs are allowed too.
  if (url.protocol !== "https:" && !config.mcpAllowPrivateUrls) throw new Error("Use an https:// URL");
  // Sending workflow events to a workflow's own webhook could loop forever.
  if (url.origin === new URL(config.publicApiUrl).origin && url.pathname.startsWith("/hooks/")) {
    throw new Error("This URL is one of this platform's own webhooks. Run the workflow from an app automation instead.");
  }
  return url.toString();
}

/**
 * One attempt at a delivery. `final` marks the last try (no retry left): a
 * failure then counts against the endpoint. Returns whether it succeeded.
 */
export async function attemptDelivery(deliveryId: string, { final }: { final: boolean }): Promise<boolean> {
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: true } });
  if (!delivery || delivery.status !== "pending") return true;
  const { endpoint } = delivery;
  const attempts = delivery.attempts + 1;
  const now = new Date();

  if (!endpoint.enabled) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: "failed", error: "Not sent: the endpoint is turned off", nextAttemptAt: null },
    });
    return true;
  }

  // Postgres JSON doesn't keep key order; send the envelope in its documented order.
  const { id, type, createdAt, businessId, test, data } = delivery.payload as unknown as WebhookEventPayload;
  const body = JSON.stringify({ id, type, createdAt, businessId, ...(test ? { test } : {}), data });
  const timestamp = Math.floor(now.getTime() / 1000);
  const started = Date.now();
  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  try {
    await checkEndpointUrl(endpoint.url);
    const response = await axios.post<string>(endpoint.url, body, {
      timeout: TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: 1_000_000,
      responseType: "text",
      transformResponse: (data) => data,
      validateStatus: () => true,
      ...(config.mcpAllowPrivateUrls ? {} : { httpAgent: guardedHttpAgent, httpsAgent: guardedHttpsAgent }),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AiAutomationPlatform-Webhooks/1.0",
        "webhook-id": delivery.eventId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": sign(openSecret(endpoint.secretEncrypted), delivery.eventId, timestamp, body),
      },
    });
    responseStatus = response.status;
    responseBody = typeof response.data === "string" ? response.data.slice(0, MAX_RESPONSE_CHARS) : null;
    if (response.status < 200 || response.status >= 300) {
      error = response.status >= 300 && response.status < 400 ? `Redirected (HTTP ${response.status}); redirects aren't followed` : `HTTP ${response.status}`;
    }
  } catch (err) {
    const e = err as Error & { code?: string };
    error = e.code === "ECONNABORTED" ? `Timed out after ${TIMEOUT_MS / 1000}s` : e.message;
  }
  const durationMs = Date.now() - started;
  const ok = error === null;
  const retrying = !ok && !final;

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: ok ? "succeeded" : retrying ? "pending" : "failed",
      attempts,
      responseStatus,
      responseBody,
      error,
      durationMs,
      lastAttemptAt: now,
      nextAttemptAt: retrying ? new Date(now.getTime() + RETRY_BASE_MS * 2 ** (attempts - 1)) : null,
    },
  });

  if (ok && endpoint.consecutiveFailures > 0) {
    await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { consecutiveFailures: 0 } });
  } else if (!ok && final) {
    const updated = await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { consecutiveFailures: { increment: 1 } },
    });
    if (updated.enabled && updated.consecutiveFailures >= DISABLE_AFTER_FAILURES) {
      await prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { enabled: false, disabledReason: `Turned off after ${DISABLE_AFTER_FAILURES} deliveries in a row failed every retry` },
      });
      logger.warn(`Endpoint ${endpoint.id} turned off after repeated failures`);
    }
  }
  return ok;
}
