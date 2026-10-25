// Bots → Conversations inbox (GET /businesses/current/conversations).

export type ConversationSource = "widget" | "playground" | "whatsapp" | "telegram";

export interface ConversationSummary {
  id: string;
  botId: string;
  botName: string;
  source: ConversationSource;
  /** Widget only: the site the chat ran on. */
  origin?: string;
  /** WhatsApp number or Telegram chat id. */
  contact?: string;
  contactName?: string;
  /** WhatsApp/Telegram: a team member can reply and take over from the inbox. */
  canReply: boolean;
  /** Set while a team member has the chat; the bot doesn't answer. */
  humanTakeoverAt?: string;
  messageCount: number;
  /** Replies that couldn't answer, or failed. */
  issueCount: number;
  startedAt: string;
  lastMessageAt: string;
  lastMessage?: { role: ConversationMessage["role"]; content: string };
}

export interface ConversationList {
  items: ConversationSummary[];
  /** Pass as `before` to load the next page; absent on the last page. */
  nextBefore?: string;
}

export interface ConversationMessage {
  id: string;
  /** "agent": a team member replying from the inbox. */
  role: "user" | "assistant" | "agent";
  content: string;
  outcome?: "answered" | "unanswered" | "error";
  durationMs?: number;
  createdAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[];
}
