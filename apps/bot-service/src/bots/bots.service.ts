import { randomUUID } from "crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import type { ChatTurn } from "@platform/shared-ai";
import { signBusinessToken } from "@platform/shared-auth";
import {
  DEFAULT_WIDGET_APPEARANCE,
  type KnowledgeSearchResult,
  type PublicWidgetConfig,
  type WidgetAppearance,
  type WidgetOverview,
  type WidgetSettings,
} from "@platform/shared-types";
import { AGENT_MODELS, findModel, requireAnthropicKey } from "../agents/runtime/models";
import { AnthropicProvider } from "../agents/runtime/providers/anthropic";
import { OllamaProvider } from "../agents/runtime/providers/ollama";
import { buildToolSet } from "../agents/runtime/toolset";
import { runStatelessLoop } from "../agents/runtime/stateless-loop";
import { validMcpServerIds } from "../agents/runtime/mcp-ids";
import { validIntegrations } from "../agents/runtime/integration-ids";
import { buildKnowledgePrompt, searchKnowledge } from "../agents/runtime/knowledge";
import { meteredChat, recordBotReply, withUsage } from "../usage/meter";
import { assertWithinQuota } from "../usage/quota";
import { logBotExchange, replyOutcome, type BotChatMeta, type BotReplyOutcome } from "./chat-log";

// Bots answer in one request (and from the public widget), so keep tool loops short.
const BOT_MAX_STEPS = 5;


export interface BotRow {
  id: string;
  businessId: string;
  name: string;
  systemPrompt: string;
  model: string;
  mcpServerIds: string[];
  integrations: string[];
  knowledgeBaseIds: string[];
  createdAt: Date;
  widgetEnabled: boolean;
  widgetKey: string;
  allowedOrigins: string[];
  widgetAppearance?: unknown;
}

export interface ChatHistoryTurn {
  role: "user" | "assistant";
  text: string;
}

const MAX_HISTORY_TURNS = 6;

function recentTurns(history: ChatHistoryTurn[]): ChatHistoryTurn[] {
  return history
    .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role, text: t.text.trim().slice(0, 1000) }));
}

/** Puts the last few turns above the prompt as plain text, for the single-message tool loop. */
function withHistory(prompt: string, history: ChatHistoryTurn[]): string {
  const turns = recentTurns(history).map((t) => `${t.role === "user" ? "Customer" : "You"}: ${t.text}`);
  if (turns.length === 0) return prompt;
  return `Conversation so far:\n${turns.join("\n")}\n\n${prompt}`;
}

/** Strips labels small models sometimes echo from the prompt ("Q: …\nA:", "You:", "Answer:"). */
export function cleanReply(reply: string): string {
  let text = reply.trim();
  text = text.replace(/^(?:Customer|User|Q(?:uestion)?)\s*:[^\n]*\n+(?=\s*(?:A|Answer|You|Assistant)\s*:)/i, "");
  text = text.replace(/^(?:A|Answer|You|Assistant)\s*:\s*/i, "");
  return text.trim();
}

/** Very loose "https://host" / "http://host" shape check — good enough to catch typos. */
function isValidOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.pathname === "/" && !url.search;
  } catch {
    return false;
  }
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const STATS_DAYS = 30;

/** Stored appearance over the defaults; anything malformed falls back. */
export function widgetAppearanceOf(bot: Pick<BotRow, "widgetAppearance">): WidgetAppearance {
  const stored = (bot.widgetAppearance ?? {}) as Partial<Record<keyof WidgetAppearance, unknown>>;
  const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value : fallback);
  const d = DEFAULT_WIDGET_APPEARANCE;
  return {
    color: typeof stored.color === "string" && HEX_COLOR.test(stored.color) ? stored.color : d.color,
    title: text(stored.title, d.title),
    greeting: text(stored.greeting, d.greeting),
    placeholder: text(stored.placeholder, d.placeholder),
    position: stored.position === "bottom-left" ? "bottom-left" : "bottom-right",
  };
}

