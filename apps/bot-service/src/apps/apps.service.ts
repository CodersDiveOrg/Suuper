import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { loadServiceConfig } from "@platform/shared-config";
import type { App, AppDefinition, AppInstallRequest, AppSettings, AppUpdateInput, AppWidgetResult, PublicApp } from "@platform/shared-types";
import { computeWidget } from "./engine/dashboard";
import type { EvalContext, RecordLike } from "./engine/filters";
import { suggestApp } from "./generate";
import { definitionOf, entityOf, RecordsService, serializeRecord, type Actor, type AppRow } from "./records.service";
import { APP_TEMPLATES, findTemplate, templateSummary, type SampleRecord } from "./templates";
import { defaultAnswers } from "./templates/helpers";

const config = loadServiceConfig("bot-service", 3002);

const RESERVED_SLUGS = new Set(["new", "admin", "api", "app", "apps", "www", "dashboard", "login"]);
// The dashboard reads at most this many records per entity.
const DASHBOARD_RECORDS = 5000;
const MAX_OPTIONS = 40;

@Injectable()
export class AppsService {
  constructor(private readonly records: RecordsService) {}

  catalog() {
    return APP_TEMPLATES.map(templateSummary);
  }

  /**
   * The store's live preview: the template's dashboard computed on its sample data in memory,
   * plus a few records per entity. Nothing touches the database.
   */
  preview(key: string, tzOffsetMinutes: number) {
    const template = findTemplate(key);
    if (!template) throw new NotFoundException("App not found");
    const answers = defaultAnswers(template);
    const definition = template.build(answers);
    const now = new Date();
    const items = [...(template.starterRecords?.(answers) ?? []), ...template.samples(definition, now, answers)];
    const counters: Record<string, number> = {};
    const records = items.map((item, i) => {
      const id = item.ref ?? `sample-${i}`;
      const data: Record<string, unknown> = { ...item.data };
      for (const [fieldKey, ref] of Object.entries(item.links ?? {})) data[fieldKey] = ref;
      for (const fieldKey of item.me ?? []) data[fieldKey] = "you";
      const entity = definition.entities.find((e) => e.key === item.entity)!;
      for (const f of entity.fields) {
        const linked = f.copyFrom && items.find((s) => s.ref === data[f.copyFrom!.relationField]);
        if (linked && data[f.key] === undefined) data[f.key] = linked.data[f.copyFrom!.field];
      }
      const createdAt = new Date(now.getTime() - item.hoursAgo * 3_600_000);
      return { id, entity: item.entity, data, createdAt, updatedAt: createdAt };
    });
    // Numbered oldest first, like a real install.
    const numbered = [...records].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((r) => ({ ...r, number: (counters[r.entity] = (counters[r.entity] ?? 1000) + 1) }));
    const byEntity: Record<string, RecordLike[]> = {};
    for (const r of numbered) (byEntity[r.entity] ??= []).push(r);
    const toRecord = (r: (typeof numbered)[number]) => ({
      id: r.id,
      appId: "preview",
      entity: r.entity,
      number: r.number,
      reference: `${definition.entities.find((e) => e.key === r.entity)!.numberPrefix}${r.number}`,
      data: r.data,
      source: "sample" as const,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    });
    const byId = new Map(numbered.map((r) => [r.id, r]));
    const ctx: EvalContext = { userId: "you", now, tzOffsetMinutes };
    const widgets = definition.dashboard.map((widget) => {
      const { records: rows, ...result } = computeWidget(widget, { definition, records: byEntity, members: new Map([["you", "You"]]), ctx });
      return { ...result, ...(rows ? { records: rows.map((r) => toRecord(byId.get(r.id)!)) } : {}) };
    });
    return {
      definition,
      widgets,
      // Newest first, so the preview shows realistic recent activity.
      records: [...numbered].reverse().map(toRecord),
      members: [{ id: "you", name: "You", email: "" }],
    };
  }

  /** AI App Builder: which app fits a description, with setup answers (nothing is created). */
  async suggest(businessId: string, description: unknown) {
    if (typeof description !== "string" || description.trim().length < 10) {
      throw new BadRequestException("Describe your business and what you need in a sentence or two");
    }
    return suggestApp(businessId, description);
  }

