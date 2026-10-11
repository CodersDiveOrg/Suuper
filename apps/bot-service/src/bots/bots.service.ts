import { randomUUID } from "crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import axios from "axios";
import { prisma } from "@platform/database";
import { chat, type ChatTurn } from "@platform/shared-ai";
import { loadServiceConfig } from "@platform/shared-config";
import { signBusinessToken } from "@platform/shared-auth";
import type { Product, WidgetSettings } from "@platform/shared-types";
import { AGENT_MODELS, findModel, requireAnthropicKey } from "../agents/runtime/models";
import { AnthropicProvider } from "../agents/runtime/providers/anthropic";
import { OllamaProvider } from "../agents/runtime/providers/ollama";
import { buildToolSet } from "../agents/runtime/toolset";
import { runStatelessLoop } from "../agents/runtime/stateless-loop";
import { validMcpServerIds } from "../agents/runtime/mcp-ids";
import { validIntegrations } from "../agents/runtime/integration-ids";

// Bots answer in one request (and from the public widget), so keep tool loops short.
const BOT_MAX_STEPS = 5;

const config = loadServiceConfig("bot-service", 3002);

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
   * yet — each message is answered from scratch using freshly retrieved products. */
  async sendMessage(businessId: string, id: string, message: string, authorization: string | undefined) {
    if (!message.trim()) throw new BadRequestException("message is required");
    const bot = await this.require(businessId, id);
    const products = await this.searchKnowledge(bot.knowledgeBaseIds, message, authorization);
    return this.sendMessageForBot(bot, message, products);
  }

  /** Called from the public embed widget — there's no caller bearer token to forward,
   * so a short-lived internal token is minted for the knowledge-service search call. */
  async sendPublicMessage(bot: BotRow, message: string) {
    if (!message.trim()) throw new BadRequestException("message is required");
    const internalToken = signBusinessToken({
      userId: "widget",
      businessId: bot.businessId,
      role: "member",
      permissions: ["knowledge:read"],
    });
    const products = await this.searchKnowledge(bot.knowledgeBaseIds, message, `Bearer ${internalToken}`);
    return this.sendMessageForBot(bot, message, products);
  }

  private async sendMessageForBot(bot: BotRow, message: string, products: Product[]) {
    // Tools, or a Claude model, go through the provider layer; plain local bots keep the simple path.
    if (bot.mcpServerIds.length > 0 || bot.integrations.length > 0 || findModel(bot.model)?.provider === "anthropic") {
      return this.sendWithTools(bot, message, products);
    }
    const messages: ChatTurn[] = [
      { role: "system", content: bot.systemPrompt },
      { role: "user", content: this.buildPrompt(message, products) },
    ];
    const reply = await chat(messages, bot.model);
    return { reply, products };
  }

  private validModel(model: unknown) {
    if (typeof model !== "string" || !findModel(model)) {
      throw new BadRequestException(`model must be one of: ${AGENT_MODELS.map((m) => m.id).join(", ")}`);
    }
    return model;
  }

  /** Bots with MCP servers attached run a short tool loop over those servers' tools. */
  private async sendWithTools(bot: BotRow, message: string, products: Product[]) {
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
      userContent: this.buildPrompt(message, products),
      toolSet,
      maxSteps: BOT_MAX_STEPS,
    });
    return { reply, products, toolCalls };
  }

  async getWidgetSettings(businessId: string, id: string): Promise<WidgetSettings> {
    const bot = await this.require(businessId, id);
    return this.serializeWidgetSettings(bot);
  }

  async updateWidgetSettings(
    businessId: string,
    id: string,
    updates: { enabled?: boolean; allowedOrigins?: string[] },
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
      data: { widgetEnabled, allowedOrigins },
    });
    return this.serializeWidgetSettings(updated);
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

  private buildPrompt(message: string, products: Product[]): string {
    if (products.length === 0) {
      return `${message}\n\n(No matching products were found in the knowledge base — say so rather than inventing one.)`;
    }
    const catalog = products
      .map((product, i) => {
        const price =
          product.price !== undefined ? ` — ${product.price} ${product.currency ?? ""}`.trimEnd() : "";
        const description = product.description ? `\n   ${product.description}` : "";
        return `${i + 1}. ${product.title}${price}${description}`;
      })
      .join("\n");
    return `Relevant products:\n${catalog}\n\nCustomer question: ${message}`;
  }

  /** Calls knowledge-service directly (internal HTTP, per docs/ARCHITECTURE.md), forwarding the
   * same business-scoped token the incoming chat request carried — no separate service auth needed. */
  private async searchKnowledge(
    knowledgeBaseIds: string[],
    query: string,
    authorization: string | undefined,
  ): Promise<Product[]> {
    if (knowledgeBaseIds.length === 0) return [];
    try {
      const response = await axios.post(
        `${config.knowledgeServiceUrl}/businesses/current/knowledge-bases/search`,
        { query, knowledgeBaseIds },
        { headers: authorization ? { Authorization: authorization } : undefined },
      );
      return response.data as Product[];
    } catch {
      return [];
    }
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
    };
  }
}
