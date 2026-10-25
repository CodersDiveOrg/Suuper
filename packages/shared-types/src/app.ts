// Apps: small business apps (expenses, tickets, CRM, bookings) that one engine
// runs from a definition — record types, views, a dashboard, public forms and
// automations. The team works in the dashboard; customers only see public forms
// at /a/<slug>. AI helps (ask your data, suggestions, drafts) but isn't the app.

// --- Definition -----------------------------------------------------------------

export type AppFieldType =
  | "text"
  | "textarea"
  | "number"
  | "currency"
  | "date"
  | "datetime"
  | "select"
  | "email"
  | "phone"
  | "url"
  | "checkbox"
  /** A business member (stores the user id). */
  | "user"
  /** Another record of this app (stores its id), e.g. an appointment's service. */
  | "relation";

/** A select option; colours show on badges, board columns and charts. */
export interface AppFieldOption {
  value: string;
  color?: string;
}

export interface AppField {
  key: string;
  label: string;
  type: AppFieldType;
  required?: boolean;
  placeholder?: string;
  options?: AppFieldOption[];
  /** For "relation": the entity it points to. */
  relation?: string;
  /** Shown as a table column. */
  showInTable?: boolean;
  /** Set by the app, not typed in (e.g. when a ticket was resolved). */
  readOnly?: boolean;
  /** For "select": the AI can pick the value from the rest of the record. */
  aiSuggest?: boolean;
  /** Filled on create from the related record when left blank, e.g. an appointment's price from its service. */
  copyFrom?: { relationField: string; field: string };
}

/**
 * Comparison on a field. Special values: "$me" (the current user), "$now", "$today",
 * "$endOfToday", "$monthStart", and "$<field>" for another field of the same record.
 */
export interface AppFilter {
  field: string;
  op: "eq" | "neq" | "in" | "nin" | "empty" | "notEmpty" | "gt" | "lt" | "before" | "after" | "sameDay";
  value?: string | number | string[];
}

/** An AI action on a record, e.g. "Draft a reply" on a ticket, using the app's knowledge. */
export interface AppAiAction {
  key: string;
  label: string;
  /** What to write; the record and relevant knowledge are added automatically. */
  prompt: string;
}

export interface AppEntity {
  key: string;
  name: string;
  pluralName: string;
  icon: string;
  /** The field used as a record's title. */
  titleField: string;
  /** Records are numbered per entity: prefix + number, e.g. "T-1024". */
  numberPrefix: string;
  fields: AppField[];
  /** The select field that drives boards and progress. */
  statusField?: string;
  /** Status values that mean "finished" (Resolved, Won, Completed…). */
  doneStatuses?: string[];
  /** Set to now when the status moves into a done status (for resolution times). */
  completedAtField?: string;
  /** Due dates from a choice, e.g. tickets due in 4 h when Urgent. */
  sla?: { field: string; hours: Record<string, number>; dueField: string };
  aiActions?: AppAiAction[];
}

export type AppViewType = "table" | "board" | "calendar";

export interface AppView {
  key: string;
  name: string;
  icon?: string;
  entity: string;
  type: AppViewType;
  /** Board columns. */
  groupBy?: string;
  /** Calendar placement. */
  dateField?: string;
  filters?: AppFilter[];
  sort?: { field: string; dir: "asc" | "desc" };
}

export type AppPeriod = "today" | "this_week" | "this_month" | "last_30_days" | "next_7_days" | "all";

export type AppWidgetType =
  /** One number. */
  | "metric"
  /** Horizontal bars by a field. */
  | "bar"
  /** Share by a field. */
  | "donut"
  /** Over time. */
  | "trend"
  /** The latest matching records. */
  | "list"
  /** Spend against limits from another entity (budgets). */
  | "progress";

export interface AppWidget {
  key: string;
  title: string;
  type: AppWidgetType;
  entity: string;
  /** count, sum/avg of a field, "duration" (avg hours from creation to completedAtField) or "ratio" (share of records matching `ratioFilters`). */
  aggregate: "count" | "sum" | "avg" | "duration" | "ratio";
  field?: string;
  groupBy?: string;
  filters?: AppFilter[];
  ratioFilters?: AppFilter[];
  /** The date the period applies to; createdAt by default. */
  dateField?: string;
  period?: AppPeriod;
  /** For "trend": days back (daily) or months back (monthly). */
  trend?: { unit: "day" | "month"; count: number };
  /** For "progress": limits per group from another entity. */
  target?: { entity: string; keyField: string; valueField: string };
  format?: "number" | "currency" | "percent" | "hours";
  /** Grid columns out of 4. */
  span?: 1 | 2 | 4;
  /** Positive vs negative tint for metrics. */
  tone?: "default" | "good" | "warn" | "bad";
}

