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

export async function chat(messages: ChatTurn[], model?: string): Promise<string> {
  const response = await fetch(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: model ?? defaultChatModel(), messages, stream: false }),
  });
  if (!response.ok) {
    throw new Error(`Ollama chat request failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { message: { role: string; content: string } };
  return data.message.content;
}

/** Formats an embedding for a raw-SQL pgvector literal, e.g. writing/querying Product.embedding. */
export function toPgVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
