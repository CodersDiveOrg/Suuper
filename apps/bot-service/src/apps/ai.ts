import { defaultModelFor, providerKey } from "../agents/runtime/models";
import { createProvider } from "../agents/runtime/providers";
import { runStatelessLoop } from "../agents/runtime/stateless-loop";
import { buildToolSet } from "../agents/runtime/toolset";
import { meteredChat, withUsage } from "../usage/meter";
import { assertWithinQuota, QuotaExceededException } from "../usage/quota";

// The AI helpers inside apps (ask your data, suggestions, drafts) make single
// completions: the business's default model (Settings → AI Models), else a cheap
// cloud model it has a key for, else the local model. Prompts can be long (records + knowledge), so the local model
// gets a wider context window.

const CLOUD_TIMEOUT_MS = 45_000;
const LOCAL_TIMEOUT_MS = 120_000;
const LOCAL_CONTEXT_TOKENS = 8192;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms))]);
}

export async function complete(businessId: string, system: string, prompt: string, maxTokens = 600): Promise<{ text: string; provider: "claude" | "cloud" | "local" }> {
  return withUsage(businessId, "app", () => completeMetered(businessId, system, prompt, maxTokens));
}

async function completeMetered(businessId: string, system: string, prompt: string, maxTokens: number): Promise<{ text: string; provider: "claude" | "cloud" | "local" }> {
  let model = await defaultModelFor(businessId, "cheap");
  // Out of AI credits: app helpers keep working on the free local model instead of failing.
  if (model && model.provider !== "ollama" && !(await providerKey(businessId, model.provider))?.ownKey) {
    try {
      await assertWithinQuota(businessId, ["ai_credits"]);
    } catch (err) {
      if (!(err instanceof QuotaExceededException)) throw err;
      model = null;
    }
  }
  if (model && model.provider !== "ollama") {
    const toolSet = await buildToolSet({ businessId, provider: model.provider, builtInTools: [], knowledgeBaseIds: [], mcpServerIds: [], source: "agent" });
    const { reply } = await withTimeout(
      runStatelessLoop({ provider: await createProvider(businessId, model), model: model.id, system, userContent: prompt, toolSet, maxSteps: 1 }),
      CLOUD_TIMEOUT_MS,
    );
    return { text: reply.trim(), provider: model.provider === "anthropic" ? "claude" : "cloud" };
  }
  const reply = await meteredChat(
    [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    undefined,
    { maxTokens, contextTokens: LOCAL_CONTEXT_TOKENS, timeoutMs: LOCAL_TIMEOUT_MS },
  );
  return { text: reply.trim(), provider: "local" };
}
