import axios from "axios";
import { signBusinessToken } from "@platform/shared-auth";
import { loadServiceConfig } from "@platform/shared-config";
import type { KnowledgeSearchResult } from "@platform/shared-types";

const config = loadServiceConfig("bot-service", 3002);

const EMPTY: KnowledgeSearchResult = { products: [], passages: [] };

/** Calls knowledge-service directly (internal HTTP, per docs/ARCHITECTURE.md), forwarding a
 * business-scoped token. Retrieval failing shouldn't fail the chat, so errors come back empty. */
export async function searchKnowledge(
  knowledgeBaseIds: string[],
  query: string,
  authorization: string | undefined,
): Promise<KnowledgeSearchResult> {
  if (knowledgeBaseIds.length === 0) return EMPTY;
  try {
    const response = await axios.post<KnowledgeSearchResult>(
      `${config.knowledgeServiceUrl}/businesses/current/knowledge-bases/search`,
      { query, knowledgeBaseIds },
      { headers: authorization ? { Authorization: authorization } : undefined },
    );
    return { products: response.data.products ?? [], passages: response.data.passages ?? [] };
  } catch {
    return EMPTY;
  }
}

/** The user's message with retrieved products and passages laid out above it. */
export function buildKnowledgePrompt(message: string, { products, passages }: KnowledgeSearchResult, questionLabel: string): string {
  if (products.length === 0 && passages.length === 0) {
    return `${message}\n\n(Nothing relevant was found in the knowledge base — say so rather than inventing an answer.)`;
  }
  const sections: string[] = [];
  if (passages.length > 0) {
    const context = passages
      .map((passage, i) => `[${i + 1}] ${passage.title}${passage.sourceUrl ? ` (${passage.sourceUrl})` : ""}\n${passage.content}`)
      .join("\n\n");
    sections.push(`Relevant information from the business's knowledge base:\n${context}`);
  }
  if (products.length > 0) {
    const catalog = products
      .map((product, i) => {
        const price =
          product.price !== undefined ? ` — ${product.price} ${product.currency ?? ""}`.trimEnd() : "";
        const description = product.description ? `\n   ${product.description}` : "";
        return `${i + 1}. ${product.title}${price}${description}`;
      })
      .join("\n");
    sections.push(`Relevant products:\n${catalog}`);
  }
  return `${sections.join("\n\n")}\n\nAnswer only from the information above when it covers the question, and don't add details it doesn't state. Reply directly in your own words, without labels like "Q:" or "A:".\n\n${questionLabel}: ${message}`;
}

/** Searches a business's knowledge as bot-service itself (apps' AI helpers), with a short-lived read token. */
export function searchKnowledgeFor(businessId: string, knowledgeBaseIds: string[], query: string): Promise<KnowledgeSearchResult> {
  const token = signBusinessToken({ userId: "bot-service", businessId, role: "member", permissions: ["knowledge:read"] });
  return searchKnowledge(knowledgeBaseIds, query, `Bearer ${token}`);
}
