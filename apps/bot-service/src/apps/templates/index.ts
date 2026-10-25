import type { AppTemplateSummary } from "@platform/shared-types";
import { appointments } from "./appointments";
import { crm } from "./crm";
import { expenses } from "./expenses";
import { defaultAnswers } from "./helpers";
import { tickets } from "./tickets";
import type { AppTemplate } from "./types";

export type { AppTemplate, Answers, SampleRecord } from "./types";

/** The pre-built apps, in the order the store shows them. */
export const APP_TEMPLATES: AppTemplate[] = [tickets, crm, appointments, expenses];

export function findTemplate(key: string): AppTemplate | undefined {
  return APP_TEMPLATES.find((t) => t.key === key);
}

/** The catalog entry: everything but the server-only parts, with the definition its default answers build. */
export function templateSummary(t: AppTemplate): AppTemplateSummary {
  const { build, samples: _samples, starterRecords: _starter, keywords: _keywords, ...summary } = t;
  return { ...summary, definition: build(defaultAnswers(t)) };
}