  /** Creates the app from a template and the answers, with its starter records and optional sample data. */
  async install(businessId: string, userId: string, request: AppInstallRequest): Promise<App> {
    const template = findTemplate(request?.templateKey);
    if (!template) throw new BadRequestException("Choose an app to install");
    const answers: Record<string, string> = {};
    for (const question of template.setupQuestions) {
      const value = typeof request.answers?.[question.key] === "string" ? request.answers[question.key].trim().slice(0, 5000) : "";
      if (question.required && !value) throw new BadRequestException(`Please fill in “${question.label}”`);
      answers[question.key] = value;
    }
    const definition = template.build(answers);
    const look = request.look ?? {};
    const name = this.text(look.name?.trim() || template.name, "name", 60);

    const app = await prisma.app.create({
      data: {
        businessId,
        slug: await this.uniqueSlug(name),
        templateKey: template.key,
        name,
        tagline: this.text(look.tagline?.trim() || template.tagline, "tagline", 120),
        icon: this.text(look.icon?.trim() || template.icon, "icon", 8),
        color: this.color(look.color || template.color),
        definition: definition as object,
        settings: { knowledgeBaseIds: [], showPoweredBy: true } satisfies AppSettings,
      },
    });
    const now = new Date();
    const seed = [...(template.starterRecords?.(answers) ?? []), ...(request.sampleData ? template.samples(definition, now, answers) : [])];
    await this.seed(app, seed, userId, now);
    return this.get(businessId, app.id);
  }

