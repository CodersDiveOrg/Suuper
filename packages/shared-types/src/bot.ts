import { BusinessId } from "./business";

export interface Bot {
  id: string;
  businessId: BusinessId;
  name: string;
  systemPrompt: string;
  model: string;
  mcpServerIds: string[];
  knowledgeBaseIds: string[];
  createdAt: string;
}

/** A bot's public embed widget configuration. widgetKey is public/revocable, not a secret. */
export interface WidgetSettings {
  widgetEnabled: boolean;
  widgetKey: string;
  allowedOrigins: string[];
}

export interface McpServer {
  id: string;
  businessId: BusinessId;
  name: string;
  /** "hosted": platform runs this server for the business. "external": business points to a server they run themselves. */
  mode: "hosted" | "external";
  endpointUrl?: string;
  status: "provisioning" | "running" | "stopped" | "error";
  createdAt: string;
}

export interface KnowledgeBase {
  id: string;
  businessId: BusinessId;
  name: string;
  /** "crawl": a store's product catalog. "documents": files, FAQs, text and websites. */
  sourceType: "crawl" | "documents";
  /** The store URL to ingest, for sourceType "crawl". */
  sourceUrl?: string;
  status: "syncing" | "ready" | "error";
  /** Set when status is "error". */
  errorMessage?: string;
  productCount: number;
  documentCount: number;
  syncedAt?: string;
  createdAt: string;
}

export type KnowledgeDocumentType = "file" | "faq" | "text" | "website";

export interface FaqItem {
  question: string;
  answer: string;
}

/** One source added to a "documents" knowledge base. */
export interface KnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  type: KnowledgeDocumentType;
  title: string;
  sourceUrl?: string;
  fileName?: string;
  status: "processing" | "ready" | "error";
  errorMessage?: string;
  chunkCount: number;
  createdAt: string;
  processedAt?: string;
}

/** Body of POST /businesses/current/knowledge-bases/:id/documents. */
export type AddKnowledgeDocumentRequest =
  | { type: "file"; fileName: string; mimeType?: string; dataBase64: string }
  | { type: "faq"; title?: string; items: FaqItem[] }
  | { type: "text"; title: string; text: string }
  | { type: "website"; url: string; title?: string };

/** A retrieved passage from a document knowledge base. */
export interface KnowledgePassage {
  id: string;
  knowledgeBaseId: string;
  documentId: string;
  title: string;
  content: string;
  sourceUrl?: string;
}

/** Response of knowledge-service's search: catalog matches plus document passages. */
export interface KnowledgeSearchResult {
  products: Product[];
  passages: KnowledgePassage[];
}

/** One item ingested from a KnowledgeBase's store URL. */
export interface Product {
  id: string;
  businessId: BusinessId;
  knowledgeBaseId: string;
  externalId?: string;
  title: string;
  description?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productUrl: string;
  createdAt: string;
}

export interface ChatMessageRequest {
  message: string;
}

export interface ChatMessageResponse {
  reply: string;
  products: Product[];
  passages: KnowledgePassage[];
}
