import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, prisma } from "@platform/database";
import {
  isWebhookEventType,
  WEBHOOK_EVENTS,
  WEBHOOK_TEST_EVENT,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
  type WebhookEndpoint,
  type WebhookEventPayload,
} from "@platform/shared-types";
import { attemptDelivery, checkEndpointUrl, newEventId, newSecret, openSecret, sealSecret } from "./delivery";

const MAX_ENDPOINTS = 20;
const PAGE_SIZE = 50;
const STATS_DAYS = 7;

export interface EndpointInput {
  url?: unknown;
  description?: unknown;
  events?: unknown;
  enabled?: unknown;
}

type EndpointRow = NonNullable<Awaited<ReturnType<typeof prisma.webhookEndpoint.findUnique>>>;
type DeliveryRow = NonNullable<Awaited<ReturnType<typeof prisma.webhookDelivery.findUnique>>>;
type Stats = WebhookEndpoint["stats"];

@Injectable()
export class WebhooksService {
  events() {
    return WEBHOOK_EVENTS;
  }

  async list(businessId: string): Promise<WebhookEndpoint[]> {
    const rows = await prisma.webhookEndpoint.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
    const stats = await this.stats(businessId);
    return rows.map((row) => serializeEndpoint(row, stats.get(row.id)));
  }

  async get(businessId: string, id: string): Promise<WebhookEndpoint> {
    const row = await this.require(businessId, id);
    return serializeEndpoint(row, (await this.stats(businessId, id)).get(id));
  }

  /** The secret is returned once here; later it's read through secret(). */
  async create(businessId: string, userId: string, input: EndpointInput) {
    if ((await prisma.webhookEndpoint.count({ where: { businessId } })) >= MAX_ENDPOINTS) {
      throw new BadRequestException(`A business can have up to ${MAX_ENDPOINTS} webhook endpoints`);
    }
    const secret = newSecret();
    const row = await prisma.webhookEndpoint.create({
      data: {
        businessId,
        url: await validUrl(input.url),
        description: validDescription(input.description),
        events: validEvents(input.events),
        enabled: input.enabled === undefined ? true : input.enabled === true,
        secretEncrypted: sealSecret(secret),
        createdById: userId,
      },
    });
    return { ...serializeEndpoint(row, undefined), secret };
  }

