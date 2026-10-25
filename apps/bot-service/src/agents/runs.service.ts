import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma, Prisma } from "@platform/database";
import type { BusinessContext } from "@platform/shared-types";
import { isValidTimezone } from "../workflows/engine/schedule";
import { estimateCostUsd } from "./runtime/models";

const RUN_STATUSES = ["running", "succeeded", "failed"];
const RUN_TRIGGERS = ["chat", "api", "schedule"];
const ANALYTICS_RANGES = [7, 30, 90];

type RunFilters = { agentId?: string; status?: string; trigger?: string; scheduleId?: string; limit?: string; before?: string };

@Injectable()
export class RunsService {
  /**
   * Run history. Runs echo chat content, so people only see their own runs
   * unless they can manage agents (agents:write), who see everyone's.
   */
  async list(ctx: BusinessContext, filters: RunFilters) {
    if (filters.status && !RUN_STATUSES.includes(filters.status)) {
      throw new BadRequestException(`status must be one of: ${RUN_STATUSES.join(", ")}`);
    }
    if (filters.trigger && !RUN_TRIGGERS.includes(filters.trigger)) {
      throw new BadRequestException(`trigger must be one of: ${RUN_TRIGGERS.join(", ")}`);
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 100);
    const runs = await prisma.agentRun.findMany({
      where: {
        businessId: ctx.businessId,
        ...(this.seesAll(ctx) ? {} : { userId: ctx.userId }),
        ...(filters.agentId ? { agentId: filters.agentId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.trigger ? { trigger: filters.trigger } : {}),
        ...(filters.scheduleId ? { scheduleId: filters.scheduleId } : {}),
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

  /**
   * Usage over the last `days` days, bucketed by day in `timezone`. Same
   * visibility as the run list: your own runs, or everyone's with agents:write.
   */
  async analytics(ctx: BusinessContext, query: { days?: string; timezone?: string }) {
    const days = ANALYTICS_RANGES.includes(Number(query.days)) ? Number(query.days) : 30;
    const timezone = query.timezone && isValidTimezone(query.timezone) ? query.timezone : "UTC";
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const scope = Prisma.sql`r."businessId" = ${ctx.businessId} AND r."startedAt" >= ${since}${
      this.seesAll(ctx) ? Prisma.empty : Prisma.sql` AND r."userId" = ${ctx.userId}`
    }`;
    const n = (v: bigint | number | null) => Number(v ?? 0);

    const [daily, byAgentModel, triggers, tools, agents] = await Promise.all([
      prisma.$queryRaw<{ day: string; succeeded: bigint; failed: bigint; running: bigint }[]>`
        SELECT to_char((r."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day,
               count(*) FILTER (WHERE r.status = 'succeeded') AS succeeded,
               count(*) FILTER (WHERE r.status = 'failed') AS failed,
               count(*) FILTER (WHERE r.status = 'running') AS running
        FROM "AgentRun" r WHERE ${scope} GROUP BY day`,
      prisma.$queryRaw<
        { agentId: string; model: string; runs: bigint; succeeded: bigint; failed: bigint; inputTokens: bigint; outputTokens: bigint; durationMs: number | null }[]
      >`
        SELECT r."agentId", r.model, count(*) AS runs,
               count(*) FILTER (WHERE r.status = 'succeeded') AS succeeded,
               count(*) FILTER (WHERE r.status = 'failed') AS failed,
               sum(r."inputTokens") AS "inputTokens", sum(r."outputTokens") AS "outputTokens",
               avg(extract(epoch FROM (r."finishedAt" - r."startedAt")) * 1000)::float AS "durationMs"
        FROM "AgentRun" r WHERE ${scope} GROUP BY r."agentId", r.model`,
      prisma.$queryRaw<{ trigger: string; runs: bigint }[]>`
        SELECT r.trigger, count(*) AS runs FROM "AgentRun" r WHERE ${scope} GROUP BY r.trigger ORDER BY runs DESC`,
      prisma.$queryRaw<{ name: string; calls: bigint; errors: bigint }[]>`
        SELECT s.name, count(*) AS calls, count(*) FILTER (WHERE s."isError") AS errors
        FROM "AgentRunStep" s JOIN "AgentRun" r ON r.id = s."runId"
        WHERE s.type = 'tool' AND ${scope} GROUP BY s.name ORDER BY calls DESC LIMIT 12`,
      prisma.agent.findMany({ where: { businessId: ctx.businessId }, select: { id: true, name: true } }),
    ]);

    // Per agent, summed across the models it ran on (cost depends on the model).
    const perAgent = new Map<string, { runs: number; succeeded: number; failed: number; inputTokens: number; outputTokens: number; costUsd: number; durationTotal: number }>();
    for (const row of byAgentModel) {
      const a = perAgent.get(row.agentId) ?? { runs: 0, succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationTotal: 0 };
      a.runs += n(row.runs);
      a.succeeded += n(row.succeeded);
      a.failed += n(row.failed);
      a.inputTokens += n(row.inputTokens);
      a.outputTokens += n(row.outputTokens);
      a.costUsd += estimateCostUsd(row.model, n(row.inputTokens), n(row.outputTokens));
      a.durationTotal += (row.durationMs ?? 0) * n(row.runs);
      perAgent.set(row.agentId, a);
    }
    const agentRows = [...perAgent.entries()]
      .map(([agentId, a]) => ({
        agentId,
        name: agents.find((x) => x.id === agentId)?.name ?? "Deleted agent",
        runs: a.runs,
        succeeded: a.succeeded,
        failed: a.failed,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        costUsd: a.costUsd,
        avgDurationMs: a.runs ? Math.round(a.durationTotal / a.runs) : 0,
      }))
      .sort((x, y) => y.runs - x.runs);

    const sum = (key: "runs" | "succeeded" | "failed" | "inputTokens" | "outputTokens" | "costUsd") =>
      agentRows.reduce((total, a) => total + a[key], 0);
    const totals = {
      runs: sum("runs"),
      succeeded: sum("succeeded"),
      failed: sum("failed"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      costUsd: sum("costUsd"),
      toolCalls: tools.reduce((total, t) => total + n(t.calls), 0),
      avgDurationMs: sum("runs") ? Math.round(agentRows.reduce((t, a) => t + a.avgDurationMs * a.runs, 0) / sum("runs")) : 0,
    };

    // Every day in the range, including empty ones, oldest first.
    const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: timezone });
    const byDay = new Map(daily.map((d) => [d.day, d]));
    const series = Array.from({ length: days }, (_, i) => {
      const day = dayKey(new Date(Date.now() - (days - 1 - i) * 24 * 3600 * 1000));
      const row = byDay.get(day);
      return { date: day, succeeded: n(row?.succeeded ?? 0), failed: n(row?.failed ?? 0), running: n(row?.running ?? 0) };
    });

    return {
      days,
      timezone,
      scope: this.seesAll(ctx) ? "business" : "mine",
      totals,
      daily: series,
      agents: agentRows,
      triggers: triggers.map((t) => ({ trigger: t.trigger, runs: n(t.runs) })),
      tools: tools.map((t) => ({ name: t.name, calls: n(t.calls), errors: n(t.errors) })),
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
    scheduleId: string | null;
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
      scheduleId: run.scheduleId ?? undefined,
      status: run.status,
      model: run.model,
      input: run.input,
      output: run.output ?? undefined,
      error: run.error ?? undefined,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costUsd: estimateCostUsd(run.model, run.inputTokens, run.outputTokens),
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString(),
      durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : undefined,
    };
  }
}
