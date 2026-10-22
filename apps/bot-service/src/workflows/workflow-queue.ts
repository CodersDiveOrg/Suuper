import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "@platform/database";
import { loadServiceConfig } from "@platform/shared-config";
import { RUN_WORKFLOW_QUEUE, type RunWorkflowJob, type WorkflowTrigger } from "@platform/shared-types";
import { executeRun } from "./engine/run-workflow";
import { toCron } from "./engine/schedule";

const config = loadServiceConfig("bot-service", 3002);
// Runs share bot-service's process (and the server's single core) with chat.
const CONCURRENCY = 2;
const schedulerId = (workflowId: string) => `workflow:${workflowId}`;

/** The run queue plus its in-process worker, and the BullMQ schedulers behind schedule triggers. */
@Injectable()
export class WorkflowQueue implements OnModuleInit, OnModuleDestroy {
  private readonly connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  private readonly queue = new Queue<RunWorkflowJob>(RUN_WORKFLOW_QUEUE, {
    connection: this.connection,
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000 },
  });
  private worker?: Worker<RunWorkflowJob>;

  async onModuleInit() {
    // Runs cut off by a restart would otherwise show "running" forever.
    await prisma.workflowRun.updateMany({
      where: { status: "running" },
      data: { status: "failed", error: "Interrupted by a server restart", finishedAt: new Date() },
    });
    this.worker = new Worker<RunWorkflowJob>(RUN_WORKFLOW_QUEUE, (job) => this.process(job.data), {
      connection: this.connection,
      concurrency: CONCURRENCY,
    });
    this.worker.on("failed", (job, error) => console.error(`[bot-service] workflow job ${job?.id} failed:`, error));
    await this.reconcileSchedules();
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
  }

  async enqueueRun(runId: string) {
    await this.queue.add("run", { runId });
  }

  /** Adds, updates or removes a workflow's schedule to match its current trigger and on/off state. */
  async syncSchedule(workflow: { id: string; enabled: boolean; trigger: unknown }) {
    const trigger = workflow.trigger as WorkflowTrigger;
    if (workflow.enabled && trigger.type === "schedule") {
      await this.queue.upsertJobScheduler(
        schedulerId(workflow.id),
        { pattern: toCron(trigger), tz: trigger.timezone },
        { name: "scheduled", data: { workflowId: workflow.id } },
      );
    } else {
      await this.queue.removeJobScheduler(schedulerId(workflow.id));
    }
  }

  async removeSchedule(workflowId: string) {
    await this.queue.removeJobScheduler(schedulerId(workflowId));
  }

  private async process(job: RunWorkflowJob) {
    if ("runId" in job) return executeRun(job.runId);

    // Scheduled: re-check the workflow, since it may have been turned off since the job was queued.
    const workflow = await prisma.workflow.findUnique({ where: { id: job.workflowId } });
    if (!workflow?.enabled || (workflow.trigger as WorkflowTrigger).type !== "schedule") return;
    const run = await prisma.workflowRun.create({
      data: {
        businessId: workflow.businessId,
        workflowId: workflow.id,
        trigger: "schedule",
        triggerData: { firedAt: new Date().toISOString() },
      },
    });
    await executeRun(run.id);
  }

  /** Schedulers live in Redis; bring them back in line with the database on startup. */
  private async reconcileSchedules() {
    const scheduled = await prisma.workflow.findMany({
      where: { enabled: true, trigger: { path: ["type"], equals: "schedule" } },
      select: { id: true, enabled: true, trigger: true },
    });
    const wanted = new Set(scheduled.map((w) => schedulerId(w.id)));
    for (const existing of await this.queue.getJobSchedulers()) {
      const id = existing.id ?? existing.key;
      if (id && !wanted.has(id)) await this.queue.removeJobScheduler(id);
    }
    for (const workflow of scheduled) await this.syncSchedule(workflow);
  }
}
