import { Injectable } from "@nestjs/common";
import { prisma, Prisma } from "@platform/database";
import type { BusinessContext } from "@platform/shared-types";
import { isValidTimezone } from "../workflows/engine/schedule";
import { estimateCostUsd } from "../agents/runtime/models";

const RANGES = [7, 30, 90];
const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

/** Day buckets as YYYY-MM-DD in the viewer's timezone. */
const localDay = (column: Prisma.Sql, timezone: string) =>
  Prisma.sql`to_char((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${timezone}, 'YYYY-MM-DD')`;

/**
 * Workspace overview for Dashboard → Analytics: bot conversations, agent runs,
 * workflow runs, app records and MCP tool calls over the last `days` days.
 * Each section is only computed when the caller may read that area.
 */
@Injectable()
export class AnalyticsService {
  async overview(ctx: BusinessContext, query: { days?: string; timezone?: string }) {
    const days = RANGES.includes(Number(query.days)) ? Number(query.days) : 30;
    const timezone = query.timezone && isValidTimezone(query.timezone) ? query.timezone : "UTC";
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const can = (p: string) => ctx.permissions.includes(p as never);

    const [bots, agents, workflows, apps, mcp] = await Promise.all([
      can("bots:read") ? this.bots(ctx.businessId, since, timezone) : undefined,
      can("agents:read") ? this.agents(ctx, since, timezone) : undefined,
      can("workflows:read") ? this.workflows(ctx.businessId, since, timezone) : undefined,
      can("apps:read") ? this.apps(ctx.businessId, since) : undefined,
      can("mcp:read") ? this.mcp(ctx.businessId, since) : undefined,
    ]);

    // Every day in the range, oldest first, with each activity's count.
    const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: timezone });
    const daily = Array.from({ length: days }, (_, i) => {
      const date = dayKey(new Date(Date.now() - (days - 1 - i) * 24 * 3600 * 1000));
      return {
        date,
        conversations: bots?.byDay.get(date) ?? 0,
        agentRuns: agents?.byDay.get(date) ?? 0,
        workflowRuns: workflows?.byDay.get(date) ?? 0,
      };
    });
    const strip = <T extends { byDay: unknown }>(section: T | undefined) => {
      if (!section) return undefined;
      const { byDay: _byDay, ...rest } = section;
      return rest;
    };

    return {
      days,
      timezone,
      daily,
      bots: strip(bots),
      agents: strip(agents),
      workflows: strip(workflows),
      apps,
      mcp,
    };
  }

  private async bots(businessId: string, since: Date, timezone: string) {
    const scope = Prisma.sql`c."businessId" = ${businessId} AND c."startedAt" >= ${since}`;
    const [byDay, perBot, replies, unanswered, botRows] = await Promise.all([
      prisma.$queryRaw<{ day: string; count: bigint }[]>`
        SELECT ${localDay(Prisma.sql`c."startedAt"`, timezone)} AS day, count(*) AS count
        FROM "BotConversation" c WHERE ${scope} GROUP BY day`,
      prisma.$queryRaw<{ botId: string; source: string; conversations: bigint; questions: bigint; fullyAnswered: bigint }[]>`
        SELECT c."botId", c.source, count(*) AS conversations, sum(c."messageCount") / 2 AS questions,
               count(*) FILTER (WHERE c."issueCount" = 0) AS "fullyAnswered"
        FROM "BotConversation" c WHERE ${scope} GROUP BY c."botId", c.source`,
      prisma.$queryRaw<{ botId: string; outcome: string; count: bigint; avgMs: number | null }[]>`
        SELECT c."botId", m.outcome, count(*) AS count, avg(m."durationMs")::float AS "avgMs"
        FROM "BotMessage" m JOIN "BotConversation" c ON c.id = m."conversationId"
        WHERE m.role = 'assistant' AND ${scope} GROUP BY c."botId", m.outcome`,
      // Latest questions the bots couldn't answer: gaps to fill in their knowledge.
      prisma.$queryRaw<{ question: string; at: Date; botId: string; conversationId: string }[]>`
        SELECT q.content AS question, q."createdAt" AS at, c."botId", c.id AS "conversationId"
        FROM "BotMessage" a
        JOIN "BotConversation" c ON c.id = a."conversationId"
        JOIN LATERAL (
          SELECT content, "createdAt" FROM "BotMessage" u
          WHERE u."conversationId" = a."conversationId" AND u.role = 'user' AND u."createdAt" < a."createdAt"
          ORDER BY u."createdAt" DESC LIMIT 1
        ) q ON true
        WHERE a.outcome = 'unanswered' AND ${scope}
        ORDER BY a."createdAt" DESC LIMIT 10`,
      prisma.bot.findMany({ where: { businessId }, select: { id: true, name: true } }),
    ]);

    const name = (id: string) => botRows.find((b) => b.id === id)?.name ?? "Deleted bot";
    const ids = [...new Set([...perBot.map((r) => r.botId), ...replies.map((r) => r.botId)])];
    const perBotRows = ids
      .map((botId) => {
        const convs = perBot.filter((r) => r.botId === botId);
        const outcomes = replies.filter((r) => r.botId === botId);
        const count = (o: string) => n(outcomes.find((r) => r.outcome === o)?.count);
        return {
          botId,
          name: name(botId),
          conversations: convs.reduce((t, r) => t + n(r.conversations), 0),
          fullyAnswered: convs.reduce((t, r) => t + n(r.fullyAnswered), 0),
          questions: convs.reduce((t, r) => t + n(r.questions), 0),
          widget: n(convs.find((r) => r.source === "widget")?.conversations),
          playground: n(convs.find((r) => r.source === "playground")?.conversations),
          answered: count("answered"),
          unanswered: count("unanswered"),
          errors: count("error"),
        };
      })
      .sort((a, b) => b.conversations - a.conversations);

    const total = (key: "conversations" | "fullyAnswered" | "questions" | "widget" | "playground" | "answered" | "unanswered" | "errors") =>
      perBotRows.reduce((t, r) => t + r[key], 0);
    const replyCount = replies.reduce((t, r) => t + n(r.count), 0);
    return {
      byDay: new Map(byDay.map((d) => [d.day, n(d.count)])),
      conversations: total("conversations"),
      fullyAnswered: total("fullyAnswered"),
      questions: total("questions"),
      widget: total("widget"),
      playground: total("playground"),
      answered: total("answered"),
      unanswered: total("unanswered"),
      errors: total("errors"),
      avgReplyMs: replyCount ? Math.round(replies.reduce((t, r) => t + (r.avgMs ?? 0) * n(r.count), 0) / replyCount) : 0,
      perBot: perBotRows,
      unansweredQuestions: unanswered.map((u) => ({
        question: u.question.slice(0, 300),
        botId: u.botId,
        botName: name(u.botId),
        conversationId: u.conversationId,
        at: u.at.toISOString(),
      })),
    };
  }

  /** Same visibility as Agents → Runs: everyone's with agents:write, else your own. */
  private async agents(ctx: BusinessContext, since: Date, timezone: string) {
    const scope = Prisma.sql`r."businessId" = ${ctx.businessId} AND r."startedAt" >= ${since}${
      ctx.permissions.includes("agents:write") ? Prisma.empty : Prisma.sql` AND r."userId" = ${ctx.userId}`
    }`;
    const [byDay, byModel] = await Promise.all([
      prisma.$queryRaw<{ day: string; count: bigint }[]>`
        SELECT ${localDay(Prisma.sql`r."startedAt"`, timezone)} AS day, count(*) AS count
        FROM "AgentRun" r WHERE ${scope} GROUP BY day`,
      prisma.$queryRaw<{ model: string; runs: bigint; succeeded: bigint; failed: bigint; inputTokens: bigint; outputTokens: bigint }[]>`
        SELECT r.model, count(*) AS runs,
               count(*) FILTER (WHERE r.status = 'succeeded') AS succeeded,
               count(*) FILTER (WHERE r.status = 'failed') AS failed,
               sum(r."inputTokens") AS "inputTokens", sum(r."outputTokens") AS "outputTokens"
        FROM "AgentRun" r WHERE ${scope} GROUP BY r.model`,
    ]);
    const sum = (key: "runs" | "succeeded" | "failed" | "inputTokens" | "outputTokens") => byModel.reduce((t, r) => t + n(r[key]), 0);
    return {
      byDay: new Map(byDay.map((d) => [d.day, n(d.count)])),
      scope: ctx.permissions.includes("agents:write") ? ("business" as const) : ("mine" as const),
      runs: sum("runs"),
      succeeded: sum("succeeded"),
      failed: sum("failed"),
      tokens: sum("inputTokens") + sum("outputTokens"),
      costUsd: byModel.reduce((t, r) => t + estimateCostUsd(r.model, n(r.inputTokens), n(r.outputTokens)), 0),
    };
  }

  private async workflows(businessId: string, since: Date, timezone: string) {
    const scope = Prisma.sql`r."businessId" = ${businessId} AND r."startedAt" >= ${since}`;
    const [byDay, perWorkflow] = await Promise.all([
      prisma.$queryRaw<{ day: string; count: bigint }[]>`
        SELECT ${localDay(Prisma.sql`r."startedAt"`, timezone)} AS day, count(*) AS count
        FROM "WorkflowRun" r WHERE ${scope} GROUP BY day`,
      prisma.$queryRaw<{ workflowId: string; name: string; runs: bigint; succeeded: bigint; failed: bigint }[]>`
        SELECT r."workflowId", w.name, count(*) AS runs,
               count(*) FILTER (WHERE r.status = 'succeeded') AS succeeded,
               count(*) FILTER (WHERE r.status = 'failed') AS failed
        FROM "WorkflowRun" r JOIN "Workflow" w ON w.id = r."workflowId"
        WHERE ${scope} GROUP BY r."workflowId", w.name ORDER BY runs DESC`,
    ]);
    const rows = perWorkflow.map((w) => ({ workflowId: w.workflowId, name: w.name, runs: n(w.runs), succeeded: n(w.succeeded), failed: n(w.failed) }));
    return {
      byDay: new Map(byDay.map((d) => [d.day, n(d.count)])),
      runs: rows.reduce((t, r) => t + r.runs, 0),
      succeeded: rows.reduce((t, r) => t + r.succeeded, 0),
      failed: rows.reduce((t, r) => t + r.failed, 0),
      top: rows.slice(0, 5),
    };
  }

  /** Records added in the period (sample data excluded), and how many came from public forms. */
  private async apps(businessId: string, since: Date) {
    const rows = await prisma.$queryRaw<{ appId: string; name: string; records: bigint; public: bigint }[]>`
      SELECT a.id AS "appId", a.name, count(r.id) AS records, count(r.id) FILTER (WHERE r.source = 'public') AS public
      FROM "App" a JOIN "AppRecord" r ON r."appId" = a.id
      WHERE a."businessId" = ${businessId} AND r."createdAt" >= ${since} AND r.source <> 'sample'
      GROUP BY a.id, a.name ORDER BY records DESC`;
    const perApp = rows.map((r) => ({ appId: r.appId, name: r.name, records: n(r.records), public: n(r.public) }));
    return {
      records: perApp.reduce((t, r) => t + r.records, 0),
      publicSubmissions: perApp.reduce((t, r) => t + r.public, 0),
      top: perApp.slice(0, 5),
    };
  }

  private async mcp(businessId: string, since: Date) {
    const [calls, errors] = await Promise.all([
      prisma.mcpToolCall.count({ where: { businessId, createdAt: { gte: since }, source: { not: "test" } } }),
      prisma.mcpToolCall.count({ where: { businessId, createdAt: { gte: since }, source: { not: "test" }, isError: true } }),
    ]);
    return { calls, errors };
  }
}
