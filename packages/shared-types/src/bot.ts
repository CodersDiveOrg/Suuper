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

/** How the website widget looks. Stored on the bot; sites pick changes up on their next page load. */
export interface WidgetAppearance {
  /** Hex, e.g. "#4f46e5": launcher, header and the visitor's bubbles. */
  color: string;
  /** Panel header. */
  title: string;
  /** First message shown when the panel opens. */
  greeting: string;
  placeholder: string;
  position: "bottom-right" | "bottom-left";
}

export const DEFAULT_WIDGET_APPEARANCE: WidgetAppearance = {
  color: "#111827",
  title: "Chat with us",
  greeting: "Hi! How can I help you today?",
  placeholder: "Type a message…",
  position: "bottom-right",
};

/** A bot's public embed widget configuration. widgetKey is public/revocable, not a secret. */
export interface WidgetSettings {
  widgetEnabled: boolean;
  widgetKey: string;
  allowedOrigins: string[];
  appearance: WidgetAppearance;
}

/** What the embed script loads before it renders (public, origin-checked). */
export type PublicWidgetConfig = WidgetAppearance & { botName: string };

/** One bot on the Widgets page: its settings plus the last 30 days of widget chats. */
export interface WidgetOverview extends WidgetSettings {
  botId: string;
  botName: string;
  stats: {
    conversations: number;
    messages: number;
    /** Conversations with at least one reply the bot couldn't answer. */
    withIssues: number;
    lastConversationAt: string | null;
    /** Sites the widget actually ran on, busiest first. */
    origins: { origin: string; conversations: number }[];
  };
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
  /** Cosine similarity to the query (0–1, higher is closer). */
  score?: number;
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

export type ChannelProvider = "whatsapp" | "telegram";

/** A messaging integration routed to one bot (GET /businesses/current/bots/channels). */
export interface BotChannel {
  provider: ChannelProvider;
  /** The integration is connected and enabled under Integrations. */
  integrationConnected: boolean;
  channel: {
    id: string;
    botId: string;
    enabled: boolean;
    /** Paste into the provider (WhatsApp) — Telegram is registered automatically. */
    webhookUrl: string;
    /** WhatsApp only: the verify token Meta asks for alongside the callback URL. */
    verifyToken?: string;
    messageCount: number;
    lastMessageAt?: string;
    lastError?: string;
    createdAt: string;
  } | null;
}

export interface ChannelMessage {
  id: string;
  contact: string;
  contactName?: string;
  direction: "in" | "out";
  text: string;
  error?: string;
  createdAt: string;
}
