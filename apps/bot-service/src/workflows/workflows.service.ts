import { randomUUID } from "crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { loadServiceConfig } from "@platform/shared-config";
import {
  INTEGRATION_PROVIDERS,
  type ConditionOperator,
  type WorkflowInput,
  type WorkflowStep,
  type WorkflowTrigger,
} from "@platform/shared-types";
import { AGENT_MODELS } from "../agents/runtime/models";
import { INTEGRATION_ACTIONS } from "../agents/runtime/integrations/actions";
import { parseScheduleTrigger } from "./engine/schedule";
import { WorkflowQueue } from "./workflow-queue";

const config = loadServiceConfig("bot-service", 3002);

const MAX_STEPS = 15;
const MAX_FIELD_CHARS = 20_000;
const MAX_TRIGGER_DATA_CHARS = 100_000;
const OPERATORS: ConditionOperator[] = ["equals", "not_equals", "contains", "not_contains", "is_empty", "is_not_empty", "greater_than", "less_than"];
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

interface WorkflowRow {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: unknown;
  steps: unknown;
  webhookKey: string;
  createdAt: Date;
  updatedAt: Date;
  runs?: { id: string; status: string; startedAt: Date }[];
}

interface RunRow {
  id: string;
  workflowId: string;
  trigger: string;
  status: string;
  triggerData: unknown;
  steps: unknown;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

@Injectable()
export class WorkflowsService {
  constructor(private readonly queue: WorkflowQueue) {}