function validAppearance(input: unknown): WidgetAppearance {
  if (!input || typeof input !== "object") throw new BadRequestException("appearance must be an object");
  const a = input as Record<string, unknown>;
  const text = (key: string, max: number) => {
    const value = a[key];
    if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${key} can't be empty`);
    if (value.trim().length > max) throw new BadRequestException(`${key} can be at most ${max} characters`);
    return value.trim();
  };
  if (typeof a.color !== "string" || !HEX_COLOR.test(a.color)) throw new BadRequestException("color must be a hex color like #4f46e5");
  if (a.position !== "bottom-right" && a.position !== "bottom-left") throw new BadRequestException('position must be "bottom-right" or "bottom-left"');
  return {
    color: a.color.toLowerCase(),
    title: text("title", 40),
    greeting: text("greeting", 300),
    placeholder: text("placeholder", 60),
    position: a.position,
  };
}

@Injectable()
export class BotsService {
  async create(
    businessId: string,
    name: string,
    systemPrompt: string,
    knowledgeBaseIds: string[],
    mcpServerIds: unknown = [],
    model?: unknown,
    integrations: unknown = [],
  ) {
    if (!name.trim()) throw new BadRequestException("name is required");
    if (!systemPrompt.trim()) throw new BadRequestException("systemPrompt is required");
    await assertWithinQuota(businessId, ["bots"]);

    const bot = await prisma.bot.create({
      data: {
        businessId,
        name: name.trim(),
        systemPrompt: systemPrompt.trim(),
        mcpServerIds: await validMcpServerIds(businessId, mcpServerIds ?? []),
        integrations: validIntegrations(integrations ?? []),
        knowledgeBaseIds,
        ...(model !== undefined ? { model: this.validModel(model) } : {}),
      },
    });
    return this.serialize(bot);
  }

  async list(businessId: string) {
    const bots = await prisma.bot.findMany({ where: { businessId }, orderBy: { createdAt: "desc" } });
    return bots.map((bot) => this.serialize(bot));
  }

  async get(businessId: string, id: string) {
    return this.serialize(await this.require(businessId, id));
  }

  async update(
    businessId: string,
    id: string,
    updates: { name?: string; systemPrompt?: string; knowledgeBaseIds?: string[]; mcpServerIds?: unknown; model?: unknown; integrations?: unknown },
  ) {
    await this.require(businessId, id);
    const bot = await prisma.bot.update({
      where: { id },
      data: {
        ...(updates.mcpServerIds !== undefined ? { mcpServerIds: await validMcpServerIds(businessId, updates.mcpServerIds) } : {}),
        ...(updates.model !== undefined ? { model: this.validModel(updates.model) } : {}),
        ...(updates.integrations !== undefined ? { integrations: validIntegrations(updates.integrations) } : {}),
        ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
        ...(updates.systemPrompt !== undefined ? { systemPrompt: updates.systemPrompt.trim() } : {}),
        ...(updates.knowledgeBaseIds !== undefined ? { knowledgeBaseIds: updates.knowledgeBaseIds } : {}),
      },
    });
    return this.serialize(bot);
  }

  async remove(businessId: string, id: string) {
    await this.require(businessId, id);
    await prisma.bot.delete({ where: { id } });
  }

  /** Stateless single-turn (see docs/ARCHITECTURE.md): no memory between calls
   * yet — each message is answered from scratch using freshly retrieved knowledge. */
  async sendMessage(businessId: string, id: string, message: string, authorization: string | undefined, sessionId?: unknown) {
    if (!message.trim()) throw new BadRequestException("message is required");
    const bot = await this.require(businessId, id);
    return this.logged(bot, { source: "playground", sessionId }, message, async () => {
      const knowledge = await searchKnowledge(bot.knowledgeBaseIds, message, authorization);
      return this.sendMessageForBot(bot, message, knowledge);
    });
  }

  /** Called from the public embed widget and app pages — there's no caller bearer token to forward,
   * so a short-lived internal token is minted for the knowledge-service search call. `history` (app
   * pages) is the last few turns, so follow-up questions make sense without server-side sessions. */
  async sendPublicMessage(bot: BotRow, message: string, history: ChatHistoryTurn[] = [], meta: BotChatMeta = { source: "widget" }) {
    if (!message.trim()) throw new BadRequestException("message is required");
    return this.logged(bot, meta, message, () => this.answerPublic(bot, message, history));
  }

