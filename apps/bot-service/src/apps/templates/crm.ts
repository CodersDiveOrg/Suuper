import type { AppDefinition } from "@platform/shared-types";
import { C, currencyOf, dateFrom, field, list, options, seeded } from "./helpers";
import type { AppTemplate, SampleRecord } from "./types";

const STAGES = ["New", "Contacted", "Qualified", "Proposal sent", "Won", "Lost"];
const CLOSED = ["Won", "Lost"];
const SOURCES = ["Website", "WhatsApp", "Facebook", "Instagram", "Referral", "Walk-in", "Cold call"];
const OPEN = { field: "stage", op: "nin" as const, value: CLOSED };

export const crm: AppTemplate = {
  key: "crm",
  name: "CRM & Leads",
  category: "sales",
  icon: "🤝",
  color: "#2563EB",
  tagline: "Capture every lead, follow up on time and close more deals",
  problem: "Leads arrive on WhatsApp, Instagram and phone calls and live in someone's memory. Follow-ups are forgotten, and nobody knows the pipeline's worth or what's working.",
  outcomes: [
    "Every lead in one place, from the team or a public enquiry form",
    "A drag-and-drop pipeline from New to Won",
    "Follow-up reminders so no lead goes cold",
    "Pipeline value, win rate and best lead sources on the dashboard",
    "AI drafts follow-up messages",
  ],
  bestFor: "Real estate, agencies, schools, car dealers, B2B sellers, consultants",
  keywords: ["crm", "lead", "leads", "sales", "pipeline", "deals", "clients", "customers", "follow up", "follow-up", "prospects", "real estate", "property", "enquiries", "inquiries"],
  setupQuestions: [
    { key: "currency", label: "Currency", type: "text", required: true, default: "PKR" },
    { key: "sources", label: "Where do your leads come from?", help: "One per line or comma-separated.", type: "list", required: true, default: SOURCES.join(", ") },
    { key: "products", label: "What do you sell?", help: "Products or services leads ask about; one per line or comma-separated.", type: "list", placeholder: "Website design, SEO, Social media management" },
  ],

  build(answers): AppDefinition {
    const products = list(answers.products, []);
    return {
      currency: currencyOf(answers),
      entities: [
        {
          key: "lead",
          name: "Lead",
          pluralName: "Leads",
          icon: "👤",
          titleField: "name",
          numberPrefix: "L-",
          statusField: "stage",
          doneStatuses: CLOSED,
          completedAtField: "closedAt",
          fields: [
            field("name", "Name", "text", { required: true, showInTable: true }),
            field("company", "Company", "text", { showInTable: true }),
            field("phone", "Phone / WhatsApp", "phone", { showInTable: true }),
            field("email", "Email", "email"),
            products.length > 0
              ? field("interestedIn", "Interested in", "select", { showInTable: true, options: options(products) })
              : field("interestedIn", "Interested in", "text", { showInTable: true }),
            field("source", "Source", "select", { showInTable: true, options: options(list(answers.sources, SOURCES)) }),
            field("stage", "Stage", "select", { showInTable: true, options: options(STAGES, [C.sky, C.blue, C.violet, C.amber, C.green, C.gray]) }),
            field("value", "Deal value", "currency", { showInTable: true }),
            field("owner", "Owner", "user", { showInTable: true }),
            field("nextFollowUp", "Next follow-up", "date", { showInTable: true }),
            field("notes", "Notes", "textarea"),
            field("closedAt", "Closed at", "datetime", { readOnly: true }),
          ],
          aiActions: [
            { key: "follow-up", label: "Draft a follow-up message", prompt: "Write a short, friendly WhatsApp follow-up message to this lead that moves the conversation to the next stage. Use the business knowledge for details about what we sell; don't invent prices or offers." },
            { key: "next-step", label: "Suggest the next step", prompt: "Suggest the single best next step to move this lead forward and why, in 2–3 sentences." },
          ],
        },
      ],
      views: [
        { key: "pipeline", name: "Pipeline", icon: "🗂️", entity: "lead", type: "board", groupBy: "stage" },
        { key: "follow-ups", name: "Follow-ups due", icon: "⏰", entity: "lead", type: "table", filters: [{ field: "nextFollowUp", op: "before", value: "$endOfToday" }, OPEN], sort: { field: "nextFollowUp", dir: "asc" } },
        { key: "mine", name: "My leads", icon: "🙋", entity: "lead", type: "table", filters: [{ field: "owner", op: "eq", value: "$me" }, OPEN], sort: { field: "nextFollowUp", dir: "asc" } },
        { key: "calendar", name: "Follow-up calendar", icon: "📅", entity: "lead", type: "calendar", dateField: "nextFollowUp" },
        { key: "all", name: "All leads", icon: "📋", entity: "lead", type: "table", sort: { field: "createdAt", dir: "desc" } },
      ],
      dashboard: [
        { key: "pipeline", title: "Open pipeline value", type: "metric", entity: "lead", aggregate: "sum", field: "value", filters: [OPEN], format: "currency" },
        { key: "won-month", title: "Won this month", type: "metric", entity: "lead", aggregate: "sum", field: "value", dateField: "closedAt", period: "this_month", filters: [{ field: "stage", op: "eq", value: "Won" }], format: "currency", tone: "good" },
        { key: "win-rate", title: "Win rate", type: "metric", entity: "lead", aggregate: "ratio", filters: [{ field: "stage", op: "in", value: CLOSED }], ratioFilters: [{ field: "stage", op: "eq", value: "Won" }], format: "percent" },
        { key: "follow-ups", title: "Follow-ups due", type: "metric", entity: "lead", aggregate: "count", filters: [{ field: "nextFollowUp", op: "before", value: "$endOfToday" }, OPEN], tone: "warn" },
        { key: "by-stage", title: "Leads by stage", type: "bar", entity: "lead", aggregate: "count", groupBy: "stage", span: 2 },
        { key: "by-source", title: "Where leads come from (30 days)", type: "donut", entity: "lead", aggregate: "count", groupBy: "source", period: "last_30_days", span: 2 },
        { key: "won-trend", title: "Won per month", type: "trend", entity: "lead", aggregate: "sum", field: "value", dateField: "closedAt", trend: { unit: "month", count: 6 }, filters: [{ field: "stage", op: "eq", value: "Won" }], format: "currency", span: 2 },
        { key: "per-owner", title: "Open pipeline by owner", type: "bar", entity: "lead", aggregate: "sum", field: "value", groupBy: "owner", filters: [OPEN], format: "currency", span: 2 },
        { key: "due-list", title: "Follow up today", type: "list", entity: "lead", aggregate: "count", dateField: "nextFollowUp", filters: [{ field: "nextFollowUp", op: "before", value: "$endOfToday" }, OPEN], span: 4 },
      ],
      publicForms: [
        {
          key: "enquiry",
          entity: "lead",
          title: "Get in touch",
          description: "Leave your details and we'll call you back.",
          buttonLabel: "Send enquiry",
          successMessage: "Thanks! We'll contact you shortly.",
          fields: ["name", "phone", "email", "company", "interestedIn", "notes"],
          defaults: { source: "Website", stage: "New" },
          enabled: true,
        },
      ],
      automations: [
        {
          key: "new-web-lead",
          name: "New website lead",
          description: "When someone sends the enquiry form, notify the sales team.",
          trigger: { type: "created", entity: "lead" },
          conditions: [{ field: "source", op: "eq", value: "Website" }],
          enabled: false,
        },
        {
          key: "won",
          name: "Deal won",
          description: "When a lead is won, celebrate in Slack or hand over to delivery.",
          trigger: { type: "changed", entity: "lead", field: "stage", to: "Won" },
          enabled: false,
        },
      ],
    };
  },

  samples(definition, now): SampleRecord[] {
    const r = seeded(23);
    const lead = definition.entities[0];
    const sources = lead.fields.find((f) => f.key === "source")!.options!.map((o) => o.value);
    const interested = lead.fields.find((f) => f.key === "interestedIn")!;
    const products = interested.options?.map((o) => o.value) ?? ["Website design", "SEO package", "Social media management", "Mobile app", "Branding"];
    const people = ["Ahmed Raza", "Fatima Zahra", "Kamran Akmal", "Nida Yasir", "Saad Hussain", "Amna Sheikh", "Junaid Khan", "Maria Wasti", "Haris Sohail", "Iqra Aziz", "Taimoor Ali", "Sadia Imam"];
    const companies = ["Gulberg Motors", "Al-Noor Textiles", "Cheezy Bites", "Prime Realty", "Bright Future School", "", "", "Nexa Internet", "Lahore Grammar Café", ""];
    const records: SampleRecord[] = [];
    for (let i = 0; i < 34; i++) {
      const age = Math.floor(Math.pow(r.next(), 1.4) * 150);
      const stage = age > 45 ? r.pick(["Won", "Lost", "Won", "Lost", "Proposal sent"]) : age > 10 ? r.pick(["Contacted", "Qualified", "Proposal sent", "Won", "Lost"]) : r.pick(["New", "New", "Contacted", "Qualified"]);
      const closed = CLOSED.includes(stage);
      records.push({
        entity: "lead",
        hoursAgo: age * 24 + r.int(1, 9),
        me: r.next() < 0.6 ? ["owner"] : [],
        data: {
          name: r.pick(people),
          company: r.pick(companies) || undefined,
          phone: `+92 3${r.int(0, 4)}${r.int(0, 9)} ${r.int(1_000_000, 9_999_999)}`,
          interestedIn: r.pick(products),
          source: r.pick(sources),
          stage,
          value: Math.round(r.int(40, 600)) * 1000,
          ...(closed
            ? { closedAt: new Date(now.getTime() - Math.max(0, age - r.int(3, 20)) * 86_400_000).toISOString() }
            : { nextFollowUp: dateFrom(now, r.int(-3, 6)) }),
        },
      });
    }
    return records;
  },
};
