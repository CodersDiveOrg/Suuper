import type { AppDefinition } from "@platform/shared-types";
import { C, field, list, options, seeded } from "./helpers";
import type { AppTemplate, SampleRecord } from "./types";

const CATEGORIES = ["Billing", "Technical issue", "Complaint", "Order / delivery", "Account", "Other"];
const STATUSES = ["Open", "In progress", "Waiting on customer", "Resolved", "Closed"];
const DONE = ["Resolved", "Closed"];
const PRIORITIES = ["Low", "Normal", "High", "Urgent"];
const NOT_DONE = { field: "status", op: "nin" as const, value: DONE };

export const tickets: AppTemplate = {
  key: "ticket-manager",
  name: "Ticket Manager",
  category: "support",
  icon: "🎧",
  color: "#DC2626",
  tagline: "Log every call and complaint, assign it, and resolve it on time",
  problem: "Calls and complaints get written on sticky notes and spreadsheets. Tickets get lost, customers repeat themselves, and nobody knows what's overdue or who's overloaded.",
  outcomes: [
    "Agents log a ticket in seconds and give the customer a reference number",
    "A board from Open to Resolved, with priorities, assignees and due times by SLA",
    "Overdue and urgent tickets surface automatically",
    "Resolution time, tickets per agent and per category on the dashboard",
    "AI drafts replies from your knowledge base",
  ],
  bestFor: "Call centers and BPOs, ISPs, e-commerce support, service companies",
  keywords: ["call center", "call centre", "contact center", "bpo", "ticket", "tickets", "ticketing", "helpdesk", "help desk", "support", "complaint", "complaints", "customer service", "agents"],
  setupQuestions: [
    { key: "categories", label: "Ticket categories", help: "One per line or comma-separated.", type: "list", required: true, default: CATEGORIES.join(", ") },
    { key: "channels", label: "Where do tickets come from?", type: "list", required: true, default: "Phone, WhatsApp, Email, Web form, Walk-in" },
    { key: "urgentHours", label: "Resolve urgent tickets within (hours)", type: "text", default: "4" },
  ],

  build(answers): AppDefinition {
    const urgent = Number(answers.urgentHours) || 4;
    return {
      currency: "PKR",
      entities: [
        {
          key: "ticket",
          name: "Ticket",
          pluralName: "Tickets",
          icon: "🎫",
          titleField: "subject",
          numberPrefix: "T-",
          statusField: "status",
          doneStatuses: DONE,
          completedAtField: "resolvedAt",
          sla: { field: "priority", dueField: "dueAt", hours: { Urgent: urgent, High: urgent * 2, Normal: 24, Low: 72 } },
          fields: [
            field("subject", "Subject", "text", { required: true, showInTable: true, placeholder: "e.g. No internet since morning" }),
            field("customerName", "Customer", "text", { required: true, showInTable: true }),
            field("customerPhone", "Phone", "phone", { placeholder: "+92 300 1234567" }),
            field("customerEmail", "Email", "email"),
            field("channel", "Channel", "select", { showInTable: true, options: options(list(answers.channels, ["Phone", "WhatsApp", "Email", "Web form", "Walk-in"])) }),
            field("category", "Category", "select", { required: true, showInTable: true, options: options(list(answers.categories, CATEGORIES)), aiSuggest: true }),
            field("priority", "Priority", "select", { required: true, showInTable: true, options: options(PRIORITIES, [C.gray, C.blue, C.orange, C.red]), aiSuggest: true }),
            field("status", "Status", "select", { showInTable: true, options: options(STATUSES, [C.blue, C.violet, C.amber, C.green, C.gray]) }),
            field("assignee", "Assigned to", "user", { showInTable: true }),
            field("description", "Details", "textarea", { placeholder: "What happened, what the customer needs" }),
            field("dueAt", "Due", "datetime", { showInTable: true }),
            field("resolvedAt", "Resolved at", "datetime", { readOnly: true }),
          ],
          aiActions: [
            { key: "reply", label: "Draft a reply", prompt: "Write a short, polite reply to the customer that answers their issue or explains the next step. Use the business knowledge when it covers the issue; don't invent policies, prices or timelines." },
            { key: "next-steps", label: "Suggest next steps", prompt: "List 2–4 concrete next steps for the agent to resolve this ticket, based on the details and the business knowledge." },
          ],
        },
      ],
      views: [
        { key: "board", name: "Board", icon: "🗂️", entity: "ticket", type: "board", groupBy: "status" },
        { key: "mine", name: "My tickets", icon: "🙋", entity: "ticket", type: "table", filters: [{ field: "assignee", op: "eq", value: "$me" }, NOT_DONE], sort: { field: "dueAt", dir: "asc" } },
        { key: "overdue", name: "Overdue", icon: "⏰", entity: "ticket", type: "table", filters: [{ field: "dueAt", op: "before", value: "$now" }, NOT_DONE], sort: { field: "dueAt", dir: "asc" } },
        { key: "all", name: "All tickets", icon: "📋", entity: "ticket", type: "table", sort: { field: "createdAt", dir: "desc" } },
      ],
      dashboard: [
        { key: "open", title: "Open tickets", type: "metric", entity: "ticket", aggregate: "count", filters: [NOT_DONE] },
        { key: "urgent", title: "Urgent and open", type: "metric", entity: "ticket", aggregate: "count", filters: [NOT_DONE, { field: "priority", op: "eq", value: "Urgent" }], tone: "bad" },
        { key: "overdue", title: "Overdue", type: "metric", entity: "ticket", aggregate: "count", filters: [NOT_DONE, { field: "dueAt", op: "before", value: "$now" }], tone: "warn" },
        { key: "resolved-week", title: "Resolved this week", type: "metric", entity: "ticket", aggregate: "count", dateField: "resolvedAt", period: "this_week", filters: [{ field: "resolvedAt", op: "notEmpty" }], tone: "good" },
        { key: "resolution", title: "Average resolution time (30 days)", type: "metric", entity: "ticket", aggregate: "duration", dateField: "resolvedAt", period: "last_30_days", format: "hours" },
        { key: "on-time", title: "Resolved on time (30 days)", type: "metric", entity: "ticket", aggregate: "ratio", dateField: "resolvedAt", period: "last_30_days", filters: [{ field: "resolvedAt", op: "notEmpty" }], ratioFilters: [{ field: "resolvedAt", op: "before", value: "$dueAt" }], format: "percent", tone: "good" },
        { key: "new-today", title: "New today", type: "metric", entity: "ticket", aggregate: "count", period: "today" },
        { key: "new-week", title: "New this week", type: "metric", entity: "ticket", aggregate: "count", period: "this_week" },
        { key: "by-status", title: "Tickets by status", type: "bar", entity: "ticket", aggregate: "count", groupBy: "status", span: 2 },
        { key: "by-category", title: "By category (30 days)", type: "donut", entity: "ticket", aggregate: "count", groupBy: "category", period: "last_30_days", span: 2 },
        { key: "trend", title: "New tickets per day", type: "trend", entity: "ticket", aggregate: "count", trend: { unit: "day", count: 14 }, span: 2 },
        { key: "per-agent", title: "Open tickets per agent", type: "bar", entity: "ticket", aggregate: "count", groupBy: "assignee", filters: [NOT_DONE], span: 2 },
        { key: "urgent-list", title: "Urgent tickets", type: "list", entity: "ticket", aggregate: "count", filters: [NOT_DONE, { field: "priority", op: "in", value: ["Urgent", "High"] }], span: 4 },
      ],
      publicForms: [
        {
          key: "raise",
          entity: "ticket",
          title: "Raise a support ticket",
          description: "Tell us what's wrong and our team will get back to you.",
          buttonLabel: "Submit ticket",
          successMessage: "Ticket received! Keep this reference number to follow up.",
          fields: ["customerName", "customerPhone", "customerEmail", "category", "subject", "description"],
          defaults: { channel: "Web form", priority: "Normal" },
          enabled: true,
        },
      ],
      automations: [
        {
          key: "urgent",
          name: "Urgent ticket alert",
          description: "When an urgent ticket is created, alert the supervisor (e.g. on Slack or WhatsApp).",
          trigger: { type: "created", entity: "ticket" },
          conditions: [{ field: "priority", op: "eq", value: "Urgent" }],
          enabled: false,
        },
        {
          key: "assigned",
          name: "Ticket assigned",
          description: "When a ticket is assigned, notify the agent.",
          trigger: { type: "changed", entity: "ticket", field: "assignee" },
          enabled: false,
        },
        {
          key: "resolved",
          name: "Ticket resolved",
          description: "When a ticket is resolved, send the customer a confirmation.",
          trigger: { type: "changed", entity: "ticket", field: "status", to: "Resolved" },
          enabled: false,
        },
      ],
    };
  },

  samples(definition, now): SampleRecord[] {
    const r = seeded(11);
    const ticket = definition.entities[0];
    const categories = ticket.fields.find((f) => f.key === "category")!.options!.map((o) => o.value);
    const channels = ticket.fields.find((f) => f.key === "channel")!.options!.map((o) => o.value);
    const hours = ticket.sla!.hours;
    const issues: [string, string][] = [
      ["No internet since morning", "Router lights are red, customer already restarted it twice."],
      ["Charged twice this month", "Two deductions of the same amount on the 3rd. Wants a refund."],
      ["Order not delivered", "Order placed 5 days ago, tracking shows no update."],
      ["Wrong item received", "Received size M instead of L, wants an exchange."],
      ["Can't log in to account", "Password reset email not arriving."],
      ["Slow speed in the evening", "Speed drops below 2 Mbps after 8pm every day."],
      ["Rude behaviour by technician", "Customer complains the visiting technician was rude."],
      ["Refund still pending", "Refund approved two weeks ago but not received."],
      ["Change billing address", "Moved to a new house, wants the bill at the new address."],
      ["Cancel subscription", "Moving abroad next month, wants to cancel."],
    ];
    const names = ["Usman Tariq", "Ayesha Khan", "Bilal Ahmed", "Sana Malik", "Hamza Iqbal", "Mehwish Ali", "Fahad Qureshi", "Zainab Shah", "Omar Farooq", "Rabia Noor"];
    const records: SampleRecord[] = [];
    for (let i = 0; i < 38; i++) {
      const [subject, description] = r.pick(issues);
      // A few from the last hours, so today's queue isn't empty.
      const age = i < 4 ? r.int(1, 6) : Math.floor(Math.pow(r.next(), 1.6) * 20 * 24) + 1;
      const priority = r.pick(["Normal", "Normal", "High", "Low", "Urgent", "Normal", "High"]);
      const createdAt = now.getTime() - age * 3_600_000;
      let due = createdAt + (hours[priority] ?? 24) * 3_600_000;
      // Older tickets are mostly resolved, a few late; recent ones are still moving.
      const status = age > 72 ? r.pick(["Resolved", "Closed", "Resolved", "Waiting on customer"]) : age > 8 ? r.pick(["In progress", "Resolved", "Waiting on customer", "Open"]) : r.pick(["Open", "Open", "In progress"]);
      const done = status === "Resolved" || status === "Closed";
      // Most open tickets past their SLA got a new due time from the agent; a few are really late.
      if (!done && due < now.getTime() && r.next() < 0.75) due = now.getTime() + r.int(2, 30) * 3_600_000;
      const resolvedAt = done ? createdAt + (hours[priority] ?? 24) * 3_600_000 * (0.3 + r.next() * 1.1) : undefined;
      const name = r.pick(names);
      records.push({
        entity: "ticket",
        hoursAgo: age,
        me: r.next() < 0.5 ? ["assignee"] : [],
        data: {
          subject,
          description,
          customerName: name,
          customerPhone: `+92 3${r.int(0, 4)}${r.int(0, 9)} ${r.int(1_000_000, 9_999_999)}`,
          channel: r.pick(channels),
          category: subject.includes("Charged") || subject.includes("Refund") || subject.includes("billing") ? (categories.find((c) => /bill/i.test(c)) ?? r.pick(categories)) : r.pick(categories),
          priority,
          status,
          dueAt: new Date(due).toISOString(),
          ...(resolvedAt ? { resolvedAt: new Date(Math.min(resolvedAt, now.getTime())).toISOString() } : {}),
        },
      });
    }
    return records;
  },
};
