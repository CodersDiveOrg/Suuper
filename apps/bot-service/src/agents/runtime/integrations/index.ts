import { prisma } from "@platform/database";
import { INTEGRATION_PROVIDERS } from "@platform/shared-types";
import { integrationCredentials } from "../models";
import type { ClientTool } from "../providers/types";
import type { ToolResult } from "../tools";
import { INTEGRATION_ACTIONS, type ActionParam, type IntegrationAction } from "./actions";
import { ActionError, result } from "./http";

// Messages/emails one run may send across all integrations — stops a confused
// (or manipulated) model from spamming customers.
const MAX_SENDS_PER_RUN = 5;

export function hasActions(provider: string) {
  return (INTEGRATION_ACTIONS[provider]?.length ?? 0) > 0;
}

/** For the UI: integrations that have actions, whether each is connected, and what it can do. */
export async function integrationToolCatalog(businessId: string) {
  const connections = await prisma.integrationConnection.findMany({
    where: { businessId },
    select: { provider: true, enabled: true },
  });
  return INTEGRATION_PROVIDERS.filter((p) => hasActions(p.key)).map((p) => {
    const connection = connections.find((c) => c.provider === p.key);
    return {
      provider: p.key,
      name: p.name,
      category: p.category,
      connected: !!connection,
      enabled: connection?.enabled ?? false,
      actions: INTEGRATION_ACTIONS[p.key].map((a) => ({
        name: `${p.key}__${a.name}`,
        label: a.label,
        description: a.description,
        sends: !!a.sends,
      })),
    };
  });
}

function toSchema(params: Record<string, ActionParam>): ClientTool["input_schema"] {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(params).map(([k, p]) => [k, { type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}) }]),
    ),
    required: Object.entries(params).filter(([, p]) => p.required).map(([k]) => k),
  };
}

export function validateActionInput(params: Record<string, ActionParam>, input: unknown): Record<string, unknown> {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(params)) {
    let v = raw[key];
    if (v === undefined || v === null || v === "") {
      if (p.required) throw new ActionError(`Missing required input: ${key}`);
      continue;
    }
    // Small models often send numbers as strings and vice versa.
    if ((p.type === "integer" || p.type === "number") && typeof v === "string" && v.trim() !== "") v = Number(v);
    if (p.type === "string" && typeof v === "number") v = String(v);
    if (p.type === "boolean" && typeof v === "string") v = v === "true";
    const ok =
      p.type === "string" ? typeof v === "string" : p.type === "boolean" ? typeof v === "boolean" : typeof v === "number" && Number.isFinite(v) && (p.type === "number" || Number.isInteger(v));
    if (!ok) throw new ActionError(`${key} must be a ${p.type}`);
    if (p.enum && !p.enum.includes(String(v))) throw new ActionError(`${key} must be one of: ${p.enum.join(", ")}`);
    out[key] = typeof v === "string" ? v.slice(0, 20_000) : v;
  }
  return out;
}

/**
 * Tool definitions for the attached integrations that are connected and
 * enabled (others are left out so the model never sees a tool that can't work),
 * plus an executor keyed by tool name.
 */
export async function loadIntegrationTools(businessId: string, providers: string[], counters: Record<string, number>) {
  const definitions: ClientTool[] = [];
  const handlers = new Map<string, { action: IntegrationAction; creds: Record<string, string> }>();

  for (const provider of providers) {
    const actions = INTEGRATION_ACTIONS[provider];
    if (!actions) continue;
    const creds = await integrationCredentials(businessId, provider);
    if (!creds) continue;
    const name = INTEGRATION_PROVIDERS.find((p) => p.key === provider)?.name ?? provider;
    for (const action of actions) {
      const toolName = `${provider}__${action.name}`;
      handlers.set(toolName, { action, creds });
      definitions.push({ name: toolName, description: `[${name}] ${action.description}`, input_schema: toSchema(action.params) });
    }
  }

  const execute = async (toolName: string, input: unknown): Promise<ToolResult | null> => {
    const handler = handlers.get(toolName);
    if (!handler) return null;
    try {
      const args = validateActionInput(handler.action.params, input);
      if (handler.action.sends) {
        if ((counters.sends ?? 0) >= MAX_SENDS_PER_RUN) {
          return { content: `Send limit reached (${MAX_SENDS_PER_RUN} messages/emails per answer). Not sent.`, isError: true };
        }
        counters.sends = (counters.sends ?? 0) + 1;
      }
      return { content: result(await handler.action.run(handler.creds, args)) };
    } catch (err) {
      const message = err instanceof ActionError ? err.message : `Failed: ${(err as Error).message}`;
      return { content: message, isError: true };
    }
  };

  return { definitions, execute };
}
