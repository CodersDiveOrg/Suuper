import axios from "axios";
import { guardedHttpAgent, guardedHttpsAgent, isBlockedLiteralHost, assertPublicUrl } from "@platform/shared-auth";
import { chat } from "@platform/shared-ai";
import { loadServiceConfig } from "@platform/shared-config";
import { signBusinessToken } from "@platform/shared-auth";
import type { WorkflowStep } from "@platform/shared-types";
import { findModel, integrationCredentials, requireAnthropicKey } from "../../agents/runtime/models";
import { AnthropicProvider } from "../../agents/runtime/providers/anthropic";
import { buildToolSet } from "../../agents/runtime/toolset";
import { runStatelessLoop } from "../../agents/runtime/stateless-loop";
import { INTEGRATION_ACTIONS } from "../../agents/runtime/integrations/actions";
import { validateActionInput } from "../../agents/runtime/integrations";
import { ActionError } from "../../agents/runtime/integrations/http";
import { buildKnowledgePrompt, searchKnowledge } from "../../agents/runtime/knowledge";
import { fill, lookup, type TemplateContext } from "./template";

const config = loadServiceConfig("bot-service", 3002);

export const DEFAULT_AI_MODEL = "llama3.2:1b";
const HTTP_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 50_000;
// Messages/emails one run may send — a loop or a bad template can't spam customers.
export const MAX_SENDS_PER_RUN = 10;

export interface StepContext extends TemplateContext {
  businessId: string;
  sends: number;
}

export interface StepOutcome {
  input: unknown;
  output: unknown;
  /** A condition that didn't pass: stop the run here, successfully. */
  stop?: boolean;
}

export class StepError extends Error {}

export async function runStep(step: WorkflowStep, ctx: StepContext): Promise<StepOutcome> {
  switch (step.type) {
    case "ai":
      return runAi(step, ctx);
    case "action":
      return runAction(step, ctx);
    case "http":
      return runHttp(step, ctx);
    case "condition":
      return runCondition(step, ctx);
  }
}

async function runAi(step: Extract<WorkflowStep, { type: "ai" }>, ctx: StepContext): Promise<StepOutcome> {
  const prompt = fill(step.prompt, ctx);
  const modelId = step.model || DEFAULT_AI_MODEL;
  const model = findModel(modelId);
  if (!model) throw new StepError(`Unknown model "${modelId}"`);

  let userContent = prompt;
  if (step.knowledgeBaseIds?.length) {
    const token = signBusinessToken({
      userId: "workflow",
      businessId: ctx.businessId,
      role: "member",
      permissions: ["knowledge:read"],
    });
    const knowledge = await searchKnowledge(step.knowledgeBaseIds, prompt, `Bearer ${token}`);
    userContent = buildKnowledgePrompt(prompt, knowledge, "Task");
  }
  const system = "You are a step in a business automation. Do exactly what the task asks and reply with only the result, without preamble.";

  let text: string;
  if (model.provider === "anthropic") {
    const provider = new AnthropicProvider(await requireAnthropicKey(ctx.businessId), model);
    const toolSet = await buildToolSet({
      businessId: ctx.businessId,
      provider: "anthropic",
      builtInTools: [],
      knowledgeBaseIds: [],
      mcpServerIds: [],
      source: "agent",
    });
    ({ reply: text } = await runStatelessLoop({ provider, model: modelId, system, userContent, toolSet, maxSteps: 1 }));
  } else {
    text = await chat(
      [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      modelId,
    );
  }
  // Small models often wrap the whole answer in quotes.
  const trimmed = text.trim().replace(/^"([^"]*)"$/s, "$1");
  return { input: { prompt, model: modelId }, output: { text: trimmed } };
}

