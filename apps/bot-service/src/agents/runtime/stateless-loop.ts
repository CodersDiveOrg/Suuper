import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageParam, ModelProvider } from "./providers/types";
import type { ToolSet } from "./toolset";

/**
 * A tool loop with no persistence, for single-turn callers (bots and their
 * public widget). Same rules as AgentRunner: all tool results go back in one
 * message, never run tool calls cut off by max_tokens, stop on refusal.
 */
export async function runStatelessLoop(params: {
  provider: ModelProvider;
  model: string;
  system: string;
  userContent: string;
  toolSet: ToolSet;
  maxSteps: number;
}) {
  const { provider, model, system, toolSet } = params;
  const messages: MessageParam[] = [{ role: "user", content: params.userContent }];
  const toolCalls: { name: string; isError: boolean }[] = [];
  let reply = "";

  for (let step = 0; step < params.maxSteps; step++) {
    const turn = await provider.runTurn(
      { model, system, messages, tools: toolSet.clientTools, serverTools: toolSet.serverTools },
      () => undefined,
    );
    const text = turn.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (text) reply = text;
    if (turn.content.length) messages.push({ role: "assistant", content: turn.content });
    if (turn.stopReason === "refusal") break;
    if (turn.stopReason === "pause_turn") continue;

    const uses = turn.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use");
    if (turn.stopReason === "max_tokens" && uses.length) break;
    if (turn.stopReason !== "tool_use" || uses.length === 0) break;

    const results: ContentBlockParam[] = await Promise.all(
      uses.map(async (call) => {
        const result = await toolSet.execute(call.name, call.input);
        toolCalls.push({ name: call.name, isError: !!result.isError });
        return { type: "tool_result" as const, tool_use_id: call.id, content: result.content, is_error: result.isError || undefined };
      }),
    );
    messages.push({ role: "user", content: results });
  }
  return { reply, toolCalls };
}
