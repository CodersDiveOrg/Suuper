import Anthropic from "@anthropic-ai/sdk";
import type { AgentModel } from "../models";
import type { ContentBlockParam, ModelProvider, TurnRequest, TurnResult } from "./types";
import { recordAiCall } from "../../../usage/meter";

const MAX_JSON_RETRIES = 2;

// Anthropic-hosted tools the agent can opt into.
const SERVER_TOOLS: Record<string, Anthropic.Beta.BetaToolUnion> = {
  web_search: { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  web_fetch: { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
};

/**
 * After a mid-output fallback, blocks before the last `fallback` marker came
 * from the model that declined. Replay rule: drop its thinking/tool_use and
 * unpaired server_tool_use blocks there; keep text and everything after.
 */
export function sanitizeFallbackContent(content: Anthropic.Beta.BetaContentBlock[]): ContentBlockParam[] {
  const boundary = content.map((b) => b.type).lastIndexOf("fallback" as never);
  if (boundary === -1) return content as ContentBlockParam[];
  const pairedServerToolIds = new Set(
    content
      .filter((b) => b.type.endsWith("_tool_result") && "tool_use_id" in b)
      .map((b) => (b as { tool_use_id: string }).tool_use_id),
  );
  return content.filter((block, i) => {
    if (i >= boundary) return true;
    if (block.type === "text") return true;
    if (block.type === "server_tool_use") return pairedServerToolIds.has(block.id);
    return block.type.endsWith("_tool_result");
  }) as ContentBlockParam[];
}

export class AnthropicProvider implements ModelProvider {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: AgentModel,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async runTurn(request: TurnRequest, onText: (delta: string) => void): Promise<TurnResult> {
    const tools: Anthropic.Beta.BetaToolUnion[] = [
      // Stream large tool inputs as they're generated; the runtime validates
      // every parsed input before running a tool.
      ...request.tools.map((tool) => ({ ...tool, eager_input_streaming: true })),
      ...request.serverTools.flatMap((key) => (SERVER_TOOLS[key] ? [SERVER_TOOLS[key]] : [])),
    ];

    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream({
        model: request.model,
        max_tokens: 64000,
        system: request.system,
        messages: request.messages,
        tools,
        // Auto-cache the conversation prefix; history is append-only so it stays valid.
        cache_control: { type: "ephemeral" },
        ...(this.model.effort ? { output_config: { effort: this.model.effort } } : {}),
        ...(this.model.fallbacks
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      });
      stream.on("text", onText);

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        // Only an unparseable streamed tool input is retried; API errors propagate.
        if (err instanceof Anthropic.APIError || attempt >= MAX_JSON_RETRIES) throw err;
        continue;
      }

      const usage = {
        inputTokens:
          message.usage.input_tokens +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
      };
      recordAiCall(request.model, "anthropic", usage);
      return { content: sanitizeFallbackContent(message.content), stopReason: message.stop_reason ?? "end_turn", usage };
    }
  }
}
