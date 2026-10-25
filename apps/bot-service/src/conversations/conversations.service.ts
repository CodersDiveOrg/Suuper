import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma, type Prisma } from "@platform/database";
import type { ConversationDetail, ConversationList, ConversationSummary } from "@platform/shared-types";
import { ChannelsService, contactFromSessionKey } from "../channels/channels.service";

const PAGE_SIZE = 30;
const MAX_REPLY = 4096;
// Sources a team member can reply on from the inbox; widget and playground chats are read-only.
const REPLYABLE = new Set(["whatsapp", "telegram"]);

export interface ListConversationsQuery {
  botId?: string;
  source?: string;
  /** "1": only conversations with an unanswered or failed reply. */
  issues?: string;
  /** "1": only chats a team member has taken over. */
  takenOver?: string;
  q?: string;
  /** ISO lastMessageAt of the last item of the previous page. */
  before?: string;
  limit?: string;
}

type ConversationRow = Prisma.BotConversationGetPayload<{ include: { bot: { select: { name: true } } } }>;

@Injectable()
export class ConversationsService {
  constructor(private readonly channels: ChannelsService) {}

  async list(businessId: string, query: ListConversationsQuery): Promise<ConversationList> {
    const limit = Math.min(Math.max(Number(query.limit) || PAGE_SIZE, 1), 100);
    const q = query.q?.trim().slice(0, 100);
    const before = query.before ? new Date(query.before) : undefined;
    const where: Prisma.BotConversationWhereInput = {
      businessId,
      ...(query.botId ? { botId: query.botId } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.issues === "1" ? { issueCount: { gt: 0 } } : {}),
      ...(query.takenOver === "1" ? { humanTakeoverAt: { not: null } } : {}),
      ...(before && !Number.isNaN(before.getTime()) ? { lastMessageAt: { lt: before } } : {}),
      ...(q
        ? {
            OR: [
              { messages: { some: { content: { contains: q, mode: "insensitive" } } } },
              { sessionKey: { contains: q, mode: "insensitive" } },
              { origin: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const rows = await prisma.botConversation.findMany({
      where,
      include: { bot: { select: { name: true } } },
      orderBy: { lastMessageAt: "desc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const [lastMessages, names] = await Promise.all([this.lastMessages(page.map((c) => c.id)), this.contactNames(businessId, page)]);
    return {
      items: page.map((c) => ({ ...this.summary(c, names), lastMessage: lastMessages.get(c.id) })),
      nextBefore: rows.length > limit ? page[page.length - 1].lastMessageAt.toISOString() : undefined,
    };
  }

  async get(businessId: string, id: string): Promise<ConversationDetail> {
    const conversation = await this.require(businessId, id);
    const [messages, names] = await Promise.all([
      prisma.botMessage.findMany({ where: { conversationId: id }, orderBy: { createdAt: "asc" }, take: 500 }),
      this.contactNames(businessId, [conversation]),
    ]);
    return {
      ...this.summary(conversation, names),
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant" | "agent",
        content: m.content,
        outcome: (m.outcome as "answered" | "unanswered" | "error" | null) ?? undefined,
        durationMs: m.durationMs ?? undefined,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /** A team member's reply: sent on the channel, and the bot is paused for this chat. */
  async reply(businessId: string, id: string, text: unknown) {
    const body = typeof text === "string" ? text.trim() : "";
    if (!body) throw new BadRequestException("text is required");
    if (body.length > MAX_REPLY) throw new BadRequestException(`Replies are limited to ${MAX_REPLY} characters`);
    const conversation = await this.require(businessId, id);
    const contact = this.replyContact(conversation);
    await this.channels.sendAsAgent(businessId, conversation.source, contact, body);
    const now = new Date();
    await prisma.$transaction([
      prisma.botMessage.create({ data: { conversationId: id, role: "agent", content: body, createdAt: now } }),
      prisma.botConversation.update({
        where: { id },
        data: { messageCount: { increment: 1 }, lastMessageAt: now, humanTakeoverAt: conversation.humanTakeoverAt ?? now },
      }),
    ]);
    return this.get(businessId, id);
  }

  async setTakeover(businessId: string, id: string, active: unknown) {
    if (typeof active !== "boolean") throw new BadRequestException("active must be true or false");
    const conversation = await this.require(businessId, id);
    if (active) this.replyContact(conversation);
    await prisma.botConversation.update({ where: { id }, data: { humanTakeoverAt: active ? new Date() : null } });
    return this.get(businessId, id);
  }

  async remove(businessId: string, id: string) {
    await this.require(businessId, id);
    await prisma.botConversation.delete({ where: { id } });
  }

  private replyContact(conversation: ConversationRow): string {
    const contact = REPLYABLE.has(conversation.source) ? contactFromSessionKey(conversation.source, conversation.sessionKey) : null;
    if (!contact) throw new BadRequestException("Only WhatsApp and Telegram conversations can be answered from here");
    return contact;
  }

  private async lastMessages(ids: string[]) {
    const result = new Map<string, ConversationSummary["lastMessage"]>();
    if (ids.length === 0) return result;
    // Latest message per conversation in one query.
    const rows = await prisma.$queryRaw<{ conversationId: string; role: string; content: string; createdAt: Date }[]>`
      SELECT DISTINCT ON ("conversationId") "conversationId", "role", "content", "createdAt"
      FROM "BotMessage" WHERE "conversationId" = ANY(${ids}::text[])
      ORDER BY "conversationId", "createdAt" DESC`;
    for (const row of rows) {
      result.set(row.conversationId, { role: row.role as "user" | "assistant" | "agent", content: row.content.slice(0, 200) });
    }
    return result;
  }

  /** WhatsApp/Telegram display names come from the channel log. */
  private async contactNames(businessId: string, conversations: ConversationRow[]) {
    const contacts = conversations
      .map((c) => (REPLYABLE.has(c.source) ? contactFromSessionKey(c.source, c.sessionKey) : null))
      .filter((c): c is string => !!c);
    const names = new Map<string, string>();
    if (contacts.length === 0) return names;
    const rows = await prisma.channelMessage.findMany({
      where: { businessId, contact: { in: contacts }, contactName: { not: null } },
      distinct: ["contact"],
      orderBy: { createdAt: "desc" },
      select: { contact: true, contactName: true },
    });
    for (const row of rows) if (row.contactName) names.set(row.contact, row.contactName);
    return names;
  }

  private summary(c: ConversationRow, names: Map<string, string>): ConversationSummary {
    const contact = REPLYABLE.has(c.source) ? contactFromSessionKey(c.source, c.sessionKey) ?? undefined : undefined;
    return {
      id: c.id,
      botId: c.botId,
      botName: c.bot.name,
      source: c.source as ConversationSummary["source"],
      origin: c.origin ?? undefined,
      contact,
      contactName: contact ? names.get(contact) : undefined,
      canReply: !!contact,
      humanTakeoverAt: c.humanTakeoverAt?.toISOString(),
      messageCount: c.messageCount,
      issueCount: c.issueCount,
      startedAt: c.startedAt.toISOString(),
      lastMessageAt: c.lastMessageAt.toISOString(),
    };
  }

  private async require(businessId: string, id: string): Promise<ConversationRow> {
    const conversation = await prisma.botConversation.findUnique({ where: { id }, include: { bot: { select: { name: true } } } });
    if (!conversation || conversation.businessId !== businessId) throw new NotFoundException("Conversation not found");
    return conversation;
  }
}
