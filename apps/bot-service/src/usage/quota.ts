import { HttpException, HttpStatus } from "@nestjs/common";
import { knowledgeStorageBytes, memberSeats, prisma } from "@platform/database";
import { monthBounds, planFor, quotaExceededBody, type PlanDefinition, type UsageMeterKey } from "@platform/shared-types";
import { findModel, providerKey } from "../agents/runtime/models";

/** 402 with a message people can act on; `code` lets clients tell it apart from other errors. */
export class QuotaExceededException extends HttpException {
  constructor(
    readonly meter: UsageMeterKey,
    plan: PlanDefinition,
  ) {
    super(quotaExceededBody(meter, plan), HttpStatus.PAYMENT_REQUIRED);
  }
}

export async function planOf(businessId: string): Promise<PlanDefinition> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { plan: true } });
  return planFor(business?.plan);
}

/** Current value of a meter: this month's for monthly meters, what exists now for totals. */
export async function usageOf(businessId: string, meter: UsageMeterKey, period = monthBounds()): Promise<number> {
  const inPeriod = { gte: period.start, lt: period.end };
  switch (meter) {
    case "ai_replies":
      return prisma.usageEvent.count({ where: { businessId, type: "bot_reply", createdAt: inPeriod } });
    case "ai_credits": {
      // Own-key and local-model calls are recorded with 0 credits.
      const sum = await prisma.usageEvent.aggregate({
        where: { businessId, type: "ai_call", createdAt: inPeriod },
        _sum: { credits: true },
      });
      return sum._sum.credits ?? 0;
    }
    case "agent_runs":
      return prisma.agentRun.count({ where: { businessId, startedAt: inPeriod } });
    case "workflow_runs":
      return prisma.workflowRun.count({ where: { businessId, startedAt: inPeriod } });
    case "bots":
      return prisma.bot.count({ where: { businessId } });
    case "members":
      return memberSeats(businessId);
    case "knowledge_storage":
      return knowledgeStorageBytes(businessId);
    case "app_records":
      // Sample data that comes with a new app doesn't count.
      return prisma.appRecord.count({ where: { businessId, source: { not: "sample" } } });
  }
}

/**
 * Throws QuotaExceededException for the first meter already at its limit.
 * `alreadyCounted` is for meters whose row was created before the check (a
 * queued workflow run counts itself), so the check is "over" rather than "at".
 */
export async function assertWithinQuota(businessId: string, meters: UsageMeterKey[], options: { alreadyCounted?: boolean } = {}) {
  const plan = await planOf(businessId);
  for (const meter of meters) {
    const used = await usageOf(businessId, meter);
    const limit = plan.limits[meter];
    if (options.alreadyCounted ? used > limit : used >= limit) throw new QuotaExceededException(meter, plan);
  }
}

/**
 * ["ai_credits"] when a call to this model would spend the plan's credits
 * (Suuper's key), [] when it's free (a local model, or the business's own key),
 * so free models keep working after the credits run out.
 */
export async function creditMetersFor(businessId: string, modelId: string | undefined): Promise<UsageMeterKey[]> {
  const model = modelId ? findModel(modelId) : undefined;
  if (!model || model.provider === "ollama") return [];
  const key = await providerKey(businessId, model.provider);
  return key && !key.ownKey ? ["ai_credits"] : [];
}