  private async answerPublic(bot: BotRow, message: string, history: ChatHistoryTurn[]) {
    const internalToken = signBusinessToken({
      userId: "widget",
      businessId: bot.businessId,
      role: "member",
      permissions: ["knowledge:read"],
    });
    // A short follow-up ("how much is it?") retrieves better with the previous question attached.
    const lastQuestion = [...history].reverse().find((turn) => turn.role === "user")?.text;
    const query = message.length < 60 && lastQuestion ? `${lastQuestion} ${message}` : message;
    const knowledge = await searchKnowledge(bot.knowledgeBaseIds, query, `Bearer ${internalToken}`);
    return this.sendMessageForBot(bot, message, knowledge, history);
  }

  /**
   * Runs one answer within the plan's limits, meters it, and records the
   * exchange for analytics (see chat-log.ts). A limit hit is thrown before
   * anything runs and isn't logged as a chat.
   */
  private async logged<T extends { reply: string; products?: unknown[]; passages?: unknown[] }>(
    bot: BotRow,
    meta: BotChatMeta,
    message: string,
    answer: () => Promise<T>,
  ): Promise<T> {
    await assertWithinQuota(bot.businessId, ["ai_replies", "ai_tokens"]);
    const started = Date.now();
    const record = (reply: string, outcome: BotReplyOutcome) =>
      logBotExchange({ businessId: bot.businessId, botId: bot.id, meta, question: message, reply, outcome, durationMs: Date.now() - started });
    try {
      const result = await withUsage(bot.businessId, "bot", answer);
      recordBotReply(bot.businessId);
      const found = (result.products?.length ?? 0) + (result.passages?.length ?? 0) > 0;
      await record(result.reply, replyOutcome(result.reply, bot.knowledgeBaseIds.length > 0, found));
      return result;
    } catch (err) {
      await record((err as Error).message ?? "Failed", "error");
      throw err;
    }
  }

  private async sendMessageForBot(bot: BotRow, message: string, knowledge: KnowledgeSearchResult, history: ChatHistoryTurn[] = []) {
    const prompt = buildKnowledgePrompt(message, knowledge, "Customer question");
    // Tools, or a Claude model, go through the provider layer; plain local bots keep the simple path.
    if (bot.mcpServerIds.length > 0 || bot.integrations.length > 0 || findModel(bot.model)?.provider === "anthropic") {
      const result = await this.sendWithTools(bot, withHistory(prompt, history), knowledge);
      return { ...result, reply: cleanReply(result.reply) };
    }
    // Earlier turns go in as real chat turns: small local models copy transcript-style labels otherwise.
    const messages: ChatTurn[] = [
      { role: "system", content: bot.systemPrompt },
      ...recentTurns(history).map((t): ChatTurn => ({ role: t.role, content: t.text })),
      { role: "user", content: prompt },
    ];
    const reply = cleanReply(await meteredChat(messages, bot.model));
    return { reply, ...knowledge };
  }

  private validModel(model: unknown) {
    if (typeof model !== "string" || !findModel(model)) {
      throw new BadRequestException(`model must be one of: ${AGENT_MODELS.map((m) => m.id).join(", ")}`);
    }
    return model;
  }

  /** Bots with MCP servers attached run a short tool loop over those servers' tools. */
  private async sendWithTools(bot: BotRow, userContent: string, knowledge: KnowledgeSearchResult) {
    const model = findModel(bot.model);
    const providerName = model?.provider ?? "ollama";
    const provider =
      model?.provider === "anthropic"
        ? new AnthropicProvider(await requireAnthropicKey(bot.businessId), model)
        : new OllamaProvider();
    const toolSet = await buildToolSet({
      businessId: bot.businessId,
      provider: providerName,
      builtInTools: [],
      knowledgeBaseIds: bot.knowledgeBaseIds,
      mcpServerIds: bot.mcpServerIds,
      integrations: bot.integrations,
      source: "bot",
    });
    const { reply, toolCalls } = await runStatelessLoop({
      provider,
      model: bot.model,
      system: bot.systemPrompt,
      userContent,
      toolSet,
      maxSteps: BOT_MAX_STEPS,
    });
    return { reply, ...knowledge, toolCalls };
  }

  async getWidgetSettings(businessId: string, id: string): Promise<WidgetSettings> {
    const bot = await this.require(businessId, id);
    return this.serializeWidgetSettings(bot);
  }

