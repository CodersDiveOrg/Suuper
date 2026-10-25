import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import type { ChatTurn } from "@platform/shared-ai";
import { AGENT_MODELS, defaultModelFor, findModel, modelAvailability } from "./runtime/models";
import { isToolKey, toolCatalog } from "./runtime/tools";
import { validMcpServerIds } from "./runtime/mcp-ids";
import { validIntegrations } from "./runtime/integration-ids";
import { integrationToolCatalog } from "./runtime/integrations";
import { buildKnowledgePrompt, searchKnowledge } from "./runtime/knowledge";
import { AGENT_TEMPLATES } from "./templates";
import { meteredChat, withUsage } from "../usage/meter";
import { assertWithinQuota, creditMetersFor } from "../usage/quota";


export interface AgentRow {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  model: string;
  tools: string[];
  maxSteps: number;
  mcpServerIds: string[];
  integrations: string[];
  knowledgeBaseIds: string[];
  skillIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentInput {
  name?: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  tools?: unknown;
  maxSteps?: unknown;
  knowledgeBaseIds?: unknown;
  mcpServerIds?: unknown;
  integrations?: unknown;
  skillIds?: unknown;
}

const MAX_STEPS_LIMIT = 20;

@Injectable()
export class AgentsService {
  async create(businessId: string, input: AgentInput) {
    const name = input.name?.trim() ?? "";
    const systemPrompt = input.systemPrompt?.trim() ?? "";
    if (!name) throw new BadRequestException("name is required");
    if (!systemPrompt) throw new BadRequestException("systemPrompt is required");

    const agent = await prisma.agent.create({
      data: {
        businessId,
        name,
        systemPrompt,
        description: input.description?.trim() || null,
        model: input.model !== undefined ? this.validModel(input.model) : await this.defaultModel(businessId),
        tools: input.tools !== undefined ? this.validTools(input.tools) : ["current_time", "search_knowledge"],
        maxSteps: input.maxSteps !== undefined ? this.validMaxSteps(input.maxSteps) : undefined,
        mcpServerIds: input.mcpServerIds !== undefined ? await validMcpServerIds(businessId, input.mcpServerIds) : [],
        integrations: input.integrations !== undefined ? validIntegrations(input.integrations) : [],
        knowledgeBaseIds: input.knowledgeBaseIds !== undefined ? this.validIds(input.knowledgeBaseIds) : [],
        skillIds: input.skillIds !== undefined ? await this.validSkillIds(businessId, input.skillIds) : [],
      },
    });
    return this.serialize(agent);
  }

  /** Models an agent can use, and whether each is usable right now for this business. */
  async models(businessId: string) {
    return modelAvailability(businessId);
  }

  tools() {
    return toolCatalog();
  }

  integrationTools(businessId: string) {
    return integrationToolCatalog(businessId);
  }

  /** The business default (Settings → AI Models), else a capable cloud model it has a key for, else the local model. */
  private async defaultModel(businessId: string) {
    return (await defaultModelFor(businessId, "capable"))?.id ?? "llama3.2:3b";
  }

  private validModel(model: unknown) {
    if (typeof model !== "string" || !findModel(model)) {
      throw new BadRequestException(`model must be one of: ${AGENT_MODELS.map((m) => m.id).join(", ")}`);
    }
    return model;
  }

  private validTools(tools: unknown) {
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string" && isToolKey(t))) {
      throw new BadRequestException(`tools must be an array of: ${toolCatalog().map((t) => t.key).join(", ")}`);
    }
    return [...new Set(tools as string[])];
  }

