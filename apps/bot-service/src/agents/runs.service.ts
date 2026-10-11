import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import type { BusinessContext } from "@platform/shared-types";

const RUN_STATUSES = ["running", "succeeded", "failed"];

@Injectable()
export class RunsService {
  /**
   * Run history. Runs echo chat content, so people only see their own runs
   * unless they can manage agents (agents:write), who see everyone's.
   */
  async list(ctx: BusinessContext, filters: { agentId?: string; status?: string; limit?: string; before?: string }) {
    if (filters.status && !RUN_STATUSES.includes(filters.status)) {
      throw new BadRequestException(`status must be one of: ${RUN_STATUSES.join(", ")}`);
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 100);
    const runs = await prisma.agentRun.findMany({
      where: {
        businessId: ctx.businessId,
        ...(this.seesAll(ctx) ? {} : { userId: ctx.userId }),
        ...(filters.agentId ? { agentId: filters.agentId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.before ? { startedAt: { lt: new Date(filters.before) } } : {}),
      },
      include: { agent: { select: { name: true } }, _count: { select: { steps: { where: { type: "tool" } } } } },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
    return runs.map((run) => ({
      ...this.serialize(run),
      agentName: run.agent.name,
      toolCalls: run._count.steps,
    }));
  }

  async get(ctx: BusinessContext, runId: string) {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: { agent: { select: { name: true } }, steps: { orderBy: { index: "asc" } } },
    });
    if (!run || run.businessId !== ctx.businessId || (!this.seesAll(ctx) && run.userId !== ctx.userId)) {
      throw new NotFoundException("Run not found");
    }
    return {
      ...this.serialize(run),
      agentName: run.agent.name,
      steps: run.steps.map((s) => ({
        index: s.index,
        type: s.type,
        name: s.name,
        input: s.input,
        output: s.output,
        isError: s.isError,
        durationMs: s.durationMs,
        createdAt: s.createdAt.toISOString(),
      })),
    };
  }

  private seesAll(ctx: BusinessContext) {
    return ctx.permissions.includes("agents:write");
  }

  private serialize(run: {
    id: string;
    agentId: string;
    conversationId: string | null;
    userId: string | null;
    trigger: string;
    status: string;
    model: string;
    input: string;
    output: string | null;
    error: string | null;
    inputTokens: number;
    outputTokens: number;
    startedAt: Date;
    finishedAt: Date | null;
  }) {
    return {
      id: run.id,
      agentId: run.agentId,
      conversationId: run.conversationId ?? undefined,
      userId: run.userId ?? undefined,
      trigger: run.trigger,
      status: run.status,
      model: run.model,
      input: run.input,
      output: run.output ?? undefined,
      error: run.error ?? undefined,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString(),
      durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : undefined,
    };
  }
}
