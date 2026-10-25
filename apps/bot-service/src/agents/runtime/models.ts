import { BadRequestException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { decryptJson } from "@platform/shared-auth";

export type ProviderName = "anthropic" | "ollama";

export interface AgentModel {
  id: string;
  label: string;
  provider: ProviderName;
  description: string;
  /** Anthropic only: output_config.effort to send (omitted when the model doesn't take effort). */
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

/** The business's own Anthropic key (Integrations → Anthropic) wins over the platform key. */
export async function anthropicApiKey(businessId: string): Promise<string | null> {
  const creds = await integrationCredentials(businessId, "anthropic");
  return creds?.apiKey || process.env.ANTHROPIC_API_KEY || null;
}

export async function requireAnthropicKey(businessId: string): Promise<string> {
  const key = await anthropicApiKey(businessId);
  if (!key) {
    throw new BadRequestException(
      "No Anthropic API key. Connect the Anthropic integration (Integrations → Anthropic) or pick a local model.",
    );
  }
  return key;
}
