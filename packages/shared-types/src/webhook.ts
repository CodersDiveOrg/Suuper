// --- Outgoing webhooks ---------------------------------------------------------
// A business registers endpoints; when something happens, each subscribed
// endpoint gets a signed POST (Standard Webhooks: webhook-id / -timestamp /
// -signature headers) with a WebhookEventPayload body.

export const WEBHOOK_DELIVERY_QUEUE = "webhook-delivery";

export interface WebhookEventDefinition {
  type: string;
  group: "Apps" | "Bots" | "Agents" | "Workflows";
  label: string;
  description: string;
  /** What `data` looks like, shown in the dashboard and sent by "Send test". */
  example: Record<string, unknown>;
}

const exampleApp = { id: "6f1c2a40-0000-4000-8000-000000000001", name: "CRM" };
const exampleRecord = {
  id: "6f1c2a40-0000-4000-8000-000000000002",
  reference: "LEAD-1042",
  entity: { key: "lead", name: "Lead" },
  source: "public",
  data: { name: "Sara Khan", email: "sara@example.com", status: "New", owner: "6f1c2a40-0000-4000-8000-000000000009" },
  display: { name: "Sara Khan", email: "sara@example.com", status: "New", owner: "Ali Raza" },
  createdAt: "2026-10-25T08:00:00.000Z",
  updatedAt: "2026-10-25T08:00:00.000Z",
  link: "https://app.example.com/dashboard/apps/6f1c2a40-0000-4000-8000-000000000001?record=6f1c2a40-0000-4000-8000-000000000002",
};
const exampleBot = { id: "6f1c2a40-0000-4000-8000-000000000003", name: "Website assistant" };

export const WEBHOOK_EVENTS: WebhookEventDefinition[] = [
  {
    type: "app.record.created",
    group: "Apps",
    label: "Record created",
    description:
      "A record was added to an app, including public form submissions (source \"public\"). The record's data has raw values (ids for people and linked records); display has names and titles.",
    example: { app: exampleApp, record: exampleRecord },
  },
  {
    type: "app.record.updated",
    group: "Apps",
    label: "Record updated",
    description: "A record's fields changed. changes lists each field with its old and new value.",
    example: {
      app: exampleApp,
      record: {
        ...exampleRecord,
        data: { ...exampleRecord.data, status: "Qualified" },
        display: { ...exampleRecord.display, status: "Qualified" },
        updatedAt: "2026-10-25T09:30:00.000Z",
      },
      changes: [{ field: "status", from: "New", to: "Qualified" }],
    },
  },
  {
    type: "app.record.deleted",
    group: "Apps",
    label: "Record deleted",
    description: "A record was deleted from an app.",
    example: { app: exampleApp, record: { id: exampleRecord.id, reference: exampleRecord.reference, entity: exampleRecord.entity } },
  },
  {
    type: "bot.conversation.started",
    group: "Bots",
    label: "Conversation started",
    description: "Someone sent a bot their first message, on your website or in the playground.",
    example: {
      bot: exampleBot,
      conversation: { id: "6f1c2a40-0000-4000-8000-000000000004", source: "widget", origin: "https://example.com" },
      question: "Do you deliver to Lahore?",
      reply: "Yes, we deliver across Pakistan in 2–4 working days.",
    },
  },
  {
    type: "bot.question.unanswered",
    group: "Bots",
    label: "Question not answered",
    description: "A bot couldn't answer a question, so you can follow up or add the answer to its knowledge.",
    example: {
      bot: exampleBot,
      conversation: { id: "6f1c2a40-0000-4000-8000-000000000004", source: "widget", origin: "https://example.com" },
      question: "Can I pay in installments?",
      reply: "I don't have any information about installment plans.",
    },
  },
  {
    type: "agent.run.succeeded",
    group: "Agents",
    label: "Agent run succeeded",
    description: "An agent finished a chat request or scheduled task.",
    example: {
      agent: { id: "6f1c2a40-0000-4000-8000-000000000005", name: "Daily briefing" },
      run: {
        id: "6f1c2a40-0000-4000-8000-000000000006",
        trigger: "schedule",
        status: "succeeded",
        output: "Here's today's summary…",
        error: null,
        model: "claude-sonnet-5-5",
        inputTokens: 5120,
        outputTokens: 640,
        costUsd: 0.0166,
        startedAt: "2026-10-25T08:00:00.000Z",
        finishedAt: "2026-10-25T08:00:21.000Z",
      },
    },
  },
  {
    type: "agent.run.failed",
    group: "Agents",
    label: "Agent run failed",
    description: "An agent run stopped with an error.",
    example: {
      agent: { id: "6f1c2a40-0000-4000-8000-000000000005", name: "Daily briefing" },
      run: { id: "6f1c2a40-0000-4000-8000-000000000006", trigger: "schedule", status: "failed", error: "Anthropic API key is missing" },
    },
  },
  {
    type: "workflow.run.succeeded",
    group: "Workflows",
    label: "Workflow run succeeded",
    description: "A workflow finished all its steps, or stopped early at an \"Only continue if\" step (status \"stopped\").",
    example: {
      workflow: { id: "6f1c2a40-0000-4000-8000-000000000007", name: "New lead → Slack" },
      run: { id: "6f1c2a40-0000-4000-8000-000000000008", trigger: "app", status: "succeeded", startedAt: "2026-10-25T08:00:00.000Z", finishedAt: "2026-10-25T08:00:03.000Z" },
    },
  },
  {
    type: "workflow.run.failed",
    group: "Workflows",
    label: "Workflow run failed",
    description: "A workflow step failed, so the run stopped.",
    example: {
      workflow: { id: "6f1c2a40-0000-4000-8000-000000000007", name: "New lead → Slack" },
      run: { id: "6f1c2a40-0000-4000-8000-000000000008", trigger: "app", status: "failed", error: "Send Slack message: channel_not_found" },
    },
  },
];

/** Sent only by "Send test"; endpoints don't subscribe to it. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

export function isWebhookEventType(value: unknown): value is string {
  return typeof value === "string" && WEBHOOK_EVENTS.some((e) => e.type === value);
}

/** The JSON body of every delivery. */
export interface WebhookEventPayload {
  id: string;
  type: string;
  createdAt: string;
  businessId: string;
  /** Present on events sent with "Send test". */
  test?: true;
  data: Record<string, unknown>;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** Last 7 days. */
  stats: { delivered: number; failed: number; pending: number; lastDeliveryAt: string | null };
}

export type WebhookDeliveryStatus = "pending" | "succeeded" | "failed";

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
}

export interface WebhookDeliveryDetail extends WebhookDelivery {
  payload: WebhookEventPayload;
  responseBody: string | null;
}

export interface WebhookDeliveryJob {
  deliveryId: string;
}