  private validMaxSteps(value: unknown) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_STEPS_LIMIT) {
      throw new BadRequestException(`maxSteps must be an integer from 1 to ${MAX_STEPS_LIMIT}`);
    }
    return value;
  }

  private validIds(value: unknown) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      throw new BadRequestException("knowledgeBaseIds must be an array of ids");
    }
    return value as string[];
  }

  /** Skill ids must be this business's skills; order is kept (it's the order skills appear in the prompt). */
  private async validSkillIds(businessId: string, value: unknown) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      throw new BadRequestException("skillIds must be an array of ids");
    }
    const ids = [...new Set(value as string[])];
    const found = await prisma.agentSkill.count({ where: { businessId, id: { in: ids } } });
    if (found !== ids.length) throw new BadRequestException("One or more skills don't exist");
    return ids;
  }

  templates() {
    return AGENT_TEMPLATES;
  }

  async list(businessId: string) {
    const agents = await prisma.agent.findMany({ where: { businessId }, orderBy: { createdAt: "desc" } });
    return agents.map((agent) => this.serialize(agent));
  }

  async get(businessId: string, id: string) {
    return this.serialize(await this.require(businessId, id));
  }

  async update(businessId: string, id: string, updates: AgentInput) {
    await this.require(businessId, id);
    if (updates.name !== undefined && !updates.name.trim()) throw new BadRequestException("name can't be empty");
    if (updates.systemPrompt !== undefined && !updates.systemPrompt.trim()) {
      throw new BadRequestException("systemPrompt can't be empty");
    }
    const agent = await prisma.agent.update({
      where: { id },
      data: {
        ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
        ...(updates.description !== undefined ? { description: updates.description.trim() || null } : {}),
        ...(updates.systemPrompt !== undefined ? { systemPrompt: updates.systemPrompt.trim() } : {}),
        ...(updates.model !== undefined ? { model: this.validModel(updates.model) } : {}),
        ...(updates.tools !== undefined ? { tools: this.validTools(updates.tools) } : {}),
        ...(updates.maxSteps !== undefined ? { maxSteps: this.validMaxSteps(updates.maxSteps) } : {}),
        ...(updates.knowledgeBaseIds !== undefined ? { knowledgeBaseIds: this.validIds(updates.knowledgeBaseIds) } : {}),
        ...(updates.mcpServerIds !== undefined ? { mcpServerIds: await validMcpServerIds(businessId, updates.mcpServerIds) } : {}),
        ...(updates.integrations !== undefined ? { integrations: validIntegrations(updates.integrations) } : {}),
        ...(updates.skillIds !== undefined ? { skillIds: await this.validSkillIds(businessId, updates.skillIds) } : {}),
      },
    });
    return this.serialize(agent);
  }

  async remove(businessId: string, id: string) {
    await this.require(businessId, id);
    await prisma.agent.delete({ where: { id } });
  }

  /** Stateless single-turn, same as BotsService.sendMessage: no memory between
   * calls yet — each message is answered from scratch using freshly retrieved knowledge. */
  async sendMessage(businessId: string, id: string, message: string, authorization: string | undefined) {
    if (!message.trim()) throw new BadRequestException("message is required");
    const agent = await this.require(businessId, id);
    await assertWithinQuota(businessId, await creditMetersFor(businessId, agent.model));
    const knowledge = await searchKnowledge(agent.knowledgeBaseIds, message, authorization);

    const messages: ChatTurn[] = [
      { role: "system", content: agent.systemPrompt },
      { role: "user", content: buildKnowledgePrompt(message, knowledge, "Question") },
    ];
    const reply = await withUsage(businessId, "agent", () => meteredChat(messages, agent.model));
    return { reply, ...knowledge };
  }



  async require(businessId: string, id: string): Promise<AgentRow> {
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent || agent.businessId !== businessId) {
      throw new NotFoundException("Agent not found");
    }
    return agent;
  }

  private serialize(agent: AgentRow) {
    return {
      id: agent.id,
      businessId: agent.businessId,
      name: agent.name,
      description: agent.description ?? undefined,
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      tools: agent.tools,
      maxSteps: agent.maxSteps,
      mcpServerIds: agent.mcpServerIds,
      integrations: agent.integrations,
      knowledgeBaseIds: agent.knowledgeBaseIds,
      skillIds: agent.skillIds,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  }
}
