import type { AppDefinition, AppTemplateSummary } from "@platform/shared-types";

/** Setup answers keyed by AppSetupQuestion.key; blank optional answers are "". */
export type Answers = Record<string, string>;

/** Example records for demos. `ref` names a record so others can point at it through `links`. */
export interface SampleRecord {
  entity: string;
  ref?: string;
  data: Record<string, unknown>;
  /** Field -> ref of the related sample record. */
  links?: Record<string, string>;
  /** Fields set to the installing user (assignee, owner). */
  me?: string[];
  /** How long ago it was created. */
  hoursAgo: number;
}

export interface AppTemplate extends Omit<AppTemplateSummary, "definition"> {
  /** Words that point to this app, for the AI builder's fallback matching. */
  keywords: string[];
  build(answers: Answers): AppDefinition;
  /** Real records the answers describe (e.g. services), created with the app. */
  starterRecords?(answers: Answers): SampleRecord[];
  /** Realistic example records for demos; `now` anchors relative dates. May link to starter records' refs. */
  samples(definition: AppDefinition, now: Date, answers: Answers): SampleRecord[];
}
