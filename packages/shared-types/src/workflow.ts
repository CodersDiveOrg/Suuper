// Workflows: one trigger and an ordered list of steps, run by bot-service.
// Step fields can reference earlier data with {{trigger.some.path}} and
// {{steps.<stepId>.some.path}} placeholders.

export type WorkflowTrigger =
  | { type: "manual" }
  | { type: "webhook" }
  | {
      type: "schedule";
      frequency: "minutes" | "hourly" | "daily" | "weekly";
      /** frequency "minutes": run every N minutes (5, 10, 15 or 30). */
      intervalMinutes?: number;
      /** "HH:MM", 24-hour. Daily and weekly; hourly uses only the minutes. */
      time?: string;
      /** 0 = Sunday … 6 = Saturday. Weekly only. */
      dayOfWeek?: number;
      /** IANA name, e.g. "Asia/Karachi". */
      timezone: string;
    };

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "is_not_empty"
  | "greater_than"
  | "less_than";

export type WorkflowStep =
  | { id: string; type: "ai"; name?: string; prompt: string; model?: string; knowledgeBaseIds?: string[] }
  | { id: string; type: "action"; name?: string; provider: string; action: string; inputs: Record<string, string> }
  | { id: string; type: "http"; name?: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers?: string; body?: string }
  | { id: string; type: "condition"; name?: string; left: string; operator: ConditionOperator; right?: string };

export type WorkflowStepType = WorkflowStep["type"];

export interface Workflow {
  id: string;
  businessId: string;
  name: string;
  description?: string;
  /** Schedule and webhook triggers only fire while enabled; "Run now" always works. */
  enabled: boolean;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  /** Public URL that starts the workflow (webhook trigger). */
  webhookUrl: string;
  lastRun?: { id: string; status: WorkflowRunStatus; startedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  trigger?: WorkflowTrigger;
  steps?: WorkflowStep[];
}

export type WorkflowRunStatus = "queued" | "running" | "succeeded" | "failed" | "stopped";

export interface WorkflowStepResult {
  stepId: string;
  type: WorkflowStepType;
  name: string;
  status: "succeeded" | "failed" | "skipped";
  /** The step's fields after placeholders were filled in. */
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  /** "app": started by an app automation (a record created or changed). */
  trigger: "manual" | "webhook" | "schedule" | "app";
  status: WorkflowRunStatus;
  triggerData?: unknown;
  steps: WorkflowStepResult[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/** Contract between bot-service's API (producer) and its workflow runner (consumer). */
export const RUN_WORKFLOW_QUEUE = "run-workflow";

export type RunWorkflowJob =
  /** A run already created (manual or webhook). */
  | { runId: string }
  /** Fired by a schedule; the runner creates the run. */
  | { workflowId: string };
