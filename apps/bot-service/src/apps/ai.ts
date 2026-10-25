import { anthropicApiKey, findModel } from "../agents/runtime/models";
import { AnthropicProvider } from "../agents/runtime/providers/anthropic";
import { runStatelessLoop } from "../agents/runtime/stateless-loop";
import { buildToolSet } from "../agents/runtime/toolset";
import { meteredChat, withUsage } from "../usage/meter";
import { assertWithinQuota } from "../usage/quota";

// The AI helpers inside apps (ask your data, suggestions, drafts) make single
// completions: Claude Haiku when the business or platform has a key, else the
// local model. Prompts can be long (records + knowledge), so the local model
// gets a wider context window.

const CLAUDE_MODEL = "claude-haiku-4-5";
const CLAUDE_TIMEOUT_MS = 45_000;
const LOCAL_TIMEOUT_MS = 120_000;
const LOCAL_CONTEXT_TOKENS = 8192;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms))]);
}

export async function complete(businessId: string, system: string, prompt: string, maxTokens = 600): Promise<{ text: string; provider: "claude" | "local" }> {
  await assertWithinQuota(businessId, ["ai_tokens"]);
  return withUsage(businessId, "app", () => completeMetered(businessId, system, prompt, maxTokens));
}

async function completeMetered(businessId: string, system: string, prompt: string, maxTokens: number): Promise<{ text: string; provider: "claude" | "local" }> {
  const key = await anthropicApiKey(businessId);
  const model = key ? findModel(CLAUDE_MODEL) : undefined;
  if (key && model) {
    const toolSet = await buildToolSet({ businessId, provider: "anthropic", builtInTools: [], knowledgeBaseIds: [], mcpServerIds: [], source: "agent" });
    const { reply } = await withTimeout(
      runStatelessLoop({ provider: new AnthropicProvider(key, model), model: CLAUDE_MODEL, system, userContent: prompt, toolSet, maxSteps: 1 }),
      CLAUDE_TIMEOUT_MS,
    );
    return { text: reply.trim(), provider: "claude" };
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