  /** Inserts starter and sample records oldest first, linking refs (an appointment's service) to the created ids. */
  private async seed(app: AppRow, items: SampleRecord[], userId: string, now: Date) {
    const ids = new Map<string, string>();
    // Starter records (hoursAgo 0) first so samples can link to them, then samples oldest first.
    const starter = (s: SampleRecord) => s.hoursAgo === 0;
    const ordered = [...items].sort((a, b) => (starter(a) === starter(b) ? b.hoursAgo - a.hoursAgo : starter(a) ? -1 : 1));
    for (const item of ordered) {
      const data: Record<string, unknown> = { ...item.data };
      for (const [fieldKey, ref] of Object.entries(item.links ?? {})) if (ids.has(ref)) data[fieldKey] = ids.get(ref);
      for (const fieldKey of item.me ?? []) data[fieldKey] = userId;
      // Linked values the app would copy on create (an appointment's price from its service).
      const entity = entityOf(app, item.entity);
      for (const f of entity.fields) {
        if (!f.copyFrom || data[f.key] !== undefined) continue;
        const linked = items.find((s) => s.ref && ids.get(s.ref) === data[f.copyFrom!.relationField]);
        if (linked?.data[f.copyFrom.field] !== undefined) data[f.key] = linked.data[f.copyFrom.field];
      }
      const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== ""));
      const row = await this.records.insert(app, item.entity, clean, {
        source: item.hoursAgo === 0 ? "app" : "sample",
        createdById: userId,
        createdAt: new Date(now.getTime() - item.hoursAgo * 3_600_000),
      });
      await prisma.appRecordActivity.create({ data: { recordId: row.id, type: "created", actorId: userId, actorName: row.source === "sample" ? "Sample data" : "Setup", detail: {}, createdAt: row.createdAt } });
      if (item.ref) ids.set(item.ref, row.id);
    }
  }

  async list(businessId: string): Promise<App[]> {
    const apps = await prisma.app.findMany({ where: { businessId }, orderBy: { createdAt: "desc" } });
    const counts = await prisma.appRecord.groupBy({ by: ["appId", "entity", "source"], where: { appId: { in: apps.map((a) => a.id) } }, _count: true });
    return apps.map((app) => this.serialize(app, counts.filter((c) => c.appId === app.id)));
  }

  async get(businessId: string, id: string): Promise<App> {
    const app = await this.require(businessId, id);
    const counts = await prisma.appRecord.groupBy({ by: ["appId", "entity", "source"], where: { appId: id }, _count: true });
    return this.serialize(app, counts);
  }

  /** Look, status, settings, and the editable parts of the definition (select options, public forms, automations). */
  async update(businessId: string, id: string, input: AppUpdateInput): Promise<App> {
    const app = await this.require(businessId, id);
    const definition = structuredClone(definitionOf(app));
    const settings = app.settings as unknown as AppSettings;

    if (input.fieldOptions) {
      const { entity, field, options } = input.fieldOptions;
      const target = entityOf(app, entity).fields.find((f) => f.key === field);
      if (!target || target.type !== "select") throw new BadRequestException("Only choice fields have options");
      if (!Array.isArray(options) || options.length === 0 || options.length > MAX_OPTIONS) throw new BadRequestException(`Give 1 to ${MAX_OPTIONS} options`);
      const clean = options.map((o) => ({ value: this.text(o?.value, "option", 60), ...(typeof o?.color === "string" && /^#[0-9a-f]{6}$/i.test(o.color) ? { color: o.color } : {}) }));
      if (new Set(clean.map((o) => o.value.toLowerCase())).size !== clean.length) throw new BadRequestException("Options must be different from each other");
      // Status and SLA values drive boards, due times, dashboards and automations, so they stay fixed.
      if (entityOf(app, entity).statusField === field || entityOf(app, entity).sla?.field === field) throw new BadRequestException("These options can't be changed");
      // Fields sharing the key (an expense's and a budget's category) stay in sync.
      for (const e of definition.entities) for (const f of e.fields) if (f.key === field && f.type === "select") f.options = clean;
    }
    for (const change of input.publicForms ?? []) {
      const form = definition.publicForms.find((f) => f.key === change.key);
      if (!form) throw new BadRequestException("Public form not found");
      form.enabled = change.enabled === true;
    }
    for (const change of input.automations ?? []) {
      const automation = definition.automations.find((a) => a.key === change.key);
      if (!automation) throw new BadRequestException("Automation not found");
      if (change.workflowId !== undefined) {
        if (change.workflowId) {
          const workflow = await prisma.workflow.findUnique({ where: { id: String(change.workflowId) } });
          if (!workflow || workflow.businessId !== businessId) throw new BadRequestException("Workflow not found");
          automation.workflowId = workflow.id;
        } else delete automation.workflowId;
      }
      automation.enabled = change.enabled === true && Boolean(automation.workflowId);
    }
    let nextSettings = settings;
    if (input.settings) {
      const kbIds = input.settings.knowledgeBaseIds;
      if (kbIds !== undefined) {
        if (!Array.isArray(kbIds)) throw new BadRequestException("knowledgeBaseIds must be a list");
        const found = await prisma.knowledgeBase.count({ where: { id: { in: kbIds.map(String) }, businessId } });
        if (found !== new Set(kbIds).size) throw new BadRequestException("Knowledge base not found");
      }
      nextSettings = {
        knowledgeBaseIds: kbIds !== undefined ? [...new Set(kbIds.map(String))] : settings.knowledgeBaseIds,
        showPoweredBy: input.settings.showPoweredBy !== undefined ? input.settings.showPoweredBy !== false : settings.showPoweredBy,
      };
    }

    const updated = await prisma.app.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: this.text(input.name, "name", 60) } : {}),
        ...(input.tagline !== undefined ? { tagline: this.text(input.tagline, "tagline", 120) } : {}),
        ...(input.icon !== undefined ? { icon: this.text(input.icon, "icon", 8) } : {}),
        ...(input.color !== undefined ? { color: this.color(input.color) } : {}),
        ...(input.status !== undefined ? { status: input.status === "paused" ? "paused" : "live" } : {}),
        definition: definition as object,
        settings: nextSettings as object,
      },
    });
    return this.get(businessId, updated.id);
  }

  /** Deletes the app and all its records. */
  async remove(businessId: string, id: string) {
    await this.require(businessId, id);
    await prisma.app.delete({ where: { id } });
  }

  /** Removes the example records added at install, keeping everything the team created. */
  async clearSamples(businessId: string, id: string) {
    await this.require(businessId, id);
    const { count } = await prisma.appRecord.deleteMany({ where: { appId: id, source: "sample" } });
    return { removed: count };
  }

  /** Every dashboard widget, computed in the viewer's timezone. */
  async dashboard(businessId: string, id: string, userId: string, tzOffsetMinutes: number): Promise<AppWidgetResult[]> {
    const app = await this.require(businessId, id);
    const definition = definitionOf(app);
    const ctx: EvalContext = { userId, now: new Date(), tzOffsetMinutes };
    return this.computeDashboard(app, definition, ctx);
  }

  async computeDashboard(app: AppRow, definition: AppDefinition, ctx: EvalContext): Promise<AppWidgetResult[]> {
    const rows = await prisma.appRecord.findMany({ where: { appId: app.id }, orderBy: { createdAt: "desc" }, take: DASHBOARD_RECORDS * definition.entities.length });
    const byEntity: Record<string, RecordLike[]> = {};
    const rowById = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) (byEntity[r.entity] ??= []).push({ id: r.id, data: r.data as Record<string, unknown>, createdAt: r.createdAt, updatedAt: r.updatedAt });
    const members = new Map((await this.records.members(app.businessId)).map((m) => [m.id, m.name]));
    return definition.dashboard.map((widget) => {
      const { records, ...result } = computeWidget(widget, { definition, records: byEntity, members, ctx });
      return { ...result, ...(records ? { records: records.map((r) => serializeRecord(app, rowById.get(r.id)!)) } : {}) };
    });
  }

  // --- Public forms (no login) ---------------------------------------------------

  async publicProfile(slug: string): Promise<PublicApp> {
    const app = await this.requireLive(slug);
    const definition = definitionOf(app);
    const forms = [];
    for (const form of definition.publicForms.filter((f) => f.enabled)) {
      const entity = entityOf(app, form.entity);
      const fields = [];
      for (const key of form.fields) {
        const f = entity.fields.find((x) => x.key === key);
        if (!f) continue;
        const { relation, copyFrom: _copy, aiSuggest: _ai, showInTable: _table, readOnly: _ro, ...publicField } = f;
        if (f.type === "relation" && relation) {
          // Only bookable choices (services with "Bookable online" off are hidden).
          const relEntity = entityOf(app, relation);
          const rows = await prisma.appRecord.findMany({ where: { appId: app.id, entity: relation }, orderBy: { number: "asc" }, take: 200 });
          const choices = rows
            .filter((r) => (r.data as Record<string, unknown>).active !== false)
            .map((r) => {
              const data = r.data as Record<string, unknown>;
              const price = typeof data.price === "number" ? ` — ${data.price.toLocaleString("en-US")} ${definition.currency}` : "";
              return { id: r.id, label: `${data[relEntity.titleField] ?? "Untitled"}${price}` };
            });
          fields.push({ ...publicField, choices });
        } else fields.push(publicField);
      }
      forms.push({ key: form.key, title: form.title, description: form.description, buttonLabel: form.buttonLabel, fields });
    }
    return {
      slug: app.slug,
      name: app.name,
      tagline: app.tagline,
      icon: app.icon,
      color: app.color,
      forms,
      showPoweredBy: (app.settings as unknown as AppSettings).showPoweredBy !== false,
    };
  }

  async publicSubmit(slug: string, formKey: string, data: unknown) {
    const app = await this.requireLive(slug);
    const form = definitionOf(app).publicForms.find((f) => f.key === formKey && f.enabled);
    if (!form) throw new NotFoundException("This form isn't available");
    const actor: Actor = { name: "Public form" };
    const record = await this.records.create(app, form.entity, data, actor, { source: "public", onlyFields: form.fields, defaults: form.defaults });
    return { ok: true, message: form.successMessage, reference: record.reference };
  }

  // --- helpers ------------------------------------------------------------------

  async require(businessId: string, id: string): Promise<AppRow> {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app || app.businessId !== businessId) throw new NotFoundException("App not found");
    return app;
  }

  private async requireLive(slug: string): Promise<AppRow> {
    const app = await prisma.app.findUnique({ where: { slug } });
    if (!app || app.status !== "live") throw new NotFoundException("This page isn't available");
    return app;
  }

  private text(value: unknown, label: string, max: number): string {
    if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${label} is required`);
    return value.trim().slice(0, max);
  }

  private color(value: unknown): string {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#2563EB";
  }

  /** "Sunrise Dental Clinic" -> "sunrise-dental-clinic", "-2", "-3"… if taken. */
  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "app";
    for (let i = 1; i < 100; i++) {
      const slug = i === 1 && !RESERVED_SLUGS.has(base) ? base : `${base}-${i}`;
      if (!(await prisma.app.findUnique({ where: { slug } }))) return slug;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  private serialize(app: AppRow, counts: { entity: string; source: string; _count: number }[] = []): App {
    const recordCounts: Record<string, number> = {};
    for (const c of counts) recordCounts[c.entity] = (recordCounts[c.entity] ?? 0) + c._count;
    return {
      id: app.id,
      businessId: app.businessId,
      slug: app.slug,
      templateKey: app.templateKey ?? undefined,
      name: app.name,
      tagline: app.tagline,
      icon: app.icon,
      color: app.color,
      status: app.status as App["status"],
      definition: definitionOf(app),
      settings: app.settings as unknown as AppSettings,
      recordCounts,
      sampleCount: counts.filter((c) => c.source === "sample").reduce((n, c) => n + c._count, 0),
      publicUrl: `${config.webAppUrl}/a/${app.slug}`,
      createdAt: app.createdAt.toISOString(),
      updatedAt: app.updatedAt.toISOString(),
    };
  }
}