/** A public page (at /a/<slug>) that creates a record, e.g. "Raise a ticket". */
export interface AppPublicForm {
  key: string;
  entity: string;
  title: string;
  description?: string;
  buttonLabel: string;
  successMessage: string;
  /** Field keys shown, in order. */
  fields: string[];
  /** Values set on every record from this form, e.g. { channel: "Web" }. */
  defaults?: Record<string, string>;
  enabled: boolean;
}

/** "When a record is created / a field changes → run a workflow" (Slack, email, WhatsApp…). */
export interface AppAutomation {
  key: string;
  name: string;
  description?: string;
  trigger: { type: "created" | "changed"; entity: string; field?: string; to?: string };
  conditions?: AppFilter[];
  workflowId?: string;
  enabled: boolean;
}

export interface AppDefinition {
  currency: string;
  entities: AppEntity[];
  views: AppView[];
  dashboard: AppWidget[];
  publicForms: AppPublicForm[];
  automations: AppAutomation[];
}

export interface AppSettings {
  /** Knowledge the AI helpers draw on (drafts, answers). */
  knowledgeBaseIds: string[];
  showPoweredBy: boolean;
}

// --- Installed apps ---------------------------------------------------------------

export type AppStatus = "live" | "paused";

export interface App {
  id: string;
  businessId: string;
  slug: string;
  templateKey?: string;
  name: string;
  tagline: string;
  icon: string;
  color: string;
  status: AppStatus;
  definition: AppDefinition;
  settings: AppSettings;
  /** Records per entity key. */
  recordCounts: Record<string, number>;
  /** Example records added at install (removable in settings). */
  sampleCount: number;
  /** The public forms page, e.g. https://app.suuper.cc/a/sunrise-dental. */
  publicUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppUpdateInput {
  name?: string;
  tagline?: string;
  icon?: string;
  color?: string;
  status?: AppStatus;
  settings?: Partial<AppSettings>;
  /** Editable parts of the definition: select options, public forms, automations. */
  fieldOptions?: { entity: string; field: string; options: AppFieldOption[] };
  publicForms?: { key: string; enabled: boolean }[];
  automations?: { key: string; enabled: boolean; workflowId?: string | null }[];
}

export interface AppRecord {
  id: string;
  appId: string;
  entity: string;
  number: number;
  /** e.g. "T-1024". */
  reference: string;
  data: Record<string, unknown>;
  source: "app" | "public" | "sample";
  createdById?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppRecordActivity {
  id: string;
  type: "created" | "updated" | "comment";
  actorName: string;
  /** "updated": { changes: [{ field, from, to }] }; "comment": { text }. */
  detail: { changes?: { field: string; from: unknown; to: unknown }[]; text?: string };
  createdAt: string;
}

export interface AppMember {
  id: string;
  name: string;
  email: string;
}

/** A computed dashboard widget. */
export interface AppWidgetResult {
  key: string;
  value?: number;
  /** For bar / donut / progress: one row per group (progress adds its limit). */
  groups?: { label: string; value: number; color?: string; target?: number }[];
  /** For trend. */
  points?: { label: string; value: number }[];
  /** For list. */
  records?: AppRecord[];
}

// --- Catalog --------------------------------------------------------------------

export type AppCategory = "finance" | "support" | "sales" | "operations";

export interface AppSetupQuestion {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  type: "text" | "textarea" | "list";
  required?: boolean;
  /** Prefilled answer. */
  default?: string;
}

/** A catalog entry as the dashboard sees it. */
export interface AppTemplateSummary {
  key: string;
  name: string;
  category: AppCategory;
  icon: string;
  color: string;
  tagline: string;
  /** The pain point it solves. */
  problem: string;
  outcomes: string[];
  /** Who it's for, e.g. "Call centers, ISPs, support teams". */
  bestFor: string;
  setupQuestions: AppSetupQuestion[];
  /** The definition with default answers, for the store's preview. */
  definition: AppDefinition;
}

export interface AppInstallRequest {
  templateKey: string;
  answers: Record<string, string>;
  look?: { name?: string; tagline?: string; icon?: string; color?: string };
  /** Fill the app with realistic example records (handy for demos; removable later). */
  sampleData?: boolean;
}

/** AI App Builder: which app fits a description, with setup answers drawn from it. */
export interface AppSuggestion {
  templateKey: string;
  name: string;
  answers: Record<string, string>;
  generatedBy: "claude" | "local" | "fallback";
}

// --- Public forms (no login) -------------------------------------------------------

export interface PublicAppForm {
  key: string;
  title: string;
  description?: string;
  buttonLabel: string;
  /** Resolved fields; relation fields list their choices. */
  fields: (Omit<AppField, "relation" | "copyFrom" | "aiSuggest" | "showInTable" | "readOnly"> & { choices?: { id: string; label: string }[] })[];
}

export interface PublicApp {
  slug: string;
  name: string;
  tagline: string;
  icon: string;
  color: string;
  forms: PublicAppForm[];
  showPoweredBy: boolean;
}
