import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { chat, type ChatTurn } from "@platform/shared-ai";
import { AGENT_MODELS, anthropicApiKey, findModel } from "./runtime/models";
import { isToolKey, toolCatalog } from "./runtime/tools";
import { validMcpServerIds } from "./runtime/mcp-ids";
import { validIntegrations } from "./runtime/integration-ids";
import { integrationToolCatalog } from "./runtime/integrations";
import { buildKnowledgePrompt, searchKnowledge } from "./runtime/knowledge";


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
}

const MAX_STEPS_LIMIT = 20;

let ollamaCheck: { at: number; ok: boolean } | null = null;
async function ollamaReachable() {
  if (ollamaCheck && Date.now() - ollamaCheck.at < 60_000) return ollamaCheck.ok;
  const ok = await fetch(`${process.env.OLLAMA_URL ?? "http://localhost:11434"}/api/tags`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);
  ollamaCheck = { at: Date.now(), ok };
  return ok;
}

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
      },
    });
    return this.serialize(agent);
  }

  /** Models an agent can use, and whether each is usable right now for this business. */
  async models(businessId: string) {
    const [hasKey, ollamaUp] = await Promise.all([anthropicApiKey(businessId).then(Boolean), ollamaReachable()]);
    return AGENT_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      description: m.description,
      available: m.provider === "anthropic" ? hasKey : ollamaUp,
      unavailableReason:
        m.provider === "anthropic" && !hasKey
          ? "Connect the Anthropic integration to use Claude models."
          : m.provider === "ollama" && !ollamaUp
            ? "The local Ollama server isn't reachable."
            : undefined,
    }));
  }

  tools() {
    return toolCatalog();
  }

  integrationTools(businessId: string) {
    return integrationToolCatalog(businessId);
  }

  /** Claude when a key is configured, otherwise the local model, so new agents work out of the box. */
  private async defaultModel(businessId: string) {
    return (await anthropicApiKey(businessId)) ? "claude-opus-5-5" : "llama3.2:3b";
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
    const knowledge = await searchKnowledge(agent.knowledgeBaseIds, message, authorization);

    const messages: ChatTurn[] = [
      { role: "system", content: agent.systemPrompt },
      { role: "user", content: buildKnowledgePrompt(message, knowledge, "Question") },
    ];
    const reply = await chat(messages, agent.model);
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
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  }
}
