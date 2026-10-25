import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import type { AppDefinition, AppEntity, AppSettings, AppWidget, AppWidgetResult } from "@platform/shared-types";
import { searchKnowledgeFor } from "../agents/runtime/knowledge";
import { complete } from "./ai";
import { AppsService } from "./apps.service";
import { cleanRecordData } from "./engine/records";
import { definitionOf, entityOf, RecordsService, serializeRecord, type AppRow } from "./records.service";

const RECENT_PER_ENTITY = 8;
const MAX_MATCHES = 8;
const STOP_WORDS = new Set(["the", "and", "for", "what", "how", "much", "many", "did", "was", "were", "are", "our", "any", "all", "show", "this", "that", "with", "from", "about", "have", "has", "who", "when", "which", "there", "last", "month", "week", "today", "me", "my"]);

const RULES = `Rules:
- Use only the facts given. Totals, counts and rates are already calculated: quote them exactly and never do arithmetic yourself.
- If the facts don't answer the question, say so plainly.
- Be brief: a sentence or two, or a short list. Mention record references (like T-1024) when you refer to records.
- Reply in the language the user writes in.`;

/** The AI helpers inside an app. They read the app's numbers and records and the knowledge the app is linked to. */
@Injectable()
export class AssistantService {
  constructor(
    private readonly apps: AppsService,
    private readonly records: RecordsService,
  ) {}

  /** "How much did we spend on fuel this month?" — answered from the dashboard's numbers, matching records and linked knowledge. */
  async ask(app: AppRow, question: unknown, userId: string, tzOffsetMinutes: number) {
    if (typeof question !== "string" || !question.trim()) throw new BadRequestException("Ask a question first");
    const q = question.trim().slice(0, 1000);
    const definition = definitionOf(app);
    const widgets = await this.apps.computeDashboard(app, definition, { userId, now: new Date(), tzOffsetMinutes });
    const facts = widgets.map((result, i) => describeWidget(definition, definition.dashboard[i], result)).filter(Boolean);

    const sections = [`Key numbers (today is ${new Date(Date.now() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10)}):`, ...facts.map((f) => `- ${f}`)];
    for (const entity of definition.entities) {
      const lines = await this.recordLines(app, entity, q);
      if (lines.length > 0) sections.push("", `${entity.pluralName}:`, ...lines);
    }
    const knowledge = await this.knowledge(app, q);
    if (knowledge) sections.push("", "Business knowledge:", knowledge);

    const { text } = await complete(
      app.businessId,
      `You are the assistant inside the “${app.name}” app. You answer the team's questions about the app's data.\n\n${RULES}`,
      `${sections.join("\n")}\n\nQuestion: ${q}`,
    );
    return { answer: text || "Sorry, I couldn't work that out. Try asking another way." };
  }

