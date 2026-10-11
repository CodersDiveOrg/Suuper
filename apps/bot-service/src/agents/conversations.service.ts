import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { AgentsService } from "./agents.service";
import { AgentRunner, type RunEvent } from "./runtime/agent-runner";
import type { ContentBlockParam } from "./runtime/providers/types";

/** A UI-friendly view of the stored API messages. */
export type TranscriptItem =
  | { kind: "user"; text: string; at: string }
  | { kind: "assistant"; text: string; at: string }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: string; isError?: boolean; at: string };

const MAX_TITLE = 80;

function titleFrom(text: string) {
  const firstLine = text.trim().split("\n")[0];
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine || "New conversation";
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly runner: AgentRunner,
  ) {}

  /** The caller's own conversations with an agent, newest activity first. */
  async list(businessId: string, agentId: string, userId: string) {
    await this.agentsService.require(businessId, agentId);
    const conversations = await prisma.agentConversation.findMany({
      where: { businessId, agentId, userId },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return conversations.map((c) => this.serialize(c));
  }

  async create(businessId: string, agentId: string, userId: string, title?: string) {
    await this.agentsService.require(businessId, agentId);
    const conversation = await prisma.agentConversation.create({
      data: { businessId, agentId, userId, title: title?.trim().slice(0, MAX_TITLE) || "New conversation" },
    });
    return this.serialize(conversation);
  }

  async get(businessId: string, agentId: string, userId: string, conversationId: string) {
    const conversation = await this.requireOwn(businessId, agentId, userId, conversationId);
    const messages = await prisma.agentMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
    return { ...this.serialize(conversation), transcript: this.transcript(messages) };
  }

  async rename(businessId: string, agentId: string, userId: string, conversationId: string, title: unknown) {
    await this.requireOwn(businessId, agentId, userId, conversationId);
    if (typeof title !== "string" || !title.trim()) throw new BadRequestException("title is required");
    const updated = await prisma.agentConversation.update({
      where: { id: conversationId },
      data: { title: title.trim().slice(0, MAX_TITLE) },
    });
    return this.serialize(updated);
  }

  async remove(businessId: string, agentId: string, userId: string, conversationId: string) {
    await this.requireOwn(businessId, agentId, userId, conversationId);
    await prisma.agentConversation.delete({ where: { id: conversationId } });
  }

  async sendMessage(
    businessId: string,
    agentId: string,
    userId: string,
    conversationId: string,
    message: unknown,
    emit: (event: RunEvent) => void,
  ) {
    if (typeof message !== "string") throw new BadRequestException("message is required");
    const conversation = await this.requireOwn(businessId, agentId, userId, conversationId);
    const agent = await this.agentsService.require(businessId, agentId);
    if (conversation.title === "New conversation") {
      await prisma.agentConversation.update({ where: { id: conversationId }, data: { title: titleFrom(message) } });
    }
    return this.runner.run({ agent, conversationId, userId, input: message, emit });
  }

  /**
   * Legacy one-shot endpoint (POST /agents/:id/messages) used by the original
   * Playground: runs the message in a fresh conversation and returns the reply.
   */
  async oneShot(businessId: string, agentId: string, userId: string, message: unknown) {
    if (typeof message !== "string" || !message.trim()) throw new BadRequestException("message is required");
    const conversation = await this.create(businessId, agentId, userId, titleFrom(message));
    const runId = await this.sendMessage(businessId, agentId, userId, conversation.id, message, () => undefined);
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status === "failed") throw new BadRequestException(run.error ?? "The agent run failed");
    return { reply: run.output ?? "", products: [], conversationId: conversation.id, runId };
  }

  private transcript(messages: { role: string; content: unknown; createdAt: Date }[]): TranscriptItem[] {
    const items: TranscriptItem[] = [];
    const toolItems = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
    for (const message of messages) {
      const at = message.createdAt.toISOString();
      const blocks = message.content as ContentBlockParam[];
      if (message.role === "assistant") {
        for (const block of blocks) {
          if (block.type === "text" && block.text.trim()) items.push({ kind: "assistant", text: block.text, at });
          if (block.type === "tool_use" || block.type === "server_tool_use") {
            const item = { kind: "tool" as const, id: block.id, name: block.name, input: block.input, at };
            toolItems.set(block.id, item);
            items.push(item);
          }
          // Provider-hosted tool results (web search/fetch) arrive in the assistant turn.
          if (block.type.endsWith("_tool_result") && "tool_use_id" in block) {
            const item = toolItems.get(block.tool_use_id);
            if (item) item.result = "(results used by the agent)";
          }
        }
        continue;
      }
      for (const block of blocks) {
        if (block.type === "text") items.push({ kind: "user", text: block.text, at });
        if (block.type === "tool_result") {
          const item = toolItems.get(block.tool_use_id);
          if (item) {
            item.result =
              typeof block.content === "string"
                ? block.content
                : (block.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
            item.isError = !!block.is_error;
          }
        }
      }
    }
    return items;
  }

  private async requireOwn(businessId: string, agentId: string, userId: string, conversationId: string) {
    const conversation = await prisma.agentConversation.findUnique({ where: { id: conversationId } });
    // Conversations are private: other members get the same 404 as a missing id.
    if (
      !conversation ||
      conversation.businessId !== businessId ||
      conversation.agentId !== agentId ||
      conversation.userId !== userId
    ) {
      throw new NotFoundException("Conversation not found");
    }
    return conversation;
  }

  private serialize(c: { id: string; agentId: string; title: string; createdAt: Date; updatedAt: Date }) {
    return { id: c.id, agentId: c.agentId, title: c.title, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() };
  }
}
