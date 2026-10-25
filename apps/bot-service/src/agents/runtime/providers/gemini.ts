import { randomUUID } from "node:crypto";
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import type { ContentBlockParam, MessageParam, ModelProvider, TurnRequest, TurnResult } from "./types";
import { recordAiCall } from "../../../usage/meter";

const MAX_OUTPUT_TOKENS = 32_000;
// Google's documented placeholder for function calls the API didn't generate in
// this session (history from before this run, or from another model).
const SKIP_SIGNATURE = "skip_thought_signature_validator";
// Finish reasons where Gemini declined to answer.
const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

function toolResultText(block: Extract<ContentBlockParam, { type: "tool_result" }>): string {
  return typeof block.content === "string"
    ? block.content
    : (block.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
}

/**
 * Gemini through the Gen AI SDK. Thinking models attach a thought signature to
 * their function calls that must be sent back with the call; they're kept on
 * this instance (one instance per run) by tool_use id.
 */
export class GeminiProvider implements ModelProvider {
  private readonly client: GoogleGenAI;
  /** tool_use id -> the thoughtSignature Gemini sent with that function call (only the first of parallel calls has one). */
  private readonly signatures = new Map<string, string | undefined>();

  constructor(
    apiKey: string,
    private readonly ownKey = false,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async runTurn(request: TurnRequest, onText: (delta: string) => void): Promise<TurnResult> {
    const stream = await this.client.models.generateContentStream({
      model: request.model,
      contents: this.toContents(request.messages),
      config: {
        systemInstruction: request.system,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        ...(request.tools.length
          ? {
              tools: [
                {
                  functionDeclarations: request.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parametersJsonSchema: tool.input_schema,
                  })),
                },
              ],
            }
          : {}),
      },
    });

    let text = "";
    const calls: { id: string; name: string; args: unknown; signature?: string }[] = [];
    let finishReason: string | undefined;
    let usage = { inputTokens: 0, outputTokens: 0 };
    for await (const chunk of stream) {
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought) continue;
        if (part.functionCall?.name) {
          calls.push({ id: `toolu_${randomUUID().replace(/-/g, "")}`, name: part.functionCall.name, args: part.functionCall.args ?? {}, signature: part.thoughtSignature });
        } else if (part.text) {
          text += part.text;
          onText(part.text);
        }
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
        };
      }
    }

    const content: ContentBlockParam[] = [];
    if (text) content.push({ type: "text", text });
    for (const call of calls) {
      this.signatures.set(call.id, call.signature);
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
    }
    recordAiCall(request.model, "gemini", usage, this.ownKey);
    const stopReason =
      finishReason && BLOCKED.has(finishReason)
        ? "refusal"
        : finishReason === "MAX_TOKENS"
          ? "max_tokens"
          : calls.length
            ? "tool_use"
            : "end_turn";
    return { content, stopReason, usage };
  }

  /** Anthropic-format history -> Gemini contents. */
  private toContents(messages: MessageParam[]): Content[] {
    const out: Content[] = [];
    const toolNames = new Map<string, string>();
    for (const message of messages) {
      const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content } as const] : message.content;
      const parts: Part[] = [];
      if (message.role === "assistant") {
        let first = true;
        for (const b of blocks) {
          if (b.type === "text" && b.text) parts.push({ text: b.text });
          if (b.type === "tool_use") {
            toolNames.set(b.id, b.name);
            const known = this.signatures.has(b.id);
            const signature = known ? this.signatures.get(b.id) : first ? SKIP_SIGNATURE : undefined;
            parts.push({ functionCall: { name: b.name, args: (b.input ?? {}) as Record<string, unknown> }, ...(signature ? { thoughtSignature: signature } : {}) });
            first = false;
          }
        }
        if (parts.length) out.push({ role: "model", parts });
        continue;
      }
      for (const b of blocks) {
        if (b.type === "text" && b.text) parts.push({ text: b.text });
        if (b.type === "tool_result") {
          const result = toolResultText(b);
          parts.push({
            functionResponse: {
              name: toolNames.get(b.tool_use_id) ?? "tool",
              response: b.is_error ? { error: result } : { output: result },
            },
          });
        }
      }
      if (parts.length) out.push({ role: "user", parts });
    }
    return out;
  }
}
