import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { prisma, Prisma } from "@platform/database";
import { emitWebhookEvent } from "../../webhooks/delivery";
import { estimateCostUsd, findModel } from "./models";
import { createProvider } from "./providers";
import type { ContentBlockParam, MessageParam, ModelProvider } from "./providers/types";
import { loadSkills, withSkills } from "./skills";
import { buildToolSet } from "./toolset";
import { withUsage } from "../../usage/meter";
import { assertWithinQuota, creditMetersFor } from "../../usage/quota";

type AgentRunRow = Prisma.AgentRunGetPayload<object>;

/** agent.run.succeeded / agent.run.failed for a finished run. */
export function emitAgentRunEvent(run: AgentRunRow) {
  emitWebhookEvent(run.businessId, run.status === "succeeded" ? "agent.run.succeeded" : "agent.run.failed", async () => {
    const agent = await prisma.agent.findUnique({ where: { id: run.agentId }, select: { name: true } });
    return {
      agent: { id: run.agentId, name: agent?.name ?? "" },
      run: {
        id: run.id,
        trigger: run.trigger,
        status: run.status,
        output: run.output,
        error: run.error,
        model: run.model,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costUsd: estimateCostUsd(run.model, run.inputTokens, run.outputTokens),
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
      },
    };
  });
}

/** Streamed to the client while a run is in progress (SSE event name = type). */
export type RunEvent =
  | { type: "run_started"; runId: string; conversationId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; isError: boolean; preview: string }
  | { type: "run_finished"; runId: string; status: "succeeded" | "failed"; output: string; usage: { inputTokens: number; outputTokens: number }; error?: string };

interface AgentForRun {
  id: string;
  businessId: string;
  systemPrompt: string;
  model: string;
  tools: string[];
  maxSteps: number;
  knowledgeBaseIds: string[];
  mcpServerIds: string[];
  integrations: string[];
  skillIds: string[];
}

interface RunParams {
  agent: AgentForRun;
  conversationId: string;
  userId: string;
  input: string;
  emit: (event: RunEvent) => void;
  trigger?: "chat" | "schedule";
  scheduleId?: string;
}

// A "running" run older than this is treated as crashed and no longer blocks the conversation.
const STALE_RUN_MS = 15 * 60 * 1000;

