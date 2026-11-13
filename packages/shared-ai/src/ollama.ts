// Local, free embeddings + chat model runtime (see infra/docker-compose.yml).
// Kept as a thin client so a paid provider (Claude, Voyage) can sit behind
// the same shape later without touching callers — see docs/ARCHITECTURE.md's
// "single abstraction point" principle for the model layer.
const baseUrl = () => process.env.OLLAMA_URL ?? "http://localhost:11434";
const embeddingModel = () => process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text";
const defaultChatModel = () => process.env.OLLAMA_CHAT_MODEL ?? "llama3.2:3b";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function embed(text: string): Promise<number[]> {
  const response = await fetch(`${baseUrl()}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: embeddingModel(), prompt: text }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embeddings request failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { embedding: number[] };
  return data.embedding;
}

/** Embeds many texts with bounded concurrency (Ollama serves one request at a time per model). */
export async function embedBatch(texts: string[], concurrency = 4): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  let next = 0;
  async function drain() {
    while (next < texts.length) {
      const i = next++;
      results[i] = await embed(texts[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, drain));
  return results;
}

/** `format: "json"` makes Ollama return a single JSON value (for structured output); `maxTokens`
 * caps the reply length, `contextTokens` widens the context window for long prompts (Ollama's
 * default is small and silently drops the start of the prompt) and `timeoutMs` aborts a slow
 * request (all off by default). */
export interface ChatOptions {
  format?: "json";
  maxTokens?: number;
  contextTokens?: number;
  timeoutMs?: number;
}

export async function chat(messages: ChatTurn[], model?: string, options: ChatOptions = {}): Promise<string> {
  return (await chatWithUsage(messages, model, options)).content;
}

/** chat(), plus the model that answered and its token counts (for metering). */
export async function chatWithUsage(
  messages: ChatTurn[],
  model?: string,
  options: ChatOptions = {},
): Promise<{ content: string; model: string; usage: { inputTokens: number; outputTokens: number } }> {
  let modelName = model ?? defaultChatModel();
  const modelOptions = {
    ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
    ...(options.contextTokens ? { num_ctx: options.contextTokens } : {}),
  };
  const send = (name: string) =>
    fetch(`${baseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: name,
        messages,
        stream: false,
        ...(options.format ? { format: options.format } : {}),
        ...(Object.keys(modelOptions).length > 0 ? { options: modelOptions } : {}),
      }),
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    });
  let response = await send(modelName);
  const fallback = await installedFallback(response, modelName);
  if (fallback) {
    modelName = fallback;
    response = await send(modelName);
  }
  if (!response.ok) {
    throw new Error(`Ollama chat request failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as {
    message: { role: string; content: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  return {
    content: data.message.content,
    model: modelName,
    usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
  };
}

/**
 * A bot can be saved with a local model this server hasn't pulled (e.g. llama3.2:3b on a small
 * VPS that only runs llama3.2:1b). When Ollama answers 404 "model not found" for such a model,
 * returns the server's configured OLLAMA_CHAT_MODEL to retry with; otherwise null, leaving the
 * response untouched.
 */
export async function installedFallback(response: Response, model: string): Promise<string | null> {
  const configured = process.env.OLLAMA_CHAT_MODEL;
  if (response.status !== 404 || !configured || configured === model) return null;
  if (!/not found/i.test(await response.clone().text())) return null;
  await response.body?.cancel();
  console.warn(`[ollama] model '${model}' is not installed; answering with '${configured}' instead`);
  return configured;
}

/** Formats an embedding for a raw-SQL pgvector literal, e.g. writing/querying Product.embedding. */
export function toPgVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
