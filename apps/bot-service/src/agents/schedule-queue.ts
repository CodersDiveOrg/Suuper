import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "@platform/database";
import { loadServiceConfig } from "@platform/shared-config";
import { toCron, type ScheduleTrigger } from "../workflows/engine/schedule";
import { AgentRunner, emitAgentRunEvent } from "./runtime/agent-runner";

const config = loadServiceConfig("bot-service", 3002);
const QUEUE = "run-agent-schedule";
// Agent runs are long model loops on a shared single-core server: one at a time.
const CONCURRENCY = 1;
const schedulerId = (scheduleId: string) => `agent-schedule:${scheduleId}`;

/** A schedule firing, or "Run now" (manual, run as the user who pressed it). */
type ScheduleJob = { scheduleId: string; manual?: boolean; userId?: string };

@Injectable()
export class AgentScheduleQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentScheduleQueue.name);
  private readonly connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  private readonly queue = new Queue<ScheduleJob>(QUEUE, {
    connection: this.connection,
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000 },
  });
  private worker?: Worker<ScheduleJob>;

  constructor(private readonly runner: AgentRunner) {}

  async onModuleInit() {
    this.worker = new Worker<ScheduleJob>(QUEUE, (job) => this.process(job.data), {
      connection: this.connection,
      concurrency: CONCURRENCY,
    });
    this.worker.on("failed", (job, error) => this.logger.error(`schedule job ${job?.id} failed: ${error.message}`));
    await this.reconcile();
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
  }

  /** Adds, updates or removes the schedule's repeat to match its trigger and on/off state. */
  async sync(schedule: { id: string; enabled: boolean; trigger: unknown }) {
    if (schedule.enabled) {
      const trigger = schedule.trigger as ScheduleTrigger;
      await this.queue.upsertJobScheduler(
        schedulerId(schedule.id),
        { pattern: toCron(trigger), tz: trigger.timezone },
        { name: "scheduled", data: { scheduleId: schedule.id } },
      );
    } else {
      await this.remove(schedule.id);
    }
  }

  async remove(scheduleId: string) {
    await this.queue.removeJobScheduler(schedulerId(scheduleId));
  }

  async runNow(scheduleId: string, userId: string) {
    await this.queue.add("manual", { scheduleId, manual: true, userId });
  }

  /** Next firing time per schedule id, for the ones that are on. */
  async nextRuns(): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    for (const s of await this.queue.getJobSchedulers()) {
      const id = s.id ?? s.key;
      if (id?.startsWith("agent-schedule:") && s.next) out.set(id.slice("agent-schedule:".length), new Date(s.next));
    }
    return out;
  }

  private async process(job: ScheduleJob) {
    const schedule = await prisma.agentSchedule.findUnique({ where: { id: job.scheduleId }, include: { agent: true } });
    // Turned off (or deleted) since the job was queued.
    if (!schedule || (!job.manual && !schedule.enabled)) return;

    const { agent } = schedule;
    const userId = job.userId ?? schedule.createdById;
    const timezone = (schedule.trigger as ScheduleTrigger).timezone;
    const stamp = new Date().toLocaleString("en-GB", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
    const conversation = await prisma.agentConversation.create({
      data: { businessId: schedule.businessId, agentId: agent.id, userId, title: `${schedule.name} · ${stamp}`.slice(0, 80) },
    });
    await prisma.agentSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: new Date() } });

    try {
      await this.runner.run({
        agent,
        conversationId: conversation.id,
        userId,
        input: schedule.prompt,
        emit: () => undefined,
        trigger: "schedule",
        scheduleId: schedule.id,
      });
    } catch (err) {
      // Failed before the run started (e.g. no Anthropic key): record it so it shows in Runs.
      const error = (err as Error).message;
      this.logger.warn(`Schedule ${schedule.id} couldn't start: ${error}`);
      await prisma.agentConversation.delete({ where: { id: conversation.id } }).catch(() => undefined);
      const failed = await prisma.agentRun.create({
        data: {
          businessId: schedule.businessId,
          agentId: agent.id,
          userId,
          trigger: "schedule",
          scheduleId: schedule.id,
          status: "failed",
          model: agent.model,
          input: schedule.prompt,
          error,
          finishedAt: new Date(),
        },
      });
      emitAgentRunEvent(failed);
    }
  }

  /** Schedulers live in Redis; bring them back in line with the database on startup. */
  private async reconcile() {
    const schedules = await prisma.agentSchedule.findMany({
      where: { enabled: true },
      select: { id: true, enabled: true, trigger: true },
    });
    const wanted = new Set(schedules.map((s) => schedulerId(s.id)));
    for (const existing of await this.queue.getJobSchedulers()) {
      const id = existing.id ?? existing.key;
      if (id && !wanted.has(id)) await this.queue.removeJobScheduler(id);
    }
    for (const schedule of schedules) await this.sync(schedule);
  }
}
