import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { loadServiceConfig } from "@platform/shared-config";
import type { BotChannel, ChannelMessage, ChannelProvider } from "@platform/shared-types";
import { BotsService, type ChatHistoryTurn } from "../bots/bots.service";
import { integrationCredentials } from "../agents/runtime/models";
import {
  CHANNEL_ADAPTERS,
  CHANNEL_PROVIDERS,
  deleteTelegramWebhook,
  setTelegramWebhook,
  validWhatsAppSignature,
  type InboundMessage,
} from "./providers";

const config = loadServiceConfig("bot-service", 3002);
// Earlier messages with the same customer sent along as context, and how far back they go.
const HISTORY_MESSAGES = 10;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const UNSUPPORTED_REPLY = "Sorry, I can only read text messages for now. Please type your question.";

type ChannelRow = NonNullable<Awaited<ReturnType<typeof prisma.botChannel.findUnique>>>;

function webhookUrl(webhookKey: string) {
  return `${config.publicApiUrl}/hooks/channels/${webhookKey}`;
}

/** BotConversation.sessionKey for a channel customer; parsed back by contactFromSessionKey. */
export function channelSessionKey(provider: string, contact: string) {
  return `${provider}-${contact.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64);
}

export function contactFromSessionKey(provider: string, sessionKey: string | null): string | null {
  return sessionKey?.startsWith(`${provider}-`) ? sessionKey.slice(provider.length + 1) : null;
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(private readonly bots: BotsService) {}

  async list(businessId: string): Promise<BotChannel[]> {
    const [channels, connections] = await Promise.all([
      prisma.botChannel.findMany({ where: { businessId } }),
      prisma.integrationConnection.findMany({
        where: { businessId, provider: { in: CHANNEL_PROVIDERS }, enabled: true },
        select: { provider: true },
      }),
    ]);
    const connected = new Set(connections.map((c) => c.provider));
    return CHANNEL_PROVIDERS.map((provider) => {
      const channel = channels.find((c) => c.provider === provider);
      return { provider, integrationConnected: connected.has(provider), channel: channel ? this.serialize(channel) : null };
    });
  }

  /** Creates or updates the provider's channel. Telegram's webhook is (un)registered to match `enabled`. */
  async save(businessId: string, provider: string, body: { botId?: string; enabled?: boolean }): Promise<BotChannel> {
    const p = this.validProvider(provider);
    const existing = await prisma.botChannel.findUnique({ where: { businessId_provider: { businessId, provider: p } } });
    const botId = body.botId ?? existing?.botId;
    if (!botId) throw new BadRequestException("botId is required");
    const bot = await prisma.bot.findUnique({ where: { id: botId } });
    if (!bot || bot.businessId !== businessId) throw new BadRequestException("Bot not found");
    const creds = await integrationCredentials(businessId, p);
    if (!creds) throw new BadRequestException(`Connect ${p === "whatsapp" ? "WhatsApp Business" : "Telegram"} under Integrations first`);

    const enabled = body.enabled ?? existing?.enabled ?? true;
    let channel = await prisma.botChannel.upsert({
      where: { businessId_provider: { businessId, provider: p } },
      create: { businessId, provider: p, botId, enabled },
      update: { botId, enabled },
    });

    if (p === "telegram" && enabled !== (existing?.enabled ?? false)) {
      try {
        if (enabled) await setTelegramWebhook(creds, webhookUrl(channel.webhookKey), channel.verifyToken);
        else await deleteTelegramWebhook(creds);
        channel = await prisma.botChannel.update({ where: { id: channel.id }, data: { lastError: null } });
      } catch (err) {
        await prisma.botChannel.update({ where: { id: channel.id }, data: { enabled: false, lastError: errorMessage(err) } });
        throw new BadRequestException(`Telegram refused the webhook: ${errorMessage(err)}`);
      }
    }
    return { provider: p, integrationConnected: true, channel: this.serialize(channel) };
  }

  async remove(businessId: string, provider: string) {
    const p = this.validProvider(provider);
    const channel = await prisma.botChannel.findUnique({ where: { businessId_provider: { businessId, provider: p } } });
    if (!channel) throw new NotFoundException("Channel not found");
    if (p === "telegram" && channel.enabled) {
      const creds = await integrationCredentials(businessId, p);
      // Best effort: the token may already be revoked.
      if (creds) await deleteTelegramWebhook(creds).catch(() => undefined);
    }
    await prisma.botChannel.delete({ where: { id: channel.id } });
  }

  async messages(businessId: string, provider: string, limit = 50): Promise<ChannelMessage[]> {
    const p = this.validProvider(provider);
    const channel = await prisma.botChannel.findUnique({ where: { businessId_provider: { businessId, provider: p } } });
    if (!channel) return [];
    const rows = await prisma.channelMessage.findMany({
      where: { channelId: channel.id },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((m) => ({
      id: m.id,
      contact: m.contact,
      contactName: m.contactName ?? undefined,
      direction: m.direction as "in" | "out",
      text: m.text,
      error: m.error ?? undefined,
      createdAt: m.createdAt.toISOString(),
    }));
  }

  // --- Public webhook ---------------------------------------------------------

  /** WhatsApp's subscription handshake: echo hub.challenge when the verify token matches. */
  async verify(webhookKey: string, query: Record<string, unknown>): Promise<string> {
    const channel = await this.byKey(webhookKey);
    if (channel.provider !== "whatsapp" || query["hub.mode"] !== "subscribe" || query["hub.verify_token"] !== channel.verifyToken) {
      throw new ForbiddenException("Verification failed");
    }
    return String(query["hub.challenge"] ?? "");
  }

  /** Checks the request is genuine, then answers in the background — providers retry if we're slow to return 200. */
  async receive(webhookKey: string, body: unknown, headers: Record<string, string | undefined>, rawBody?: Buffer) {
    const channel = await this.byKey(webhookKey);
    const creds = await integrationCredentials(channel.businessId, channel.provider);
    if (!creds) return { ok: true };

    if (channel.provider === "telegram" && headers["x-telegram-bot-api-secret-token"] !== channel.verifyToken) {
      throw new ForbiddenException("Bad secret token");
    }
    if (channel.provider === "whatsapp" && creds.appSecret) {
      if (!rawBody || !validWhatsAppSignature(rawBody, headers["x-hub-signature-256"], creds.appSecret)) {
        throw new ForbiddenException("Bad signature");
      }
    }
    if (!channel.enabled) return { ok: true };

    const inbound = CHANNEL_ADAPTERS[channel.provider].parse(body, creds);
    for (const message of inbound) {
      void this.answer(channel, creds, message).catch((err) =>
        this.logger.error(`channel ${channel.id}: ${errorMessage(err)}`),
      );
    }
    return { ok: true };
  }

  private async answer(channel: ChannelRow, creds: Record<string, string>, message: InboundMessage) {
    const base = { channelId: channel.id, businessId: channel.businessId, contact: message.contact, contactName: message.contactName };
    try {
      await prisma.channelMessage.create({
        data: { ...base, direction: "in", text: message.unsupported ? "(unsupported message)" : message.text, externalId: message.externalId },
      });
    } catch {
      return; // externalId already stored: a webhook retry of a message we've handled.
    }

    // A team member has this chat (Bots → Conversations): record it for them, the bot stays quiet.
    const sessionId = channelSessionKey(channel.provider, message.contact);
    const conversation = await prisma.botConversation.findUnique({
      where: { botId_sessionKey: { botId: channel.botId, sessionKey: sessionId } },
    });
    if (conversation?.humanTakeoverAt) {
      await prisma.$transaction([
        prisma.botMessage.create({ data: { conversationId: conversation.id, role: "user", content: message.unsupported ? "(unsupported message)" : message.text } }),
        prisma.botConversation.update({
          where: { id: conversation.id },
          data: { messageCount: { increment: 1 }, lastMessageAt: new Date() },
        }),
      ]);
      return;
    }

    let reply = UNSUPPORTED_REPLY;
    try {
      if (!message.unsupported) {
        const bot = await prisma.bot.findUnique({ where: { id: channel.botId } });
        if (!bot) throw new Error("The channel's bot no longer exists");
        const history = await this.history(channel.id, message.contact);
        // One conversation per customer, so channel chats show up under Conversations and Analytics.
        const result = await this.bots.sendPublicMessage(bot, message.text, history, { source: channel.provider as "whatsapp" | "telegram", sessionId });
        reply = result.reply.trim() || "Sorry, I don't have an answer for that.";
      }
      await CHANNEL_ADAPTERS[channel.provider].send(creds, message.contact, reply);
      await prisma.channelMessage.create({ data: { ...base, direction: "out", text: reply } });
      await prisma.botChannel.update({
        where: { id: channel.id },
        data: { messageCount: { increment: 1 }, lastMessageAt: new Date(), lastError: null },
      });
    } catch (err) {
      const error = errorMessage(err);
      await prisma.channelMessage.create({ data: { ...base, direction: "out", text: reply, error } });
      await prisma.botChannel.update({
        where: { id: channel.id },
        data: { messageCount: { increment: 1 }, lastMessageAt: new Date(), lastError: error },
      });
    }
  }

  /**
   * Sends a team member's message from the inbox to the customer on the
   * channel. Logged in the channel log too, so the bot sees it as context
   * once the chat is handed back.
   */
  async sendAsAgent(businessId: string, provider: string, contact: string, text: string) {
    const p = this.validProvider(provider);
    const channel = await prisma.botChannel.findUnique({ where: { businessId_provider: { businessId, provider: p } } });
    if (!channel) throw new BadRequestException("This channel has been removed, so replies can't be sent");
    const creds = await integrationCredentials(businessId, p);
    if (!creds) throw new BadRequestException("The integration is disconnected or turned off");
    try {
      await CHANNEL_ADAPTERS[p].send(creds, contact, text);
    } catch (err) {
      throw new BadRequestException(`Couldn't send: ${errorMessage(err)}`);
    }
    await prisma.channelMessage.create({
      data: { channelId: channel.id, businessId, contact, direction: "out", text },
    });
  }

  /** Earlier turns with this contact (excluding the message being answered), oldest first. */
  private async history(channelId: string, contact: string): Promise<ChatHistoryTurn[]> {
    const rows = await prisma.channelMessage.findMany({
      where: { channelId, contact, error: null, createdAt: { gte: new Date(Date.now() - HISTORY_WINDOW_MS) } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_MESSAGES + 1,
    });
    return rows
      .slice(1)
      .reverse()
      .map((m): ChatHistoryTurn => ({ role: m.direction === "in" ? "user" : "assistant", text: m.text }));
  }

  private async byKey(webhookKey: string): Promise<ChannelRow> {
    const channel = await prisma.botChannel.findUnique({ where: { webhookKey } });
    if (!channel) throw new NotFoundException("Channel not found");
    return channel;
  }

  private validProvider(provider: string): ChannelProvider {
    if (!(CHANNEL_PROVIDERS as string[]).includes(provider)) {
      throw new BadRequestException(`provider must be one of: ${CHANNEL_PROVIDERS.join(", ")}`);
    }
    return provider as ChannelProvider;
  }

  private serialize(channel: ChannelRow): NonNullable<BotChannel["channel"]> {
    return {
      id: channel.id,
      botId: channel.botId,
      enabled: channel.enabled,
      webhookUrl: webhookUrl(channel.webhookKey),
      ...(channel.provider === "whatsapp" ? { verifyToken: channel.verifyToken } : {}),
      messageCount: channel.messageCount,
      lastMessageAt: channel.lastMessageAt?.toISOString(),
      lastError: channel.lastError ?? undefined,
      createdAt: channel.createdAt.toISOString(),
    };
  }
}
