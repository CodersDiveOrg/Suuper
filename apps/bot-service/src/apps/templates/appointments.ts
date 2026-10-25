import type { AppDefinition } from "@platform/shared-types";
import { C, currencyOf, field, list, options, seeded, timeFrom } from "./helpers";
import type { AppTemplate, SampleRecord } from "./types";

const STATUSES = ["Requested", "Confirmed", "Completed", "Cancelled", "No-show"];
const FINISHED = ["Completed", "Cancelled", "No-show"];
const DEFAULT_SERVICES = "Consultation, 30, 2500\nFollow-up visit, 20, 1500\nFull check-up, 60, 6000";
const ACTIVE = { field: "status", op: "nin" as const, value: ["Cancelled"] };

/** "Consultation, 30, 2500" lines -> services; a bare name gets 30 minutes and no price. */
export function parseServices(answer: string | undefined): { name: string; duration: number; price?: number }[] {
  const lines = (answer?.trim() ? answer : DEFAULT_SERVICES).split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, 30).map((line) => {
    const [name, duration, price] = line.split(",").map((p) => p.trim());
    const cost = Number(price?.replace(/[^\d.]/g, ""));
    return { name, duration: Number(duration) || 30, ...(Number.isFinite(cost) && cost > 0 ? { price: cost } : {}) };
  });
}

