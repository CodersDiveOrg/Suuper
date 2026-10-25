import { BadRequestException, Injectable } from "@nestjs/common";
import { prisma } from "@platform/database";
import {
  isPlanKey,
  monthBounds,
  PLANS,
  USAGE_METERS,
  type UsageFeature,
  type UsageSummary,
} from "@platform/shared-types";
import { estimateCostUsd } from "../agents/runtime/models";
import { planOf, usageOf } from "./quota";

const FEATURES: UsageFeature[] = ["bot", "agent", "workflow", "app"];
// How far back the month picker goes.
const MAX_MONTHS_BACK = 12;

interface DayRow {
  day: Date;
  feature: string;
  tokens: bigint;
  replies: bigint;
}

@Injectable()
export class UsageService {
  plans() {
    return { plans: PLANS, meters: USAGE_METERS };
  }

  /** Changing the plan takes effect immediately (no billing is attached yet). */
  async setPlan(businessId: string, plan: unknown) {
    if (!isPlanKey(plan)) throw new BadRequestException(`plan must be one of: ${PLANS.map((p) => p.key).join(", ")}`);
    await prisma.business.update({ where: { id: businessId }, data: { plan } });
    return this.summary(businessId);
  }

  /** `month` is "YYYY-MM" (UTC); defaults to the current month. */
  async summary(businessId: string, month?: string): Promise<UsageSummary> {
    const period = this.period(month);
    const current = period.start.getTime() === monthBounds().start.getTime();
    const plan = await planOf(businessId);
    const inPeriod = { gte: period.start, lt: period.end };

    const meters = await Promise.all(
      USAGE_METERS.map(async (meter) => ({ ...meter, used: await usageOf(businessId, meter.key, period), limit: plan.limits[meter.key] })),
    );

    const [days, agentDays, workflowDays, features, models] = await Promise.all([
      prisma.$queryRaw<DayRow[]>`
        SELECT date_trunc('day', "createdAt") AS day, feature,
          SUM("inputTokens" + "outputTokens") FILTER (WHERE type = 'ai_call') AS tokens,
          COUNT(*) FILTER (WHERE type = 'bot_reply') AS replies
        FROM "UsageEvent"
        WHERE "businessId" = ${businessId} AND "createdAt" >= ${period.start} AND "createdAt" < ${period.end}
        GROUP BY 1, 2
      `,
      prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "startedAt") AS day, COUNT(*) AS count FROM "AgentRun"
        WHERE "businessId" = ${businessId} AND "startedAt" >= ${period.start} AND "startedAt" < ${period.end}
        GROUP BY 1
      `,
      prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "startedAt") AS day, COUNT(*) AS count FROM "WorkflowRun"
        WHERE "businessId" = ${businessId} AND "startedAt" >= ${period.start} AND "startedAt" < ${period.end}
        GROUP BY 1
      `,
      prisma.usageEvent.groupBy({
        by: ["feature"],
        where: { businessId, type: "ai_call", createdAt: inPeriod },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      prisma.usageEvent.groupBy({
        by: ["model", "provider"],
        where: { businessId, type: "ai_call", createdAt: inPeriod },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
    ]);

    // Every day of the period, up to today for the current month.
    const last = current ? new Date() : new Date(period.end.getTime() - 1);
    const daily: UsageSummary["daily"] = [];
    for (let d = new Date(period.start); d <= last; d = new Date(d.getTime() + 86_400_000)) {
      daily.push({ date: d.toISOString().slice(0, 10), tokens: { bot: 0, agent: 0, workflow: 0, app: 0 }, replies: 0, agentRuns: 0, workflowRuns: 0 });
    }
    const dayOf = (date: Date) => daily.find((x) => x.date === date.toISOString().slice(0, 10));
    for (const row of days) {
      const day = dayOf(row.day);
      if (!day) continue;
      if (FEATURES.includes(row.feature as UsageFeature)) day.tokens[row.feature as UsageFeature] += Number(row.tokens ?? 0);
      day.replies += Number(row.replies ?? 0);
    }
    for (const row of agentDays) {
      const day = dayOf(row.day);
      if (day) day.agentRuns += Number(row.count);
    }
    for (const row of workflowDays) {
      const day = dayOf(row.day);
      if (day) day.workflowRuns += Number(row.count);
    }

    const byModel = models
      .map((m) => {
        const inputTokens = m._sum.inputTokens ?? 0;
        const outputTokens = m._sum.outputTokens ?? 0;
        return {
          model: m.model ?? "unknown",
          provider: m.provider ?? "unknown",
          calls: m._count._all,
          inputTokens,
          outputTokens,
          costUsd: estimateCostUsd(m.model ?? "", inputTokens, outputTokens),
        };
      })
      .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

    // A feature's cost is the sum over the models it used.
    const featureCost = await this.costByFeature(businessId, inPeriod);
    const byFeature = FEATURES.map((feature) => {
      const row = features.find((f) => f.feature === feature);
      return {
        feature,
        calls: row?._count._all ?? 0,
        inputTokens: row?._sum.inputTokens ?? 0,
        outputTokens: row?._sum.outputTokens ?? 0,
        costUsd: featureCost.get(feature) ?? 0,
      };
    });

    const { limits: _limits, ...planInfo } = plan;
    return {
      plan: planInfo,
      period: { start: period.start.toISOString(), end: period.end.toISOString(), current },
      meters,
      daily,
      byFeature,
      byModel,
    };
  }

  private async costByFeature(businessId: string, createdAt: { gte: Date; lt: Date }) {
    const rows = await prisma.usageEvent.groupBy({
      by: ["feature", "model"],
      where: { businessId, type: "ai_call", createdAt },
      _sum: { inputTokens: true, outputTokens: true },
    });
    const cost = new Map<string, number>();
    for (const r of rows) {
      cost.set(r.feature, (cost.get(r.feature) ?? 0) + estimateCostUsd(r.model ?? "", r._sum.inputTokens ?? 0, r._sum.outputTokens ?? 0));
    }
    return cost;
  }

  private period(month?: string) {
    if (!month) return monthBounds();
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) throw new BadRequestException('month must look like "2026-10"');
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
    const now = monthBounds().start;
    const earliest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MAX_MONTHS_BACK, 1));
    if (Number.isNaN(date.getTime()) || date > now || date < earliest) {
      throw new BadRequestException(`month must be within the last ${MAX_MONTHS_BACK} months`);
    }
    return monthBounds(date);
  }
}
