import { BadRequestException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { decryptJson } from "@platform/shared-auth";

export type ProviderName = "anthropic" | "openai" | "gemini" | "ollama";
/** Providers reached with an API key (the business's own or Suuper's). */
export type CloudProvider = Exclude<ProviderName, "ollama">;

export interface CloudProviderInfo {
  key: CloudProvider;
  name: string;
  /** Env var holding Suuper's own key, used when the business hasn't added one. */
  platformEnv: string;
  keysUrl: string;
}

export const CLOUD_PROVIDERS: CloudProviderInfo[] = [
  { key: "anthropic", name: "Anthropic", platformEnv: "ANTHROPIC_API_KEY", keysUrl: "https://console.anthropic.com/settings/keys" },
  { key: "openai", name: "OpenAI", platformEnv: "OPENAI_API_KEY", keysUrl: "https://platform.openai.com/api-keys" },
  { key: "gemini", name: "Google Gemini", platformEnv: "GEMINI_API_KEY", keysUrl: "https://aistudio.google.com/apikey" },
];

export interface AgentModel {
  id: string;
  label: string;
  provider: ProviderName;
  description: string;
  /** Anthropic / OpenAI: reasoning effort to send (omitted when the model doesn't take effort). */
  effort?: "low" | "medium" | "high";
  /** Anthropic only: opt into server-side refusal fallbacks (supported on Opus 5.5 / Sonnet 5.5). */
  fallbacks?: boolean;
  /** USD per million input / output tokens, for cost estimates. Local models are free. */
  pricing: { input: number; output: number };
}

// The models an agent can be set to. Order is the order shown in the UI.
export const AGENT_MODELS: AgentModel[] = [
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    provider: "anthropic",
    description: "Most capable — best for multi-step work with tools.",
    effort: "medium",
    fallbacks: true,
  pricing: { input: 4, output: 20 },
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    provider: "anthropic",
    description: "Fast and capable for everyday agents.",
    effort: "medium",
    fallbacks: true,
  pricing: { input: 2, output: 10 },
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    description: "Fastest and cheapest, for simple tasks.",
  pricing: { input: 1, output: 5 },
  },
  {
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    provider: "openai",
    description: "OpenAI's latest everyday model, strong with tools.",
    effort: "medium",
    pricing: { input: 2, output: 10 },
  },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    provider: "openai",
    description: "OpenAI's most capable, for hard multi-step work. Expensive.",
    effort: "medium",
    pricing: { input: 10, output: 50 },
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    provider: "openai",
    description: "Fast and very cheap, for simple tasks.",
    effort: "low",
    pricing: { input: 0.1, output: 0.5 },
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    provider: "gemini",
    description: "Google's most capable, for multi-step work with tools.",
    pricing: { input: 2, output: 10 },
  },
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    provider: "gemini",
    description: "Fast and capable for everyday bots and agents.",
    pricing: { input: 0.75, output: 3.75 },
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    provider: "gemini",
    description: "Google's cheapest, for simple tasks.",
    pricing: { input: 0.3, output: 2.5 },
  },
  {
    id: "llama3.2:3b",
    label: "Llama 3.2 3B (local)",
    provider: "ollama",
    description: "Free, runs on the local Ollama server. Weak at multi-step tool use.",
  pricing: { input: 0, output: 0 },
  },
  {
    id: "llama3.2:1b",
    label: "Llama 3.2 1B (local)",
    provider: "ollama",
    description: "Smallest local model, for quick tests.",
  pricing: { input: 0, output: 0 },
  },
];