export const appointments: AppTemplate = {
  key: "appointments",
  name: "Appointments & Bookings",
  category: "operations",
  icon: "📅",
  color: "#0EA5E9",
  tagline: "Take bookings online, see the day at a glance and cut no-shows",
  problem: "Bookings come by phone and WhatsApp and get written in a register. Double bookings happen, nobody confirms on time, and no-shows waste the day.",
  outcomes: [
    "A public booking page with your services and prices",
    "A calendar and today's schedule for the front desk",
    "Confirm, complete or mark no-show in one tap",
    "Revenue, busiest services and no-show rate on the dashboard",
    "AI drafts confirmations and reminders",
  ],
  bestFor: "Clinics, salons and spas, gyms, consultants, tutors, repair shops",
  keywords: ["appointment", "appointments", "booking", "bookings", "book", "clinic", "doctor", "dental", "salon", "spa", "barber", "gym", "schedule", "reservation", "reservations", "consultant", "tutor"],
  setupQuestions: [
    { key: "currency", label: "Currency", type: "text", required: true, default: "PKR" },
    { key: "services", label: "Services: name, minutes, price", help: "One service per line, e.g. “Haircut, 30, 1500”.", type: "textarea", required: true, default: DEFAULT_SERVICES },
    { key: "staff", label: "Staff who take appointments (optional)", help: "One per line or comma-separated, e.g. doctors or stylists.", type: "list", placeholder: "Dr. Ayesha, Dr. Imran" },
  ],

  build(answers): AppDefinition {
    const staff = list(answers.staff, []);
    return {
      currency: currencyOf(answers),
      entities: [
        {
          key: "appointment",
          name: "Appointment",
          pluralName: "Appointments",
          icon: "📅",
          titleField: "customerName",
          numberPrefix: "A-",
          statusField: "status",
          doneStatuses: FINISHED,
          completedAtField: "finishedAt",
          fields: [
            field("customerName", "Name", "text", { required: true, showInTable: true }),
            field("phone", "Phone / WhatsApp", "phone", { required: true, showInTable: true }),
            field("email", "Email", "email"),
            field("service", "Service", "relation", { required: true, showInTable: true, relation: "service" }),
            ...(staff.length > 0 ? [field("staff", "With", "select", { showInTable: true, options: options(staff) })] : []),
            field("startsAt", "Date & time", "datetime", { required: true, showInTable: true }),
            field("status", "Status", "select", { showInTable: true, options: options(STATUSES, [C.amber, C.blue, C.green, C.gray, C.red]) }),
            field("price", "Price", "currency", { showInTable: true, copyFrom: { relationField: "service", field: "price" } }),
            field("notes", "Notes", "textarea"),
            field("finishedAt", "Finished at", "datetime", { readOnly: true }),
          ],
          aiActions: [
            { key: "confirm", label: "Draft a confirmation", prompt: "Write a short, friendly WhatsApp message confirming this appointment with its date, time and service. Add anything useful from the business knowledge (address, what to bring)." },
            { key: "reminder", label: "Draft a reminder", prompt: "Write a short WhatsApp reminder for this appointment, asking the customer to reply to confirm or reschedule." },
          ],
        },
        {
          key: "service",
          name: "Service",
          pluralName: "Services",
          icon: "🏷️",
          titleField: "name",
          numberPrefix: "S-",
          fields: [
            field("name", "Service", "text", { required: true, showInTable: true }),
            field("duration", "Duration (minutes)", "number", { showInTable: true }),
            field("price", "Price", "currency", { showInTable: true }),
            field("active", "Bookable online", "checkbox", { showInTable: true }),
            field("description", "Description", "textarea"),
          ],
        },
      ],
      views: [
        { key: "calendar", name: "Calendar", icon: "📅", entity: "appointment", type: "calendar", dateField: "startsAt" },
        { key: "today", name: "Today", icon: "☀️", entity: "appointment", type: "table", filters: [{ field: "startsAt", op: "sameDay", value: "$today" }], sort: { field: "startsAt", dir: "asc" } },
        { key: "requests", name: "Status board", icon: "🗂️", entity: "appointment", type: "board", groupBy: "status" },
        { key: "all", name: "All appointments", icon: "📋", entity: "appointment", type: "table", sort: { field: "startsAt", dir: "desc" } },
        { key: "services", name: "Services", icon: "🏷️", entity: "service", type: "table" },
      ],
      dashboard: [
        { key: "today", title: "Appointments today", type: "metric", entity: "appointment", aggregate: "count", dateField: "startsAt", period: "today", filters: [ACTIVE] },
        { key: "requests", title: "Requests to confirm", type: "metric", entity: "appointment", aggregate: "count", filters: [{ field: "status", op: "eq", value: "Requested" }], tone: "warn" },
        { key: "revenue", title: "Revenue this month", type: "metric", entity: "appointment", aggregate: "sum", field: "price", dateField: "startsAt", period: "this_month", filters: [{ field: "status", op: "eq", value: "Completed" }], format: "currency", tone: "good" },
        { key: "no-show", title: "No-show rate (30 days)", type: "metric", entity: "appointment", aggregate: "ratio", dateField: "startsAt", period: "last_30_days", filters: [{ field: "status", op: "in", value: ["Completed", "No-show"] }], ratioFilters: [{ field: "status", op: "eq", value: "No-show" }], format: "percent", tone: "bad" },
        { key: "schedule", title: "Today's schedule", type: "list", entity: "appointment", aggregate: "count", dateField: "startsAt", period: "today", filters: [ACTIVE], span: 2 },
        { key: "per-day", title: "Appointments per day", type: "trend", entity: "appointment", aggregate: "count", dateField: "startsAt", trend: { unit: "day", count: 14 }, filters: [ACTIVE], span: 2 },
        { key: "by-service", title: "Bookings by service (30 days)", type: "bar", entity: "appointment", aggregate: "count", groupBy: "service", dateField: "startsAt", period: "last_30_days", filters: [ACTIVE], span: 2 },
        ...(staff.length > 0
          ? [{ key: "by-staff", title: "Bookings by staff (30 days)", type: "donut" as const, entity: "appointment", aggregate: "count" as const, groupBy: "staff", dateField: "startsAt", period: "last_30_days" as const, filters: [ACTIVE], span: 2 as const }]
          : [{ key: "by-status", title: "Appointments by status (30 days)", type: "donut" as const, entity: "appointment", aggregate: "count" as const, groupBy: "status", dateField: "startsAt", period: "last_30_days" as const, span: 2 as const }]),
        { key: "revenue-trend", title: "Revenue per month", type: "trend", entity: "appointment", aggregate: "sum", field: "price", dateField: "startsAt", trend: { unit: "month", count: 6 }, filters: [{ field: "status", op: "eq", value: "Completed" }], format: "currency", span: 4 },
      ],
      publicForms: [
        {
          key: "book",
          entity: "appointment",
          title: "Book an appointment",
          description: "Pick a service and a time. We'll confirm on WhatsApp.",
          buttonLabel: "Request booking",
          successMessage: "Booking requested! We'll confirm it with you shortly.",
          fields: ["customerName", "phone", "email", "service", ...(staff.length > 0 ? ["staff"] : []), "startsAt", "notes"],
          defaults: { status: "Requested" },
          enabled: true,
        },
      ],
      automations: [
        {
          key: "new-request",
          name: "New booking request",
          description: "When someone books online, notify the front desk.",
          trigger: { type: "created", entity: "appointment" },
          conditions: [{ field: "status", op: "eq", value: "Requested" }],
          enabled: false,
        },
        {
          key: "confirmed",
          name: "Booking confirmed",
          description: "When a booking is confirmed, send the customer a WhatsApp or email.",
          trigger: { type: "changed", entity: "appointment", field: "status", to: "Confirmed" },
          enabled: false,
        },
      ],
    };
  },

  // The services from the setup answers are real records, created with the app.
  starterRecords(answers): SampleRecord[] {
    return parseServices(answers.services).map((service, i) => ({
      entity: "service",
      ref: `service-${i}`,
      hoursAgo: 0,
      data: { name: service.name, duration: service.duration, ...(service.price ? { price: service.price } : {}), active: true },
    }));
  },

  samples(definition, now, answers): SampleRecord[] {
    const r = seeded(31);
    const staffField = definition.entities[0].fields.find((f) => f.key === "staff");
    const serviceCount = parseServices(answers.services).length;
    const records: SampleRecord[] = [];
    const names = ["Ayesha Siddiqui", "Hassan Ali", "Mahnoor Khan", "Danish Iqbal", "Sobia Rehman", "Waqar Younis", "Laiba Fatima", "Arslan Butt", "Noor Jahan", "Shoaib Malik"];
    for (let i = 0; i < 44; i++) {
      // From ~5 weeks back to 1 week ahead, during opening hours.
      const day = r.int(-35, 7);
      const startsAt = timeFrom(now, day, r.int(10, 19), r.pick([0, 30]));
      const past = Date.parse(startsAt) < now.getTime();
      const status = past ? r.pick(["Completed", "Completed", "Completed", "Completed", "Completed", "No-show", "Cancelled"]) : r.pick(["Confirmed", "Requested", "Confirmed"]);
      records.push({
        entity: "appointment",
        hoursAgo: Math.max(1, -day * 24 + r.int(24, 96)),
        links: { service: `service-${r.int(0, serviceCount - 1)}` },
        data: {
          customerName: r.pick(names),
          phone: `+92 3${r.int(0, 4)}${r.int(0, 9)} ${r.int(1_000_000, 9_999_999)}`,
          ...(staffField ? { staff: r.pick(staffField.options!.map((o) => o.value)) } : {}),
          startsAt,
          status,
        },
      });
    }
    // A full-looking day for the front desk: some done this morning, the rest still to come.
    for (const [hour, minute] of [[10, 0], [11, 30], [13, 0], [15, 30], [17, 0], [18, 30]]) {
      const startsAt = timeFrom(now, 0, hour, minute);
      const past = Date.parse(startsAt) < now.getTime();
      records.push({
        entity: "appointment",
        hoursAgo: r.int(20, 70),
        links: { service: `service-${r.int(0, serviceCount - 1)}` },
        data: {
          customerName: r.pick(names),
          phone: `+92 3${r.int(0, 4)}${r.int(0, 9)} ${r.int(1_000_000, 9_999_999)}`,
          ...(staffField ? { staff: r.pick(staffField.options!.map((o) => o.value)) } : {}),
          startsAt,
          status: past ? "Completed" : r.pick(["Confirmed", "Confirmed", "Requested"]),
        },
      });
    }
    return records;
  },
};
