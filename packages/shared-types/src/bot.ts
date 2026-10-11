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
  sourceType: "upload" | "crawl" | "connector";
  /** The store URL to ingest, for sourceType "crawl". */
  sourceUrl?: string;
  status: "syncing" | "ready" | "error";
  /** Set when status is "error". */
  errorMessage?: string;
  productCount: number;
  syncedAt?: string;
  createdAt: string;
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
}
