import { randomUUID } from "node:crypto";
import type { ContentBlockParam, MessageParam, ModelProvider, TurnRequest, TurnResult } from "./types";

const baseUrl = () => process.env.OLLAMA_URL ?? "http://localhost:11434";

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

interface OllamaChunk {
  message?: OllamaMessage;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Anthropic-format history -> Ollama chat messages. */
function toOllamaMessages(system: string, messages: MessageParam[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content } as const] : message.content;
    if (message.role === "assistant") {
      const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const toolCalls = blocks.flatMap((b) => {
        if (b.type !== "tool_use") return [];
        toolNames.set(b.id, b.name);
        return [{ function: { name: b.name, arguments: (b.input ?? {}) as Record<string, unknown> } }];
      });
      out.push({ role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    const text: string[] = [];
    for (const b of blocks) {
      if (b.type === "text") text.push(b.text);
      if (b.type === "tool_result") {
        const content =
          typeof b.content === "string"
            ? b.content
            : (b.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
        out.push({ role: "tool", content, tool_name: toolNames.get(b.tool_use_id) });
      }
    }
    if (text.length) out.push({ role: "user", content: text.join("\n") });
  }
  return out;
}

export class OllamaProvider implements ModelProvider {
  async runTurn(request: TurnRequest, onText: (delta: string) => void): Promise<TurnResult> {
    const response = await fetch(`${baseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        messages: toOllamaMessages(request.system, request.messages),
        tools: request.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
    }

    // NDJSON stream: one JSON object per line.
    let text = "";
    const toolCalls: NonNullable<OllamaMessage["tool_calls"]> = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const data = JSON.parse(line) as OllamaChunk;
        if (data.error) throw new Error(`Ollama error: ${data.error}`);
        if (data.message?.content) {
          text += data.message.content;
          onText(data.message.content);
        }
        if (data.message?.tool_calls) toolCalls.push(...data.message.tool_calls);
        if (data.done) usage = { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 };
      }
    }

    const content: ContentBlockParam[] = [];
    if (text) content.push({ type: "text", text });
    for (const call of toolCalls) {
      content.push({ type: "tool_use", id: `toolu_${randomUUID().replace(/-/g, "")}`, name: call.function.name, input: call.function.arguments ?? {} });
    }
    return { content, stopReason: toolCalls.length ? "tool_use" : "end_turn", usage };
  }
}
