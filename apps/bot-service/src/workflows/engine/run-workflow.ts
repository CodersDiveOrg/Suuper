import { prisma } from "@platform/database";
import type { WorkflowStep, WorkflowStepResult } from "@platform/shared-types";
import { runStep, StepError, type StepContext } from "./steps";

// Stored step outputs are shown in the run history and fed to later steps; keep them bounded.
const MAX_STORED_OUTPUT_CHARS = 20_000;

export const STEP_LABELS: Record<WorkflowStep["type"], string> = {
  ai: "Ask AI",
  action: "App action",
  http: "HTTP request",
  condition: "Only continue if",
};

/** Executes a queued run step by step, saving each result as it finishes. */
export async function executeRun(runId: string): Promise<void> {
  const run = await prisma.workflowRun.findUnique({ where: { id: runId }, include: { workflow: true } });
  if (!run || run.status !== "queued") return;

  await prisma.workflowRun.update({ where: { id: runId }, data: { status: "running", startedAt: new Date() } });
  const steps = (run.workflow.steps ?? []) as unknown as WorkflowStep[];
  const ctx: StepContext = { businessId: run.businessId, trigger: run.triggerData ?? {}, steps: {}, sends: 0 };
  const results: WorkflowStepResult[] = [];
  let status: "succeeded" | "failed" | "stopped" = "succeeded";
  let error: string | undefined;

  for (const step of steps) {
    const name = step.name?.trim() || STEP_LABELS[step.type];
    if (status !== "succeeded") {
      results.push({ stepId: step.id, type: step.type, name, status: "skipped", durationMs: 0 });
      continue;
    }
    const started = Date.now();
    try {
      const outcome = await runStep(step, ctx);
      const output = bounded(outcome.output);
      ctx.steps[step.id] = output;
      results.push({ stepId: step.id, type: step.type, name, status: "succeeded", input: bounded(outcome.input), output, durationMs: Date.now() - started });
      if (outcome.stop) status = "stopped";
    } catch (err) {
      const e = err as Error & { input?: unknown; output?: unknown };
      error = `${name}: ${e instanceof StepError ? e.message : `Unexpected error: ${e.message}`}`;
      results.push({
        stepId: step.id,
        type: step.type,
        name,
        status: "failed",
        input: bounded(e.input),
        output: bounded(e.output),
        error: e.message,
        durationMs: Date.now() - started,
      });
      status = "failed";
    }
    await prisma.workflowRun.update({ where: { id: runId }, data: { steps: results as object[] } });
  }

  await prisma.workflowRun.update({
    where: { id: runId },
    data: { status, error: error ?? null, steps: results as object[], finishedAt: new Date() },
  });
}

function bounded(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= MAX_STORED_OUTPUT_CHARS) return value;
  return { truncated: true, preview: text.slice(0, MAX_STORED_OUTPUT_CHARS) };
}