  async list(businessId: string) {
    const workflows = await prisma.workflow.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      include: { runs: { orderBy: { startedAt: "desc" }, take: 1, select: { id: true, status: true, startedAt: true } } },
    });
    return workflows.map((w) => this.serialize(w));
  }

  async get(businessId: string, id: string) {
    return this.serialize(await this.require(businessId, id));
  }

  async create(businessId: string, input: WorkflowInput) {
    const name = this.validName(input.name);
    const workflow = await prisma.workflow.create({
      data: {
        businessId,
        name,
        description: input.description?.trim() || null,
        trigger: (input.trigger ? this.validTrigger(input.trigger) : { type: "manual" }) as object,
        steps: (input.steps ? this.validSteps(input.steps) : []) as object[],
        enabled: false,
      },
    });
    return this.serialize(workflow);
  }

  async update(businessId: string, id: string, input: WorkflowInput) {
    const existing = await this.require(businessId, id);
    const steps = input.steps !== undefined ? this.validSteps(input.steps) : (existing.steps as WorkflowStep[]);
    const enabled = input.enabled !== undefined ? input.enabled === true : existing.enabled;
    if (enabled && steps.length === 0) throw new BadRequestException("Add at least one step before turning the workflow on");
    const workflow = await prisma.workflow.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: this.validName(input.name) } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        ...(input.trigger !== undefined ? { trigger: this.validTrigger(input.trigger) as object } : {}),
        ...(input.steps !== undefined ? { steps: steps as object[] } : {}),
        enabled,
      },
    });
    await this.queue.syncSchedule(workflow);
    return this.serialize(workflow);
  }

  async remove(businessId: string, id: string) {
    await this.require(businessId, id);
    await prisma.workflow.delete({ where: { id } });
    await this.queue.removeSchedule(id);
  }

  /** New webhook URL; the old one stops working immediately. */
  async regenerateWebhook(businessId: string, id: string) {
    await this.require(businessId, id);
    return this.serialize(await prisma.workflow.update({ where: { id }, data: { webhookKey: randomUUID() } }));
  }

  /** "Run now" / test run, with optional sample trigger data. Works whether or not the workflow is on. */
  async runNow(businessId: string, id: string, userId: string, triggerData: unknown) {
    const workflow = await this.require(businessId, id);
    if ((workflow.steps as unknown[]).length === 0) throw new BadRequestException("Add at least one step first");
    const run = await prisma.workflowRun.create({
      data: { businessId, workflowId: id, trigger: "manual", userId, triggerData: this.validTriggerData(triggerData) },
    });
    await this.queue.enqueueRun(run.id);
    return this.serializeRun(run);
  }

  /** Public webhook: only fires for an enabled workflow with a webhook trigger. */
  async runFromWebhook(webhookKey: string, body: unknown, query: Record<string, unknown>) {
    const workflow = await prisma.workflow.findUnique({ where: { webhookKey } });
    if (!workflow || (workflow.trigger as WorkflowTrigger).type !== "webhook") throw new NotFoundException("Unknown webhook");
    if (!workflow.enabled) throw new BadRequestException("This workflow is turned off");
    const data = body && typeof body === "object" && Object.keys(body).length > 0 ? body : query;
    const run = await prisma.workflowRun.create({
      data: { businessId: workflow.businessId, workflowId: workflow.id, trigger: "webhook", triggerData: this.validTriggerData(data) },
    });
    await this.queue.enqueueRun(run.id);
    return { accepted: true, runId: run.id };
  }

  /** A form submitted on an app's page. Runs whether or not the workflow is on: linking it to the app is the opt-in. */
  async runFromApp(businessId: string, workflowId: string, triggerData: object) {
    const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow || workflow.businessId !== businessId || (workflow.steps as unknown[]).length === 0) return null;
    const run = await prisma.workflowRun.create({
      data: { businessId, workflowId, trigger: "app", triggerData: this.validTriggerData(triggerData) },
    });
    await this.queue.enqueueRun(run.id);
    return run.id;
  }

  async listRuns(businessId: string, id: string, limit?: string) {
    await this.require(businessId, id);
    const runs = await prisma.workflowRun.findMany({
      where: { workflowId: id },
      orderBy: { startedAt: "desc" },
      take: Math.min(Math.max(Number(limit) || 20, 1), 100),
    });
    return runs.map((run) => this.serializeRun(run));
  }

  async getRun(businessId: string, id: string, runId: string) {
    const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run || run.businessId !== businessId || run.workflowId !== id) throw new NotFoundException("Run not found");
    return this.serializeRun(run);
  }

  /** What the builder can offer: AI models and every app action with its fields and connection status. */
  async catalog(businessId: string) {
    const connections = await prisma.integrationConnection.findMany({
      where: { businessId },
      select: { provider: true, enabled: true },
    });
    return {
      models: AGENT_MODELS.map((m) => ({ id: m.id, label: m.label, provider: m.provider })),
      apps: INTEGRATION_PROVIDERS.filter((p) => INTEGRATION_ACTIONS[p.key]?.length).map((p) => {
        const connection = connections.find((c) => c.provider === p.key);
        return {
          provider: p.key,
          name: p.name,
          category: p.category,
          connected: !!connection?.enabled,
          actions: INTEGRATION_ACTIONS[p.key].map((a) => ({
            name: a.name,
            label: a.label,
            description: a.description,
            params: Object.entries(a.params).map(([key, param]) => ({ key, ...param })),
          })),
        };
      }),
    };
  }

  private validName(name: unknown) {
    if (typeof name !== "string" || !name.trim()) throw new BadRequestException("name is required");
    return name.trim().slice(0, 120);
  }

  private validTrigger(trigger: unknown): WorkflowTrigger {
    const t = (trigger ?? {}) as Record<string, unknown>;
    if (t.type === "manual" || t.type === "webhook") return { type: t.type };
    if (t.type !== "schedule") throw new BadRequestException('trigger.type must be "manual", "webhook" or "schedule"');

    return parseScheduleTrigger(t);
  }

  private validSteps(steps: unknown): WorkflowStep[] {
    if (!Array.isArray(steps)) throw new BadRequestException("steps must be a list");
    if (steps.length > MAX_STEPS) throw new BadRequestException(`A workflow can have at most ${MAX_STEPS} steps`);
    const ids = new Set<string>();
    return steps.map((raw, index) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      const label = `Step ${index + 1}`;
      const id = typeof s.id === "string" && /^[\w-]{1,40}$/.test(s.id) ? s.id : null;
      if (!id || ids.has(id)) throw new BadRequestException(`${label} needs a unique id`);
      ids.add(id);
      const name = typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 80) : undefined;
      const text = (key: string, required: boolean) => {
        const value = s[key];
        if (value === undefined || value === null || value === "") {
          if (required) throw new BadRequestException(`${label}: ${key} is required`);
          return undefined;
        }
        if (typeof value !== "string") throw new BadRequestException(`${label}: ${key} must be text`);
        if (value.length > MAX_FIELD_CHARS) throw new BadRequestException(`${label}: ${key} is too long`);
        return value;
      };

      switch (s.type) {
        case "ai": {
          const model = text("model", false);
          if (model && !AGENT_MODELS.some((m) => m.id === model)) throw new BadRequestException(`${label}: unknown model`);
          const knowledgeBaseIds = Array.isArray(s.knowledgeBaseIds) ? s.knowledgeBaseIds.filter((k): k is string => typeof k === "string") : [];
          return { id, type: "ai", name, prompt: text("prompt", true)!, model, knowledgeBaseIds };
        }
        case "action": {
          const provider = text("provider", true)!;
          const actionName = text("action", true)!;
          const action = INTEGRATION_ACTIONS[provider]?.find((a) => a.name === actionName);
          if (!action) throw new BadRequestException(`${label}: choose an app and action`);
          const rawInputs = (s.inputs ?? {}) as Record<string, unknown>;
          const inputs: Record<string, string> = {};
          for (const key of Object.keys(action.params)) {
            const value = rawInputs[key];
            if (typeof value === "string" && value !== "") inputs[key] = value.slice(0, MAX_FIELD_CHARS);
          }
          return { id, type: "action", name, provider, action: actionName, inputs };
        }
        case "http": {
          const method = HTTP_METHODS.find((m) => m === s.method);
          if (!method) throw new BadRequestException(`${label}: choose a method`);
          return { id, type: "http", name, method, url: text("url", true)!, headers: text("headers", false), body: text("body", false) };
        }
        case "condition": {
          const operator = OPERATORS.find((o) => o === s.operator);
          if (!operator) throw new BadRequestException(`${label}: choose a comparison`);
          return { id, type: "condition", name, left: text("left", true)!, operator, right: text("right", false) };
        }
        default:
          throw new BadRequestException(`${label}: unknown step type`);
      }
    });
  }

  private validTriggerData(data: unknown): object {
    if (data === undefined || data === null) return {};
    if (typeof data !== "object") return { value: data };
    if (JSON.stringify(data).length > MAX_TRIGGER_DATA_CHARS) throw new BadRequestException("Trigger data is too large");
    return data as object;
  }

  private async require(businessId: string, id: string): Promise<WorkflowRow> {
    const workflow = await prisma.workflow.findUnique({ where: { id } });
    if (!workflow || workflow.businessId !== businessId) throw new NotFoundException("Workflow not found");
    return workflow;
  }

  private serialize(w: WorkflowRow) {
    const lastRun = w.runs?.[0];
    return {
      id: w.id,
      businessId: w.businessId,
      name: w.name,
      description: w.description ?? undefined,
      enabled: w.enabled,
      trigger: w.trigger as WorkflowTrigger,
      steps: w.steps as WorkflowStep[],
      webhookUrl: `${config.publicApiUrl}/hooks/workflows/${w.webhookKey}`,
      lastRun: lastRun ? { id: lastRun.id, status: lastRun.status, startedAt: lastRun.startedAt.toISOString() } : undefined,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }

  private serializeRun(run: RunRow) {
    return {
      id: run.id,
      workflowId: run.workflowId,
      trigger: run.trigger,
      status: run.status,
      triggerData: run.triggerData ?? undefined,
      steps: run.steps,
      error: run.error ?? undefined,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString(),
    };
  }
}