  /** Picks a choice field's value from the rest of the record (an expense's category, a ticket's priority). */
  async suggest(app: AppRow, entityKey: unknown, fieldKey: unknown, data: unknown) {
    const entity = entityOf(app, String(entityKey));
    const field = entity.fields.find((f) => f.key === fieldKey);
    if (!field || field.type !== "select" || !field.aiSuggest) throw new BadRequestException("This field has no suggestions");
    const values = await cleanRecordData(entity, data, { memberIds: new Set(), relationExists: async () => true }, { partial: true }).catch(() => ({}));
    const described = Object.entries(values)
      .filter(([key, v]) => key !== field.key && typeof v === "string" && v)
      .map(([key, v]) => `${entity.fields.find((f) => f.key === key)?.label ?? key}: ${v}`)
      .join("\n");
    if (!described) throw new BadRequestException("Fill in a few details first");
    const options = field.options?.map((o) => o.value) ?? [];
    // Obvious cases need no model: an option's word stem in the text ("charged on my bill" -> Billing).
    const lowered = described.toLowerCase();
    const obvious = options.filter((o) =>
      o
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length >= 4)
        .some((w) => new RegExp(`\\b${w.slice(0, Math.max(4, w.length - 3))}`).test(lowered)),
    );
    if (obvious.length === 1) return { value: obvious[0] };
    const { text } = await complete(
      app.businessId,
      "You classify records. Reply with exactly one of the given options and nothing else.",
      `${entity.name}:\n${described}\n\nChoose the best ${field.label} from: ${options.join(", ")}`,
      20,
    );
    const reply = text.toLowerCase();
    // Exact first, then the longest option the reply mentions.
    const value = options.find((o) => o.toLowerCase() === reply.replace(/[."']/g, "").trim()) ?? [...options].sort((a, b) => b.length - a.length).find((o) => reply.includes(o.toLowerCase()));
    return { value: value ?? null };
  }

  /** Runs a record's AI action (e.g. "Draft a reply") with the record, its comments and linked knowledge. */
  async action(app: AppRow, recordId: string, actionKey: string) {
    const row = await this.records.require(app, recordId);
    const entity = entityOf(app, row.entity);
    const action = entity.aiActions?.find((a) => a.key === actionKey);
    if (!action) throw new NotFoundException("Action not found");
    const record = serializeRecord(app, row);
    const readable = await this.records.readable(app, entity, record.data);
    const details = entity.fields
      .filter((f) => readable[f.key] !== undefined)
      .map((f) => `${f.label}: ${formatValue(definitionOf(app), f.type, readable[f.key])}`)
      .join("\n");
    const comments = (await this.records.activity(app, recordId))
      .filter((a) => a.type === "comment")
      .slice(-5)
      .map((a) => `- ${a.actorName}: ${a.detail.text}`)
      .join("\n");
    const title = String(record.data[entity.titleField] ?? "");
    const description = String(record.data.description ?? record.data.notes ?? "");
    const knowledge = await this.knowledge(app, `${title} ${description}`.trim());

    const { text } = await complete(
      app.businessId,
      `You help the team of ${app.name} with their work. ${action.prompt}\nWrite only the text itself, ready to copy, with no preamble. Use the language of the record. Never invent prices, policies or dates.`,
      [`${entity.name} ${record.reference}:`, details, comments && `\nRecent comments:\n${comments}`, knowledge && `\nBusiness knowledge:\n${knowledge}`].filter(Boolean).join("\n"),
      500,
    );
    return { text: text || "Sorry, I couldn't write that. Try again." };
  }

  /** The latest records plus those matching the question's words, one line each. */
  private async recordLines(app: AppRow, entity: AppEntity, question: string): Promise<string[]> {
    const rows = await prisma.appRecord.findMany({ where: { appId: app.id, entity: entity.key }, orderBy: { createdAt: "desc" }, take: 1000 });
    if (rows.length === 0) return [];
    const words = question
      .toLowerCase()
      .split(/[^\p{L}\p{N}-]+/u)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    const members = await this.records.members(app.businessId);
    const scored = rows
      .map((row) => {
        const text = `${entity.numberPrefix}${row.number} ${Object.values(row.data as object).join(" ")}`.toLowerCase();
        return { row, score: words.filter((w) => text.includes(w)).length };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHES)
      .map((m) => m.row);
    const chosen = [...new Map([...scored, ...rows.slice(0, RECENT_PER_ENTITY)].map((r) => [r.id, r])).values()];
    const lines: string[] = [];
    for (const row of chosen) {
      const readable = await this.records.readable(app, entity, row.data as Record<string, unknown>, members);
      const parts = entity.fields.filter((f) => readable[f.key] !== undefined).map((f) => `${f.label}: ${formatValue(definitionOf(app), f.type, readable[f.key]).slice(0, 120)}`);
      lines.push(`- ${entity.numberPrefix}${row.number} (created ${row.createdAt.toISOString().slice(0, 10)}): ${parts.join("; ")}`);
    }
    return lines;
  }

  private async knowledge(app: AppRow, query: string): Promise<string> {
    const ids = (app.settings as unknown as AppSettings).knowledgeBaseIds ?? [];
    if (ids.length === 0 || !query) return "";
    const { passages } = await searchKnowledgeFor(app.businessId, ids, query);
    return passages
      .slice(0, 5)
      .map((p) => `[${p.title}] ${p.content}`)
      .join("\n\n");
  }
}

function formatValue(definition: AppDefinition, type: string, value: unknown): string {
  if (type === "currency" && typeof value === "number") return `${value.toLocaleString("en-US")} ${definition.currency}`;
  if (type === "datetime" && typeof value === "string") return value.slice(0, 16).replace("T", " ") + " UTC";
  if (type === "checkbox") return value ? "yes" : "no";
  return String(value);
}

function formatNumber(definition: AppDefinition, widget: AppWidget, value: number): string {
  switch (widget.format) {
    case "currency":
      return `${Math.round(value).toLocaleString("en-US")} ${definition.currency}`;
    case "percent":
      return `${Math.round(value)}%`;
    case "hours":
      return `${value.toFixed(1)} hours`;
    default:
      return Math.round(value * 100) / 100 + "";
  }
}

/** One dashboard widget as a sentence of facts. */
function describeWidget(definition: AppDefinition, widget: AppWidget, result: AppWidgetResult): string {
  if (result.value !== undefined && widget.type === "metric") return `${widget.title}: ${formatNumber(definition, widget, result.value)}`;
  if (result.groups?.length) {
    const groups = result.groups
      .filter((g) => g.value > 0 || g.target)
      .map((g) => `${g.label} ${formatNumber(definition, widget, g.value)}${g.target ? ` of ${formatNumber(definition, widget, g.target)} budget` : ""}`);
    return groups.length ? `${widget.title}: ${groups.join(", ")}` : `${widget.title}: none`;
  }
  if (result.points?.length) return `${widget.title}: ${result.points.map((p) => `${p.label} ${formatNumber(definition, widget, p.value)}`).join(", ")}`;
  return "";
}