async function runAction(step: Extract<WorkflowStep, { type: "action" }>, ctx: StepContext): Promise<StepOutcome> {
  const action = INTEGRATION_ACTIONS[step.provider]?.find((a) => a.name === step.action);
  if (!action) throw new StepError(`Unknown action ${step.provider} / ${step.action}`);
  const creds = await integrationCredentials(ctx.businessId, step.provider);
  if (!creds) throw new StepError(`The ${step.provider} integration isn't connected or is turned off`);

  const filled = Object.fromEntries(Object.entries(step.inputs ?? {}).map(([key, value]) => [key, fill(value, ctx)]));
  if (action.sends) {
    if (ctx.sends >= MAX_SENDS_PER_RUN) throw new StepError(`Send limit reached (${MAX_SENDS_PER_RUN} messages per run)`);
    ctx.sends++;
  }
  try {
    const input = validateActionInput(action.params, filled);
    return { input, output: await action.run(creds, input) };
  } catch (error) {
    throw new StepError(error instanceof ActionError ? error.message : `Failed: ${(error as Error).message}`);
  }
}

async function runHttp(step: Extract<WorkflowStep, { type: "http" }>, ctx: StepContext): Promise<StepOutcome> {
  const url = fill(step.url, ctx).trim();
  try {
    await assertPublicUrl(url, { allowPrivate: config.mcpAllowPrivateUrls });
  } catch (error) {
    throw new StepError((error as Error).message);
  }
  const headers: Record<string, string> = { "User-Agent": "SuuperWorkflows/1.0" };
  for (const line of fill(step.headers, ctx).split("\n")) {
    const index = line.indexOf(":");
    if (index > 0) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  const looksJson = /^\s*[[{]/.test(step.body ?? "");
  const rawBody = step.method === "GET" || step.method === "DELETE" ? undefined : fill(step.body, ctx, { json: looksJson });
  let data: unknown = rawBody || undefined;
  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
      headers["Content-Type"] ??= "application/json";
    } catch {
      headers["Content-Type"] ??= "text/plain";
    }
  }

  const response = await axios.request({
    url,
    method: step.method,
    data,
    headers,
    timeout: HTTP_TIMEOUT_MS,
    maxRedirects: 3,
    ...(config.mcpAllowPrivateUrls ? {} : { httpAgent: guardedHttpAgent, httpsAgent: guardedHttpsAgent }),
    beforeRedirect: (options: { hostname?: string }) => {
      if (!config.mcpAllowPrivateUrls && options.hostname && isBlockedLiteralHost(options.hostname)) {
        throw new Error("Redirect to a private address was blocked");
      }
    },
    maxContentLength: 2_000_000,
    responseType: "text",
    transformResponse: (r) => r,
    validateStatus: () => true,
  }).catch((error: Error) => {
    throw new StepError(`Request failed: ${error.message}`);
  });

  const text = String(response.data ?? "").slice(0, MAX_RESPONSE_CHARS);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep as text
  }
  const input = { method: step.method, url, headers, body: rawBody };
  if (response.status >= 400) throw Object.assign(new StepError(`HTTP ${response.status}`), { input, output: { status: response.status, body } });
  return { input, output: { status: response.status, body } };
}

function runCondition(step: Extract<WorkflowStep, { type: "condition" }>, ctx: StepContext): StepOutcome {
  // A bare path ("trigger.email") is accepted as well as "{{trigger.email}}".
  const resolve = (value: string | undefined) =>
    value && /^(trigger|steps)(\.[\w-]+)+$/.test(value.trim()) ? stringify(lookup(ctx, value.trim())) : fill(value, ctx);
  const left = resolve(step.left);
  const right = resolve(step.right);
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();

  let passed: boolean;
  switch (step.operator) {
    case "equals":
      passed = a === b;
      break;
    case "not_equals":
      passed = a !== b;
      break;
    case "contains":
      passed = a.includes(b);
      break;
    case "not_contains":
      passed = !a.includes(b);
      break;
    case "is_empty":
      passed = a === "";
      break;
    case "is_not_empty":
      passed = a !== "";
      break;
    case "greater_than":
    case "less_than": {
      const x = Number(left);
      const y = Number(right);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new StepError(`"${left}" and "${right}" must both be numbers`);
      passed = step.operator === "greater_than" ? x > y : x < y;
      break;
    }
  }
  return { input: { left, operator: step.operator, right }, output: { passed }, stop: !passed };
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