function textOf(content: ContentBlockParam[]) {
  return content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

@Injectable()
export class AgentRunner {
  private readonly logger = new Logger(AgentRunner.name);

  /**
   * Runs one user message through the agent to a final answer: model call →
   * tool calls → model call … up to agent.maxSteps model calls. Everything is
   * persisted as it happens (messages append-only, plus a run + steps record),
   * so a dropped client connection doesn't lose work.
   */
  async run(params: RunParams) {
    await assertWithinQuota(params.agent.businessId, ["agent_runs", ...(await creditMetersFor(params.agent.businessId, params.agent.model))]);
    return withUsage(params.agent.businessId, "agent", () => this.execute(params));
  }

  private async execute(params: RunParams) {
    const { agent, conversationId, userId, emit } = params;
    const input = params.input.trim();
    if (!input) throw new BadRequestException("message is required");
    if (input.length > 20_000) throw new BadRequestException("message must be at most 20,000 characters");

    const model = findModel(agent.model);
    if (!model) throw new BadRequestException(`Unknown model "${agent.model}". Edit the agent and pick a model.`);
    const provider: ModelProvider = await createProvider(agent.businessId, model);

    const active = await prisma.agentRun.findFirst({
      where: { conversationId, status: "running", startedAt: { gt: new Date(Date.now() - STALE_RUN_MS) } },
    });
    if (active) throw new ConflictException("This conversation is already answering. Wait for it to finish.");

    const run = await prisma.agentRun.create({
      data: {
        businessId: agent.businessId,
        agentId: agent.id,
        conversationId,
        userId,
        trigger: params.trigger ?? "chat",
        scheduleId: params.scheduleId,
        model: agent.model,
        input,
      },
    });
    emit({ type: "run_started", runId: run.id, conversationId });

    const history = await prisma.agentMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true },
    });
    const messages: MessageParam[] = history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content as unknown as ContentBlockParam[],
    }));

    const append = async (role: "user" | "assistant", content: ContentBlockParam[]) => {
      messages.push({ role, content });
      await prisma.agentMessage.create({ data: { conversationId, runId: run.id, role, content: json(content) } });
    };

    const skills = await loadSkills(agent.businessId, agent.skillIds);
    const system = withSkills(agent.systemPrompt, skills);
    const toolSet = await buildToolSet({
      businessId: agent.businessId,
      provider: model.provider,
      builtInTools: [...new Set([...agent.tools, ...skills.flatMap((s) => s.tools)])],
      knowledgeBaseIds: agent.knowledgeBaseIds,
      mcpServerIds: agent.mcpServerIds,
      integrations: agent.integrations,
      source: "agent",
      userId,
    });
    const { clientTools, serverTools } = toolSet;
    const usage = { inputTokens: 0, outputTokens: 0 };
    let stepIndex = 0;
    let output = "";
    // tool_use blocks persisted without results yet — closed out if the run fails,
    // so the stored history stays valid for the next request.
    let pendingToolUses: { id: string; name: string }[] = [];

    const finish = async (status: "succeeded" | "failed", error?: string) => {
      const finished = await prisma.agentRun.update({
        where: { id: run.id },
        data: { status, output, error, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, finishedAt: new Date() },
      });
      await prisma.agentConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      emit({ type: "run_finished", runId: run.id, status, output, usage, error });
      emitAgentRunEvent(finished);
    };

    try {
      await append("user", [{ type: "text", text: input }]);

      for (let modelCalls = 0; ; modelCalls++) {
        if (modelCalls >= agent.maxSteps) {
          output += `\n\n_Stopped after ${agent.maxSteps} steps (the agent's limit)._`;
          break;
        }

        const started = Date.now();
        const turn = await provider.runTurn(
          { model: agent.model, system, messages, tools: clientTools, serverTools },
          (text) => emit({ type: "text_delta", text }),
        );
        usage.inputTokens += turn.usage.inputTokens;
        usage.outputTokens += turn.usage.outputTokens;
        await prisma.agentRunStep.create({
          data: {
            runId: run.id,
            index: stepIndex++,
            type: "model",
            name: agent.model,
            output: json({ stopReason: turn.stopReason, usage: turn.usage, text: textOf(turn.content).slice(0, 4000) }),
            durationMs: Date.now() - started,
          },
        });

        if (turn.content.length > 0) await append("assistant", turn.content);
        const text = textOf(turn.content);
        if (text) output = text;

        if (turn.stopReason === "refusal") {
          output = output || "The model declined to answer this request.";
          break;
        }
        // A provider-hosted tool (web search) paused mid-turn; send the turn back to continue.
        if (turn.stopReason === "pause_turn") continue;

        const toolUses = turn.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use");
        // A tool input cut off by max_tokens can still look valid — never run it.
        if (turn.stopReason === "max_tokens" && toolUses.length > 0) {
          throw new Error("The model's response was cut off mid tool call.");
        }
        if (turn.stopReason !== "tool_use" || toolUses.length === 0) break;

        pendingToolUses = toolUses.map((t) => ({ id: t.id, name: t.name }));
        const results = await Promise.all(
          toolUses.map(async (call) => {
            emit({ type: "tool_call", id: call.id, name: call.name, input: call.input });
            const toolStarted = Date.now();
            const result = await toolSet.execute(call.name, call.input);
            await prisma.agentRunStep.create({
              data: {
                runId: run.id,
                index: stepIndex++,
                type: "tool",
                name: call.name,
                input: json(call.input ?? {}),
                output: json({ content: result.content.slice(0, 20_000) }),
                isError: !!result.isError,
                durationMs: Date.now() - toolStarted,
              },
            });
            emit({ type: "tool_result", id: call.id, name: call.name, isError: !!result.isError, preview: result.content.slice(0, 300) });
            return { type: "tool_result" as const, tool_use_id: call.id, content: result.content, is_error: result.isError || undefined };
          }),
        );
        // All results go back in one user message (keeps parallel tool use working).
        await append("user", results);
        pendingToolUses = [];
      }

      await finish("succeeded");
    } catch (err) {
      const message = err instanceof Anthropic.APIError ? `Model error (${err.status}): ${err.message}` : (err as Error).message;
      this.logger.error(`Run ${run.id} failed: ${message}`);
      if (pendingToolUses.length) {
        await append(
          "user",
          pendingToolUses.map((t) => ({ type: "tool_result" as const, tool_use_id: t.id, content: "Run failed before this tool finished.", is_error: true })),
        ).catch(() => undefined);
      }
      await finish("failed", message);
    }
    return run.id;
  }
}