  async update(businessId: string, id: string, input: EndpointInput): Promise<WebhookEndpoint> {
    const existing = await this.require(businessId, id);
    const data: Prisma.WebhookEndpointUpdateInput = {};
    if (input.url !== undefined) data.url = await validUrl(input.url);
    if (input.description !== undefined) data.description = validDescription(input.description);
    if (input.events !== undefined) data.events = validEvents(input.events);
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") throw new BadRequestException("enabled must be true or false");
      data.enabled = input.enabled;
      // Turning it back on starts the failure count over.
      if (input.enabled && !existing.enabled) Object.assign(data, { disabledReason: null, consecutiveFailures: 0 });
    }
    await prisma.webhookEndpoint.update({ where: { id }, data });
    return this.get(businessId, id);
  }

  async remove(businessId: string, id: string) {
    await this.require(businessId, id);
    await prisma.webhookEndpoint.delete({ where: { id } });
  }

  async secret(businessId: string, id: string) {
    return { secret: openSecret((await this.require(businessId, id)).secretEncrypted) };
  }

  /** New secret; the old one stops verifying immediately. */
  async rotateSecret(businessId: string, id: string) {
    await this.require(businessId, id);
    const secret = newSecret();
    await prisma.webhookEndpoint.update({ where: { id }, data: { secretEncrypted: sealSecret(secret) } });
    return { secret };
  }

  /**
   * Sends one delivery right now (no retries) and returns its result. With an
   * event type it sends that event's example data, marked `test: true`.
   */
  async test(businessId: string, id: string, eventType?: unknown): Promise<WebhookDeliveryDetail> {
    const endpoint = await this.require(businessId, id);
    if (!endpoint.enabled) throw new BadRequestException("Turn the endpoint on to send a test");
    if (eventType !== undefined && !isWebhookEventType(eventType)) throw new BadRequestException("Unknown event type");
    const example = WEBHOOK_EVENTS.find((e) => e.type === eventType);
    const payload: WebhookEventPayload & { test: true } = {
      id: newEventId(),
      type: example?.type ?? WEBHOOK_TEST_EVENT,
      createdAt: new Date().toISOString(),
      businessId,
      test: true,
      data: example?.example ?? { message: "This is a test event. If you can read this, your endpoint works." },
    };
    return this.sendNow(businessId, id, payload.id, payload.type, payload);
  }

  /** Sends a past delivery's event again, with the same webhook-id. */
  async redeliver(businessId: string, deliveryId: string): Promise<WebhookDeliveryDetail> {
    const original = await this.requireDelivery(businessId, deliveryId);
    const endpoint = await this.require(businessId, original.endpointId);
    if (!endpoint.enabled) throw new BadRequestException("Turn the endpoint on to resend events");
    return this.sendNow(businessId, endpoint.id, original.eventId, original.eventType, original.payload as object);
  }

  async deliveries(
    businessId: string,
    endpointId: string,
    query: { status?: string; eventType?: string; before?: string },
  ): Promise<{ items: WebhookDelivery[]; nextCursor: string | null }> {
    await this.require(businessId, endpointId);
    const where: Prisma.WebhookDeliveryWhereInput = { endpointId };
    if (query.status && ["pending", "succeeded", "failed"].includes(query.status)) where.status = query.status;
    if (query.eventType) where.eventType = query.eventType;
    if (query.before) {
      const before = new Date(query.before);
      if (Number.isNaN(before.getTime())) throw new BadRequestException("before must be a date");
      where.createdAt = { lt: before };
    }
    const rows = await prisma.webhookDelivery.findMany({ where, orderBy: { createdAt: "desc" }, take: PAGE_SIZE + 1 });
    const items = rows.slice(0, PAGE_SIZE).map(serializeDelivery);
    return { items, nextCursor: rows.length > PAGE_SIZE ? items[items.length - 1].createdAt : null };
  }

  async delivery(businessId: string, deliveryId: string): Promise<WebhookDeliveryDetail> {
    return serializeDetail(await this.requireDelivery(businessId, deliveryId));
  }

  // --- helpers ------------------------------------------------------------------

  private async sendNow(businessId: string, endpointId: string, eventId: string, eventType: string, payload: object) {
    const delivery = await prisma.webhookDelivery.create({ data: { businessId, endpointId, eventId, eventType, payload } });
    await attemptDelivery(delivery.id, { final: true });
    return this.delivery(businessId, delivery.id);
  }

  private async require(businessId: string, id: string): Promise<EndpointRow> {
    const row = await prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!row || row.businessId !== businessId) throw new NotFoundException("Webhook endpoint not found");
    return row;
  }

  private async requireDelivery(businessId: string, id: string): Promise<DeliveryRow> {
    const row = await prisma.webhookDelivery.findUnique({ where: { id } });
    if (!row || row.businessId !== businessId) throw new NotFoundException("Delivery not found");
    return row;
  }

  /** Delivery counts per endpoint over the last week. */
  private async stats(businessId: string, endpointId?: string): Promise<Map<string, Stats>> {
    const since = new Date(Date.now() - STATS_DAYS * 86_400_000);
    const groups = await prisma.webhookDelivery.groupBy({
      by: ["endpointId", "status"],
      where: { businessId, createdAt: { gte: since }, ...(endpointId ? { endpointId } : {}) },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const result = new Map<string, Stats>();
    for (const g of groups) {
      const s = result.get(g.endpointId) ?? { delivered: 0, failed: 0, pending: 0, lastDeliveryAt: null };
      if (g.status === "succeeded") s.delivered += g._count._all;
      else if (g.status === "failed") s.failed += g._count._all;
      else s.pending += g._count._all;
      const last = g._max.createdAt?.toISOString() ?? null;
      if (last && (!s.lastDeliveryAt || last > s.lastDeliveryAt)) s.lastDeliveryAt = last;
      result.set(g.endpointId, s);
    }
    return result;
  }
}

async function validUrl(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException("Enter the URL to send events to");
  if (value.length > 2000) throw new BadRequestException("The URL is too long");
  try {
    return await checkEndpointUrl(value.trim());
  } catch (err) {
    throw new BadRequestException(`URL: ${(err as Error).message}`);
  }
}

function validDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new BadRequestException("description must be text");
  return value.trim().slice(0, 200) || null;
}

function validEvents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new BadRequestException("Pick at least one event");
  const unknown = value.filter((v) => !isWebhookEventType(v));
  if (unknown.length) throw new BadRequestException(`Unknown event: ${unknown.map(String).join(", ")}`);
  return [...new Set(value as string[])];
}

function serializeEndpoint(row: EndpointRow, stats: Stats | undefined): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stats: stats ?? { delivered: 0, failed: 0, pending: 0, lastDeliveryAt: null },
  };
}

function serializeDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status as WebhookDelivery["status"],
    attempts: row.attempts,
    responseStatus: row.responseStatus,
    error: row.error,
    durationMs: row.durationMs,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
  };
}

function serializeDetail(row: DeliveryRow): WebhookDeliveryDetail {
  // Envelope keys in their documented order (Postgres JSON doesn't keep it).
  const { id, type, createdAt, businessId, test, data } = row.payload as unknown as WebhookEventPayload;
  const payload: WebhookEventPayload = { id, type, createdAt, businessId, ...(test ? { test } : {}), data };
  return { ...serializeDelivery(row), payload, responseBody: row.responseBody };
}
