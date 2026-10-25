import type { AppDefinition } from "@platform/shared-types";
import { C, currencyOf, dateFrom, field, list, options, seeded } from "./helpers";
import type { AppTemplate, SampleRecord } from "./types";

const CATEGORIES = ["Travel", "Food & meals", "Office supplies", "Utilities", "Rent", "Salaries", "Marketing", "Software", "Fuel", "Other"];
const STATUSES = ["Pending", "Approved", "Rejected", "Reimbursed"];
const DONE = ["Approved", "Rejected", "Reimbursed"];
const OPEN_FILTER = { field: "status", op: "neq" as const, value: "Rejected" };

export const expenses: AppTemplate = {
  key: "expense-tracker",
  name: "Expense Tracker",
  category: "finance",
  icon: "🧾",
  color: "#F97316",
  tagline: "Track spending, approve claims and stay inside budget",
  problem: "Receipts get lost in WhatsApp chats and pockets, nobody knows this month's spend until the accountant asks, and claims wait weeks for approval.",
  outcomes: [
    "Everyone logs expenses in seconds, from the dashboard or a public claim form",
    "Approve, reject and mark claims reimbursed on a board",
    "Monthly budgets per category with live spend against them",
    "Spend this month, by category and over time, with CSV export",
  ],
  bestFor: "Offices, agencies, shops, schools and any team with petty cash or reimbursements",
  keywords: ["expense", "expenses", "spending", "spend", "receipt", "receipts", "reimbursement", "petty cash", "budget", "bookkeeping", "kharcha", "claims"],
  setupQuestions: [
    { key: "currency", label: "Currency", placeholder: "PKR", type: "text", required: true, default: "PKR" },
    { key: "categories", label: "Expense categories", help: "One per line or comma-separated.", type: "list", required: true, default: CATEGORIES.join(", ") },
    { key: "approvalLimit", label: "Expenses above this amount need approval", placeholder: "25000", type: "text", default: "25000" },
  ],

  build(answers): AppDefinition {
    const currency = currencyOf(answers);
    const categories = options(list(answers.categories, CATEGORIES));
    const limit = Number(answers.approvalLimit?.replace(/,/g, "")) || 25000;
    return {
      currency,
      entities: [
        {
          key: "expense",
          name: "Expense",
          pluralName: "Expenses",
          icon: "🧾",
          titleField: "title",
          numberPrefix: "EXP-",
          statusField: "status",
          doneStatuses: DONE,
          completedAtField: "decidedAt",
          fields: [
            field("title", "What was it for?", "text", { required: true, showInTable: true, placeholder: "e.g. Careem to client meeting" }),
            field("amount", "Amount", "currency", { required: true, showInTable: true }),
            field("category", "Category", "select", { required: true, showInTable: true, options: categories, aiSuggest: true }),
            field("date", "Date", "date", { required: true, showInTable: true }),
            field("paidBy", "Paid by", "text", { required: true, showInTable: true, placeholder: "Name" }),
            field("paymentMethod", "Payment method", "select", { options: options(["Cash", "Card", "Bank transfer", "JazzCash / Easypaisa", "Company account"]) }),
            field("status", "Status", "select", { showInTable: true, options: options(STATUSES, [C.amber, C.green, C.red, C.teal]) }),
            field("receipt", "Receipt link", "url", { placeholder: "Google Drive or photo link" }),
            field("notes", "Notes", "textarea"),
            field("decidedAt", "Decided at", "datetime", { readOnly: true }),
          ],
        },
        {
          key: "budget",
          name: "Budget",
          pluralName: "Budgets",
          icon: "🎯",
          titleField: "category",
          numberPrefix: "BUD-",
          fields: [
            field("category", "Category", "select", { required: true, showInTable: true, options: categories }),
            field("monthlyLimit", "Monthly limit", "currency", { required: true, showInTable: true }),
            field("notes", "Notes", "textarea"),
          ],
        },
      ],
      views: [
        { key: "all", name: "All expenses", icon: "📋", entity: "expense", type: "table", sort: { field: "date", dir: "desc" } },
        { key: "approvals", name: "Approvals", icon: "✅", entity: "expense", type: "board", groupBy: "status" },
        { key: "month", name: "This month", icon: "🗓️", entity: "expense", type: "table", filters: [{ field: "date", op: "after", value: "$monthStart" }], sort: { field: "date", dir: "desc" } },
        { key: "calendar", name: "Calendar", icon: "📅", entity: "expense", type: "calendar", dateField: "date" },
        { key: "budgets", name: "Budgets", icon: "🎯", entity: "budget", type: "table" },
      ],
      dashboard: [
        { key: "spent-month", title: "Spent this month", type: "metric", entity: "expense", aggregate: "sum", field: "amount", dateField: "date", period: "this_month", filters: [OPEN_FILTER], format: "currency" },
        { key: "pending", title: "Waiting for approval", type: "metric", entity: "expense", aggregate: "count", filters: [{ field: "status", op: "eq", value: "Pending" }], tone: "warn" },
        { key: "to-reimburse", title: "Approved, not yet paid back", type: "metric", entity: "expense", aggregate: "sum", field: "amount", filters: [{ field: "status", op: "eq", value: "Approved" }], format: "currency" },
        { key: "count-month", title: "Expenses this month", type: "metric", entity: "expense", aggregate: "count", dateField: "date", period: "this_month", filters: [OPEN_FILTER] },
        { key: "by-category", title: "Spend by category this month", type: "donut", entity: "expense", aggregate: "sum", field: "amount", groupBy: "category", dateField: "date", period: "this_month", filters: [OPEN_FILTER], format: "currency", span: 2 },
        { key: "budgets", title: "Budgets this month", type: "progress", entity: "expense", aggregate: "sum", field: "amount", groupBy: "category", dateField: "date", period: "this_month", filters: [OPEN_FILTER], target: { entity: "budget", keyField: "category", valueField: "monthlyLimit" }, format: "currency", span: 2 },
        { key: "trend", title: "Monthly spend", type: "trend", entity: "expense", aggregate: "sum", field: "amount", dateField: "date", trend: { unit: "month", count: 6 }, filters: [OPEN_FILTER], format: "currency", span: 2 },
        { key: "by-person", title: "Spend by person this month", type: "bar", entity: "expense", aggregate: "sum", field: "amount", groupBy: "paidBy", dateField: "date", period: "this_month", filters: [OPEN_FILTER], format: "currency", span: 2 },
        { key: "recent", title: "Latest expenses", type: "list", entity: "expense", aggregate: "count", dateField: "date", span: 4 },
      ],
      publicForms: [
        {
          key: "claim",
          entity: "expense",
          title: "Submit an expense claim",
          description: "Spent your own money on work? Send it here to get paid back.",
          buttonLabel: "Submit claim",
          successMessage: "Claim submitted! You'll be paid back once it's approved.",
          fields: ["paidBy", "title", "amount", "category", "date", "paymentMethod", "receipt", "notes"],
          defaults: { status: "Pending" },
          enabled: true,
        },
      ],
      automations: [
        {
          key: "large-expense",
          name: "Large expense needs approval",
          description: `When an expense over ${limit.toLocaleString("en-US")} ${currency} is added, notify the approver.`,
          trigger: { type: "created", entity: "expense" },
          conditions: [{ field: "amount", op: "gt", value: limit }],
          enabled: false,
        },
        {
          key: "approved",
          name: "Claim approved",
          description: "When an expense is approved, let the person know they'll be paid back.",
          trigger: { type: "changed", entity: "expense", field: "status", to: "Approved" },
          enabled: false,
        },
      ],
    };
  },

  samples(definition, now): SampleRecord[] {
    const r = seeded(7);
    const categories = definition.entities[0].fields.find((f) => f.key === "category")!.options!.map((o) => o.value);
    const items: Record<string, [string, number, number][]> = {
      Travel: [["Careem to client meeting", 650, 1400], ["Train tickets to Islamabad", 4000, 9000], ["InDrive to bank", 400, 900]],
      "Food & meals": [["Team lunch", 3500, 9000], ["Chai and snacks for visitors", 600, 1500], ["Client dinner", 6000, 14000]],
      "Office supplies": [["Printer paper and toner", 1800, 6500], ["Whiteboard markers", 450, 900]],
      Marketing: [["Facebook ads", 8000, 25000], ["Printed flyers", 3500, 7000]],
      Fuel: [["Generator diesel", 4000, 9000], ["Car fuel for site visit", 2500, 6000]],
    };
    const people = ["Ali Raza", "Sara Khan", "Bilal Ahmed", "Hina Tariq"];
    const records: SampleRecord[] = [];
    const known = categories.filter((c) => items[c]);
    for (let i = 0; i < 40; i++) {
      const category = r.pick(known.length ? known : categories);
      const [title, min, max] = r.pick(items[category] ?? [["Miscellaneous purchase", 500, 5000]]);
      const daysAgo = Math.floor(Math.pow(r.next(), 1.3) * 150);
      const status = daysAgo > 20 ? r.pick(["Reimbursed", "Approved", "Reimbursed", "Rejected"]) : daysAgo > 5 ? r.pick(["Approved", "Pending", "Reimbursed"]) : "Pending";
      records.push({
        entity: "expense",
        hoursAgo: daysAgo * 24 + r.int(1, 8),
        data: {
          title,
          amount: Math.round(r.int(min, max) / 50) * 50,
          category,
          date: dateFrom(now, -daysAgo),
          paidBy: r.pick(people),
          paymentMethod: r.pick(["Cash", "Card", "Bank transfer", "JazzCash / Easypaisa"]),
          status,
          ...(status !== "Pending" ? { decidedAt: new Date(now.getTime() - (daysAgo - 1) * 86_400_000).toISOString() } : {}),
        },
      });
    }
    // Bills arrive once a month, early on.
    const monthly: [string, string, number, number][] = [
      ["Rent", "Office rent", 85000, 2],
      ["Utilities", "Electricity bill", 24000, 6],
      ["Utilities", "Internet bill", 6500, 8],
      ["Software", "Google Workspace", 6200, 3],
    ];
    const [year, monthOfYear] = dateFrom(now, 0).split("-").map(Number);
    for (let month = 0; month < 5; month++) {
      for (const [category, title, amount, day] of monthly) {
        if (!categories.includes(category)) continue;
        const date = new Date(Date.UTC(year, monthOfYear - 1 - month, day));
        if (date > now) continue;
        const daysAgo = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
        records.push({
          entity: "expense",
          hoursAgo: daysAgo * 24 + 2,
          data: {
            title,
            amount: category === "Utilities" && title.startsWith("Electricity") ? amount + r.int(-6, 9) * 1000 : amount,
            category,
            date: date.toISOString().slice(0, 10),
            paidBy: "Sara Khan",
            paymentMethod: "Bank transfer",
            status: month === 0 && daysAgo < 3 ? "Pending" : "Reimbursed",
            ...(month === 0 && daysAgo < 3 ? {} : { decidedAt: new Date(date.getTime() + 86_400_000).toISOString() }),
          },
        });
      }
    }
    const limits: Record<string, number> = { Travel: 25000, "Food & meals": 20000, "Office supplies": 10000, Utilities: 45000, Marketing: 40000, Software: 12000, Fuel: 15000, Rent: 85000 };
    for (const category of categories.filter((c) => limits[c])) {
      records.push({ entity: "budget", hoursAgo: 24 * 160, data: { category, monthlyLimit: limits[category] } });
    }
    return records;
  },
};
