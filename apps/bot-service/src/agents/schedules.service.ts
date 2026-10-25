import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma, Prisma } from "@platform/database";
import { parseScheduleTrigger } from "../workflows/engine/schedule";
import { AgentScheduleQueue } from "./schedule-queue";

export interface ScheduleInput {
  agentId?: unknown;
  name?: unknown;
  prompt?: unknown;
  enabled?: unknown;
  trigger?: unknown;
}

const MAX_PROMPT = 20_000;

type ScheduleRow = Prisma.AgentScheduleGetPayload<{ include: { agent: { select: { name: true } } } }>;

@Injectable()
export class SchedulesService {
  constructor(private readonly queue: AgentScheduleQueue) {}

  async list(businessId: string, agentId?: string) {
    const [schedules, next] = await Promise.all([
      prisma.agentSchedule.findMany({
        where: { businessId, ...(agentId ? { agentId } : {}) },
        include: { agent: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      }),
      this.queue.nextRuns(),
    ]);
    // Latest run of each schedule, for its status column.
    const lastRuns = schedules.length
      ? await prisma.agentRun.findMany({
          where: { scheduleId: { in: schedules.map((s) => s.id) } },
          distinct: ["scheduleId"],
          orderBy: { startedAt: "desc" },
          select: { id: true, scheduleId: true, status: true, startedAt: true },
        })
      : [];
    return schedules.map((s) => {
      const last = lastRuns.find((r) => r.scheduleId === s.id);
      return {
        ...this.serialize(s),
        nextRunAt: next.get(s.id)?.toISOString(),
        lastRun: last ? { id: last.id, status: last.status, startedAt: last.startedAt.toISOString() } : undefined,
      };
    });
  }

  async create(businessId: string, userId: string, input: ScheduleInput) {
    const agentId = await this.validAgent(businessId, input.agentId);
    const schedule = await prisma.agentSchedule.create({
      data: {
        businessId,
        agentId,
        name: this.validName(input.name),
        prompt: this.validPrompt(input.prompt),
        enabled: input.enabled === undefined ? true : this.validEnabled(input.enabled),
        trigger: this.validTrigger(input.trigger),
        createdById: userId,
      },
      include: { agent: { select: { name: true } } },
    });
    await this.queue.sync(schedule);
    return this.serialize(schedule);
  }

  async update(businessId: string, id: string, input: ScheduleInput) {
    await this.require(businessId, id);
    const schedule = await prisma.agentSchedule.update({
      where: { id },
      data: {
        ...(input.agentId !== undefined ? { agentId: await this.validAgent(businessId, input.agentId) } : {}),
        ...(input.name !== undefined ? { name: this.validName(input.name) } : {}),
        ...(input.prompt !== undefined ? { prompt: this.validPrompt(input.prompt) } : {}),
        ...(input.enabled !== undefined ? { enabled: this.validEnabled(input.enabled) } : {}),
        ...(input.trigger !== undefined ? { trigger: this.validTrigger(input.trigger) } : {}),
      },
      include: { agent: { select: { name: true } } },
    });
    await this.queue.sync(schedule);
    return this.serialize(schedule);
  }

  async remove(businessId: string, id: string) {
    await this.require(businessId, id);
    await prisma.agentSchedule.delete({ where: { id } });
    await this.queue.remove(id);
  }

  /** Runs it once now (even if paused), as the user who asked. */
  async runNow(businessId: string, id: string, userId: string) {
    await this.require(businessId, id);
    await this.queue.runNow(id, userId);
    return { queued: true };
  }

  private async require(businessId: string, id: string) {
    const schedule = await prisma.agentSchedule.findUnique({ where: { id } });
    if (!schedule || schedule.businessId !== businessId) throw new NotFoundException("Schedule not found");
    return schedule;
  }

  private async validAgent(businessId: string, agentId: unknown) {
    if (typeof agentId !== "string") throw new BadRequestException("Choose an agent");
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { businessId: true } });
    if (!agent || agent.businessId !== businessId) throw new BadRequestException("Choose an agent");
    return agentId;
  }

  private validName(name: unknown) {
    if (typeof name !== "string" || !name.trim()) throw new BadRequestException("name is required");
    return name.trim().slice(0, 60);
  }

  private validPrompt(prompt: unknown) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new BadRequestException("Tell the agent what to do on each run");
    if (prompt.length > MAX_PROMPT) throw new BadRequestException(`prompt must be at most ${MAX_PROMPT.toLocaleString()} characters`);
    return prompt.trim();
  }

  private validEnabled(enabled: unknown) {
    if (typeof enabled !== "boolean") throw new BadRequestException("enabled must be true or false");
    return enabled;
  }

  private validTrigger(trigger: unknown): Prisma.InputJsonValue {
    const t = trigger && typeof trigger === "object" ? (trigger as Record<string, unknown>) : {};
    // Shortest interval allowed for agents: they're far heavier than workflow steps.
    if (t.frequency === "minutes") throw new BadRequestException("Agents can run at most once an hour");
    return parseScheduleTrigger(t) as unknown as Prisma.InputJsonValue;
  }

  private serialize(s: ScheduleRow) {
    return {
      id: s.id,
      agentId: s.agentId,
      agentName: s.agent.name,
      name: s.name,
      prompt: s.prompt,
      enabled: s.enabled,
      trigger: s.trigger,
      createdById: s.createdById,
      lastRunAt: s.lastRunAt?.toISOString(),
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }
}