  async updateWidgetSettings(
    businessId: string,
    id: string,
    updates: { enabled?: boolean; allowedOrigins?: string[]; appearance?: unknown },
  ): Promise<WidgetSettings> {
    const bot = await this.require(businessId, id);

    const allowedOrigins = updates.allowedOrigins ?? bot.allowedOrigins;
    for (const origin of allowedOrigins) {
      if (!isValidOrigin(origin)) {
        throw new BadRequestException(`"${origin}" is not a valid origin (expected e.g. https://your-store.com)`);
      }
    }
    const widgetEnabled = updates.enabled ?? bot.widgetEnabled;
    if (widgetEnabled && allowedOrigins.length === 0) {
      throw new BadRequestException("Add at least one allowed origin before enabling the widget");
    }

    const updated = await prisma.bot.update({
      where: { id },
      data: {
        widgetEnabled,
        allowedOrigins,
        ...(updates.appearance !== undefined ? { widgetAppearance: validAppearance(updates.appearance) as object } : {}),
      },
    });
    return this.serializeWidgetSettings(updated);
  }

  /** Every bot's widget, with the last 30 days of widget conversations. */
  async listWidgets(businessId: string): Promise<WidgetOverview[]> {
    const since = new Date(Date.now() - STATS_DAYS * 86_400_000);
    const where = { businessId, source: "widget", startedAt: { gte: since } };
    const [bots, totals, issues, origins] = await Promise.all([
      prisma.bot.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } }),
      prisma.botConversation.groupBy({
        by: ["botId"],
        where,
        _count: { _all: true },
        _sum: { messageCount: true },
        _max: { lastMessageAt: true },
      }),
      prisma.botConversation.groupBy({ by: ["botId"], where: { ...where, issueCount: { gt: 0 } }, _count: { _all: true } }),
      prisma.botConversation.groupBy({ by: ["botId", "origin"], where: { ...where, origin: { not: null } }, _count: { _all: true } }),
    ]);
    return bots.map((bot) => {
      const total = totals.find((t) => t.botId === bot.id);
      return {
        botId: bot.id,
        botName: bot.name,
        ...this.serializeWidgetSettings(bot),
        stats: {
          conversations: total?._count._all ?? 0,
          // Each exchange is a question and a reply.
          messages: total?._sum.messageCount ?? 0,
          withIssues: issues.find((i) => i.botId === bot.id)?._count._all ?? 0,
          lastConversationAt: total?._max.lastMessageAt?.toISOString() ?? null,
          origins: origins
            .filter((o) => o.botId === bot.id && o.origin)
            .map((o) => ({ origin: o.origin!, conversations: o._count._all }))
            .sort((a, b) => b.conversations - a.conversations)
            .slice(0, 5),
        },
      };
    });
  }

  /** For the embed script; the caller (WidgetKeyGuard) has already checked the key and origin. */
  publicWidgetConfig(bot: BotRow): PublicWidgetConfig {
    return { botName: bot.name, ...widgetAppearanceOf(bot) };
  }

  async regenerateWidgetKey(businessId: string, id: string): Promise<WidgetSettings> {
    await this.require(businessId, id);
    const updated = await prisma.bot.update({ where: { id }, data: { widgetKey: randomUUID() } });
    return this.serializeWidgetSettings(updated);
  }

  /** Used by the public widget route's WidgetKeyGuard — no business context to scope by yet. */
  async findByWidgetKey(widgetKey: string): Promise<BotRow | null> {
    return prisma.bot.findUnique({ where: { widgetKey } });
  }



  private async require(businessId: string, id: string): Promise<BotRow> {
    const bot = await prisma.bot.findUnique({ where: { id } });
    if (!bot || bot.businessId !== businessId) {
      throw new NotFoundException("Bot not found");
    }
    return bot;
  }

  private serialize(bot: BotRow) {
    return {
      id: bot.id,
      businessId: bot.businessId,
      name: bot.name,
      systemPrompt: bot.systemPrompt,
      model: bot.model,
      mcpServerIds: bot.mcpServerIds,
      integrations: bot.integrations,
      knowledgeBaseIds: bot.knowledgeBaseIds,
      createdAt: bot.createdAt.toISOString(),
    };
  }

  private serializeWidgetSettings(bot: BotRow): WidgetSettings {
    return {
      widgetEnabled: bot.widgetEnabled,
      widgetKey: bot.widgetKey,
      allowedOrigins: bot.allowedOrigins,
      appearance: widgetAppearanceOf(bot),
    };
  }
}
