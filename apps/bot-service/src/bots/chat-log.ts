import { Logger } from "@nestjs/common";
import { prisma } from "@platform/database";
import { emitWebhookEvent } from "../webhooks/delivery";

export type BotChatSource = "widget" | "playground" | "whatsapp" | "telegram";
export type BotReplyOutcome = "answered" | "unanswered" | "error";

export interface BotChatMeta {
  source: BotChatSource;
  /** Client-generated id that groups messages into one conversation. */
  sessionId?: unknown;
  origin?: string;
}

const logger = new Logger("BotChatLog");

// How bots say they couldn't help ("I don't have information about…", "I'm not
// sure…"). Only the opening of the reply is checked, so "I don't have size 9,
// but here are…" later in an answer doesn't count. English only for now.
const CANT_ANSWER =
  /\b(?:i\s*(?:do not|don't|dont)\s*(?:have|know|see|find)|i(?:'m| am)\s*(?:not (?:sure|aware|able|equipped)|unable)|(?:no|not any|don't have any|do not have any) (?:information|info|details|data)|(?:couldn't|could not|can't|cannot|unable to) (?:find|answer|help with|locate)|there(?:'s| is) no (?:information|mention|record)|(?:doesn't|does not|don't|do not) (?:cover|mention|include) (?:this|that))/i;

/**
 * "unanswered" when the bot said it couldn't help, or had knowledge to search
 * and found nothing; otherwise "answered".
 */
export function replyOutcome(reply: string, hasKnowledge: boolean, foundKnowledge: boolean): BotReplyOutcome {
  if (hasKnowledge && !foundKnowledge) return "unanswered";
  return CANT_ANSWER.test(reply.slice(0, 300)) ? "unanswered" : "answered";
}
const MAX_CONTENT = 4000;
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Records one question + reply. Best-effort: a logging failure is logged and
 * swallowed so it never breaks the customer's chat.
 */
export async function logBotExchange(params: {
  businessId: string;
  botId: string;
  meta: BotChatMeta;
  question: string;
  reply: string;
  outcome: BotReplyOutcome;
  durationMs: number;
}) {
  const { businessId, botId, meta, outcome } = params;
  const sessionKey = typeof meta.sessionId === "string" && SESSION_RE.test(meta.sessionId) ? meta.sessionId : null;
  const issue = outcome === "answered" ? 0 : 1;
  try {
    const now = new Date();
    const conversation = sessionKey
      ? await prisma.botConversation.upsert({
          where: { botId_sessionKey: { botId, sessionKey } },
          create: { businessId, botId, sessionKey, source: meta.source, origin: meta.origin, messageCount: 2, issueCount: issue },
          update: { messageCount: { increment: 2 }, issueCount: { increment: issue }, lastMessageAt: now },
        })
      : await prisma.botConversation.create({
          data: { businessId, botId, source: meta.source, origin: meta.origin, messageCount: 2, issueCount: issue },
        });
    // Ordered timestamps so the question always sorts before its reply.
    await prisma.botMessage.createMany({
      data: [
        { conversationId: conversation.id, role: "user", content: params.question.slice(0, MAX_CONTENT), createdAt: new Date(now.getTime() - 1) },
        {
          conversationId: conversation.id,
          role: "assistant",
          content: params.reply.slice(0, MAX_CONTENT),
          outcome,
          durationMs: params.durationMs,
          createdAt: now,
        },
      ],
    });

    const started = conversation.messageCount === 2;
    if (started || outcome === "unanswered") {
      const data = async () => {
        const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { name: true } });
        return {
          bot: { id: botId, name: bot?.name ?? "" },
          conversation: { id: conversation.id, source: meta.source, origin: meta.origin ?? null },
          question: params.question.slice(0, MAX_CONTENT),
          reply: params.reply.slice(0, MAX_CONTENT),
        };
      };
      if (started) emitWebhookEvent(businessId, "bot.conversation.started", data);
      if (outcome === "unanswered") emitWebhookEvent(businessId, "bot.question.unanswered", data);
    }
  } catch (err) {
    logger.warn(`Couldn't record a ${meta.source} chat for bot ${botId}: ${(err as Error).message}`);
  }
}