/** Estimated USD cost of a run's tokens (standard rates; excludes caching and web search fees). */
export function estimateCostUsd(modelId: string, inputTokens: number, outputTokens: number) {
  const pricing = findModel(modelId)?.pricing;
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

export function findModel(id: string): AgentModel | undefined {
  return AGENT_MODELS.find((m) => m.id === id);
}

/** Decrypted credentials of an enabled integration, or null. Never sent to clients. */
export async function integrationCredentials(
  businessId: string,
  provider: string,
): Promise<Record<string, string> | null> {
  const connection = await prisma.integrationConnection.findUnique({
    where: { businessId_provider: { businessId, provider } },
  });
  if (!connection?.enabled) return null;
  try {
    return { ...(connection.config as Record<string, string>), ...decryptJson<Record<string, string>>(connection.secretsEncrypted) };
  } catch {
    return null;
  }
}

export function cloudProvider(key: string): CloudProviderInfo | undefined {
  return CLOUD_PROVIDERS.find((p) => p.key === key);
}

/**
 * The key to call a provider with: the business's own (Settings → AI Models)
 * wins over Suuper's platform key. `ownKey` calls don't count toward the plan's AI tokens.
 */
export async function providerKey(businessId: string, provider: CloudProvider): Promise<{ apiKey: string; ownKey: boolean } | null> {
  const creds = await integrationCredentials(businessId, provider);
  if (creds?.apiKey) return { apiKey: creds.apiKey, ownKey: true };
  const platform = process.env[cloudProvider(provider)!.platformEnv];
  return platform ? { apiKey: platform, ownKey: false } : null;
}

export async function requireProviderKey(businessId: string, provider: CloudProvider) {
  const key = await providerKey(businessId, provider);
  if (!key) {
    const name = cloudProvider(provider)!.name;
    throw new BadRequestException(`No ${name} API key. Add one under Settings → AI Models, or pick another model.`);
  }
  return key;
}

/** Kept for callers that only need to know whether Claude is usable. */
export async function anthropicApiKey(businessId: string): Promise<string | null> {
  return (await providerKey(businessId, "anthropic"))?.apiKey ?? null;
}

// When the business hasn't picked a default model, the first of these with a usable key wins.
const DEFAULT_FALLBACKS = {
  /** Agents do multi-step tool work: the capable models. */
  capable: ["claude-opus-5-5", "gpt-6.1-sol", "gemini-4-argon"],
  /** App helpers and drafts: cheap, fast models. */
  cheap: ["claude-haiku-4-5", "gemini-3.5-flash-lite", "gpt-6-luna"],
};

async function usable(businessId: string, model: AgentModel | undefined): Promise<boolean> {
  if (!model) return false;
  return model.provider === "ollama" || !!(await providerKey(businessId, model.provider));
}

/**
 * The model to use when nothing more specific was chosen: the business's
 * default (Settings → AI Models) if it's usable, else the first usable cloud
 * model for the kind of work, else null (callers fall back to the local model).
 */
export async function defaultModelFor(businessId: string, kind: keyof typeof DEFAULT_FALLBACKS): Promise<AgentModel | null> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { defaultModel: true } });
  const chosen = business?.defaultModel ? findModel(business.defaultModel) : undefined;
  if (chosen && (await usable(businessId, chosen))) return chosen;
  for (const id of DEFAULT_FALLBACKS[kind]) {
    const model = findModel(id);
    if (await usable(businessId, model)) return model!;
  }
  return null;
}

let ollamaCheck: { at: number; ok: boolean } | null = null;
/** Whether the local Ollama server answers (cached for a minute). */
export async function ollamaReachable() {
  if (ollamaCheck && Date.now() - ollamaCheck.at < 60_000) return ollamaCheck.ok;
  const ok = await fetch(`${process.env.OLLAMA_URL ?? "http://localhost:11434"}/api/tags`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);
  ollamaCheck = { at: Date.now(), ok };
  return ok;
}

export interface ModelAvailability {
  id: string;
  label: string;
  provider: ProviderName;
  description: string;
  pricing: AgentModel["pricing"];
  available: boolean;
  /** Whose key it runs on: the business's own, Suuper's, or the local server. */
  keySource?: "business" | "platform" | "local";
  unavailableReason?: string;
}

/** Every model, and whether this business can use it right now. */
export async function modelAvailability(businessId: string): Promise<ModelAvailability[]> {
  const [keys, ollamaUp] = await Promise.all([
    Promise.all(CLOUD_PROVIDERS.map(async (p) => [p.key, await providerKey(businessId, p.key)] as const)),
    ollamaReachable(),
  ]);
  const keyOf = new Map(keys);
  return AGENT_MODELS.map((m) => {
    const base = { id: m.id, label: m.label, provider: m.provider, description: m.description, pricing: m.pricing };
    if (m.provider === "ollama") {
      return { ...base, available: ollamaUp, keySource: "local" as const, unavailableReason: ollamaUp ? undefined : "The local Ollama server isn't reachable." };
    }
    const key = keyOf.get(m.provider);
    return key
      ? { ...base, available: true, keySource: key.ownKey ? ("business" as const) : ("platform" as const) }
      : { ...base, available: false, unavailableReason: `Add your ${cloudProvider(m.provider)!.name} key under Settings → AI Models to use ${m.label}.` };
  });
}
