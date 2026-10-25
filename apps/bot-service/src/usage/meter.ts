import { AsyncLocalStorage } from "node:async_hooks";
import { Logger } from "@nestjs/common";
import { prisma } from "@platform/database";
import { chatWithUsage, type ChatOptions, type ChatTurn } from "@platform/shared-ai";
import type { UsageFeature } from "@platform/shared-types";

// Every model call in bot-service is recorded as a UsageEvent. Callers mark
// the business and feature once with withUsage(); providers and meteredChat
// pick that up, so tool loops and nested calls are counted without passing
// ids through every layer.

interface UsageContext {
  businessId: string;
  feature: UsageFeature;
}

const context = new AsyncLocalStorage<UsageContext>();
const logger = new Logger("UsageMeter");

export function withUsage<T>(businessId: string, feature: UsageFeature, fn: () => Promise<T>): Promise<T> {
  return context.run({ businessId, feature }, fn);
}

/** One model call. Best-effort: a failed write is logged, never thrown into the chat or run. */
export function recordAiCall(model: string, provider: "anthropic" | "ollama", usage: { inputTokens: number; outputTokens: number }) {
  const ctx = context.getStore();
  if (!ctx) {
    logger.warn(`Unmetered ${provider} call to ${model}: no withUsage() around it`);
    return;
  }
  void prisma.usageEvent
    .create({
      data: {
        businessId: ctx.businessId,
        type: "ai_call",
        feature: ctx.feature,
        model,
        provider,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    })
    .catch((err) => logger.warn(`Couldn't record usage for ${ctx.businessId}: ${(err as Error).message}`));
}

/** A bot answered someone (counts toward the plan's bot replies). */
export function recordBotReply(businessId: string) {
  void prisma.usageEvent
    .create({ data: { businessId, type: "bot_reply", feature: "bot" } })
    .catch((err) => logger.warn(`Couldn't record a bot reply for ${businessId}: ${(err as Error).message}`));
}

/** shared-ai's chat() for the local model, recorded against the current context. */
export async function meteredChat(messages: ChatTurn[], model?: string, options?: ChatOptions): Promise<string> {
  const result = await chatWithUsage(messages, model, options);
  recordAiCall(result.model, "ollama", result.usage);
  return result.content;
}
