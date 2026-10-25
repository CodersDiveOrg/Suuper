import OpenAI from "openai";
import type { AgentModel } from "../models";
import type { ContentBlockParam, MessageParam, ModelProvider, TurnRequest, TurnResult } from "./types";
import { recordAiCall } from "../../../usage/meter";

type InputItem = OpenAI.Responses.ResponseInputItem;
type OutputItem = OpenAI.Responses.ResponseOutputItem;

const MAX_OUTPUT_TOKENS = 32_000;

function toolResultText(block: Extract<ContentBlockParam, { type: "tool_result" }>): string {
  const text =
    typeof block.content === "string"
      ? block.content
      : (block.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
  return block.is_error ? `Error: ${text}` : text;
}

/**
 * OpenAI through the Responses API (newer GPT models only take tools there).
 * Stateless (store: false): each call sends the whole history. Reasoning models
 * need their encrypted reasoning items sent back with tool results, so a turn's
 * raw output items are kept on this instance (one instance per run) and replayed
 * in place of the Anthropic-format copy. Older history, from before this
 * instance, is sent as plain messages and function calls.
 */
export class OpenAIProvider implements ModelProvider {
  private readonly client: OpenAI;
  /** tool_use id (OpenAI call_id) -> the raw output items of the turn that made the call. */
  private readonly turnItems = new Map<string, OutputItem[]>();

  constructor(
    apiKey: string,
    private readonly model: AgentModel,
    private readonly ownKey = false,
  ) {
    this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async runTurn(request: TurnRequest, onText: (delta: string) => void): Promise<TurnResult> {
    const stream = await this.client.responses.create({
      model: request.model,
      instructions: request.system,
      input: this.toInput(request.messages),
      tools: request.tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description ?? null,
        parameters: tool.input_schema as Record<string, unknown>,
        // Our schemas allow optional fields, which strict mode doesn't.
        strict: false,
      })),
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      ...(this.model.effort ? { reasoning: { effort: this.model.effort } } : {}),
      stream: true,
    });

    let response: OpenAI.Responses.Response | undefined;
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") onText(event.delta);
      else if (event.type === "response.completed" || event.type === "response.incomplete") response = event.response;
      else if (event.type === "response.failed") throw new Error(`OpenAI: ${event.response.error?.message ?? "the response failed"}`);
      else if (event.type === "error") throw new Error(`OpenAI: ${event.message}`);
    }
    if (!response) throw new Error("OpenAI: the stream ended without a response");

    const content: ContentBlockParam[] = [];
    let refused = false;
    for (const item of response.output) {
      if (item.type === "message") {
        for (const part of item.content) {
          if (part.type === "output_text" && part.text) content.push({ type: "text", text: part.text });
          if (part.type === "refusal") {
            refused = true;
            content.push({ type: "text", text: part.refusal });
          }
        }
      } else if (item.type === "function_call") {
        let input: unknown = {};
        try {
          input = item.arguments ? JSON.parse(item.arguments) : {};
        } catch {
          // Left empty: the runtime validates tool inputs and reports the error back to the model.
        }
        content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
        this.turnItems.set(item.call_id, response.output);
      }
    }

    const usage = { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 };
    recordAiCall(request.model, "openai", usage, this.ownKey);
    const hasCalls = content.some((b) => b.type === "tool_use");
    const stopReason = refused
      ? "refusal"
      : response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens"
        ? "max_tokens"
        : hasCalls
          ? "tool_use"
          : "end_turn";
    return { content, stopReason, usage };
  }

  /** Anthropic-format history -> Responses input items. */
  private toInput(messages: MessageParam[]): InputItem[] {
    const out: InputItem[] = [];
    for (const message of messages) {
      const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content } as const] : message.content;
      if (message.role === "assistant") {
        const firstCall = blocks.find((b) => b.type === "tool_use");
        const raw = firstCall && firstCall.type === "tool_use" ? this.turnItems.get(firstCall.id) : undefined;
        if (raw) {
          // Output items are valid input items; this keeps the encrypted reasoning attached.
          out.push(...(raw as unknown as InputItem[]));
          continue;
        }
        const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        if (text) out.push({ role: "assistant", content: text });
        for (const b of blocks) {
          if (b.type === "tool_use") {
            out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
          }
        }
        continue;
      }
      const text: string[] = [];
      for (const b of blocks) {
        if (b.type === "text") text.push(b.text);
        if (b.type === "tool_result") out.push({ type: "function_call_output", call_id: b.tool_use_id, output: toolResultText(b) });
      }
      if (text.length) out.push({ role: "user", content: text.join("\n") });
    }
    return out;
  }
}
