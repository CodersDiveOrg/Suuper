import nodemailer from "nodemailer";
import { ActionError, baseUrl, basicAuth, request } from "./http";

type Creds = Record<string, string>;
// Inputs are validated against `params` before run() is called.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Input = Record<string, any>;

export interface ActionParam {
  type: "string" | "number" | "integer" | "boolean";
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface IntegrationAction {
  name: string;
  label: string;
  description: string;
  params: Record<string, ActionParam>;
  /** Sends a message/email to someone — counted against the per-run send limit. */
  sends?: boolean;
  run(creds: Creds, input: Input): Promise<unknown>;
}

const SHOPIFY_API_VERSION = "2025-10"; // Shopify serves the oldest supported version if this one is retired.
const json = { "Content-Type": "application/json" };
const required = (description: string): ActionParam => ({ type: "string", description, required: true });
const optional = (description: string): ActionParam => ({ type: "string", description });

/** Provider key (matches the Integrations catalog) -> the actions agents and bots can call. */
export const INTEGRATION_ACTIONS: Record<string, IntegrationAction[]> = {
  // --- Messaging -------------------------------------------------------------
  slack: [
    {
      name: "send_message",
      label: "Send message",
      description:
        "Post a message to a Slack channel. Use the channel ID (e.g. C0123ABC) or name with # (e.g. #support); if the user doesn't say which channel, use the default channel. The bot must be a member of the channel.",
      params: { channel: optional("Channel ID or #name. Leave empty to use the default channel."), text: required("Message text (Slack markdown allowed).") },
      sends: true,
      run: async (c, i) => {
        const channel = i.channel || c.defaultChannel;
        if (!channel) throw new ActionError("No channel given and no default channel configured");
        const data = await request<{ ok: boolean; error?: string; ts?: string; channel?: string }>({
          url: "https://slack.com/api/chat.postMessage",
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${c.botToken}` },
          data: { channel, text: i.text },
        });
        if (!data.ok) throw new ActionError(`Slack: ${data.error}`);
        return { sent: true, channel: data.channel, ts: data.ts };
      },
    },
    {
      name: "list_channels",
      label: "List channels",
      description: "List public Slack channels (name and ID). Use it to find a channel ID before sending a message.",
      params: {},
      run: async (c) => {
        const data = await request<{ ok: boolean; error?: string; channels?: { id: string; name: string; is_member: boolean }[] }>({
          url: "https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=200",
          headers: { Authorization: `Bearer ${c.botToken}` },
        });
        if (!data.ok) throw new ActionError(`Slack: ${data.error}`);
        return data.channels?.map((ch) => ({ id: ch.id, name: `#${ch.name}`, botIsMember: ch.is_member }));
      },
    },
  ],
  telegram: [
    {
      name: "send_message",
      label: "Send message",
      description: "Send a Telegram message to a chat the bot is in. Needs the numeric chat ID (or @channelusername for channels).",
      params: { chat_id: required("Chat ID (number as text) or @channelusername."), text: required("Message text.") },
      sends: true,
      run: async (c, i) => {
        const data = await request<{ ok: boolean; result?: { message_id: number } }>({
          url: `https://api.telegram.org/bot${c.botToken}/sendMessage`,
          method: "POST",
          headers: json,
          data: { chat_id: i.chat_id, text: i.text },
        });
        return { sent: data.ok, messageId: data.result?.message_id };
      },
    },
  ],
  discord: [
    {
      name: "send_message",
      label: "Send message",
      description: "Post a message to a Discord channel by its channel ID. The bot must have access to the channel.",
      params: { channel_id: required("Discord channel ID (a long number)."), content: required("Message text, up to 2000 characters.") },
      sends: true,
      run: async (c, i) => {
        const data = await request<{ id: string }>({
          url: `https://discord.com/api/v10/channels/${encodeURIComponent(i.channel_id)}/messages`,
          method: "POST",
          headers: { ...json, Authorization: `Bot ${c.botToken}` },
          data: { content: String(i.content).slice(0, 2000) },
        });
        return { sent: true, messageId: data.id };
      },
    },
  ],
  microsoft_teams: [
    {
      name: "post_message",
      label: "Post message",
      description: "Post a message to the Microsoft Teams channel this integration is connected to.",
      params: { text: required("Message text (Markdown allowed).") },
      sends: true,
      run: async (c, i) => {
        await request({ url: c.webhookUrl, method: "POST", headers: json, data: { text: i.text } });
        return { sent: true };
      },
    },
  ],
  twilio: [
    {
      name: "send_sms",
      label: "Send SMS",
      description: "Send a text message (SMS) to a phone number. Use international format with country code, e.g. +923001234567.",
      params: { to: required("Recipient phone number in E.164 format, e.g. +15551234567."), body: required("Message text, ideally under 160 characters.") },
      sends: true,
      run: async (c, i) => {
        const data = await request<{ sid: string; status: string }>({
          url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`,
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth(c.accountSid, c.authToken) },
          data: new URLSearchParams({ To: i.to, From: c.fromNumber, Body: i.body }).toString(),
        });
        return { sent: true, sid: data.sid, status: data.status };
      },
    },
  ],
  whatsapp: [
    {
      name: "send_message",
      label: "Send message",
      description:
        "Send a WhatsApp text message. Only works if the customer messaged this business in the last 24 hours (WhatsApp rule). Number in international format without +, e.g. 923001234567.",
      params: { to: required("Recipient WhatsApp number with country code, digits only."), text: required("Message text.") },
      sends: true,
      run: async (c, i) => {
        const data = await request<{ messages?: { id: string }[] }>({
          url: `https://graph.facebook.com/v21.0/${encodeURIComponent(c.phoneNumberId)}/messages`,
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${c.accessToken}` },
          data: { messaging_product: "whatsapp", to: String(i.to).replace(/\D/g, ""), type: "text", text: { body: i.text } },
        });
        return { sent: true, messageId: data.messages?.[0]?.id };
      },
    },
  ],

  // --- Email -----------------------------------------------------------------
  smtp: [emailAction(async (c, i) => {
    const port = Number(c.port || 587);
    const transport = nodemailer.createTransport({ host: c.host, port, secure: port === 465, auth: { user: c.username, pass: c.password } });
    await transport.sendMail({ from: c.fromAddress, to: i.to, subject: i.subject, text: i.body });
  })],
  sendgrid: [emailAction(async (c, i) => {
    await request({
      url: "https://api.sendgrid.com/v3/mail/send",
      method: "POST",
      headers: { ...json, Authorization: `Bearer ${c.apiKey}` },
      data: {
        personalizations: [{ to: [{ email: i.to }] }],
        from: { email: c.fromAddress },
        subject: i.subject,
        content: [{ type: "text/plain", value: i.body }],
      },
    });
  })],
  resend: [emailAction(async (c, i) => {
    await request({
      url: "https://api.resend.com/emails",
      method: "POST",
      headers: { ...json, Authorization: `Bearer ${c.apiKey}` },
      data: { from: c.fromAddress, to: [i.to], subject: i.subject, text: i.body },
    });
  })],
  postmark: [emailAction(async (c, i) => {
    await request({
      url: "https://api.postmarkapp.com/email",
      method: "POST",
      headers: { ...json, Accept: "application/json", "X-Postmark-Server-Token": c.serverToken },
      data: { From: c.fromAddress, To: i.to, Subject: i.subject, TextBody: i.body },
    });
  })],
  mailgun: [emailAction(async (c, i) => {
    const host = c.region?.toLowerCase() === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
    await request({
      url: `https://${host}/v3/${encodeURIComponent(c.domain)}/messages`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth("api", c.apiKey) },
      data: new URLSearchParams({ from: `postmaster@${c.domain}`, to: i.to, subject: i.subject, text: i.body }).toString(),
    });
  })],

  // --- CRM -------------------------------------------------------------------
  hubspot: [
    {
      name: "search_contacts",
      label: "Search contacts",
      description: "Find HubSpot contacts by name, email, phone or company. Returns up to 10 matches.",
      params: { query: required("Text to search for, e.g. an email address or a name.") },
      run: async (c, i) => {
        const data = await request<{ total: number; results: { id: string; properties: Record<string, string> }[] }>({
          url: "https://api.hubapi.com/crm/v3/objects/contacts/search",
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${c.privateAppToken}` },
          data: { query: i.query, limit: 10, properties: ["email", "firstname", "lastname", "phone", "company", "lifecyclestage"] },
        });
        return { total: data.total, contacts: data.results.map((r) => ({ id: r.id, ...r.properties })) };
      },
    },
    {
      name: "create_contact",
      label: "Create contact",
      description: "Create a new HubSpot contact. Search first to avoid duplicates. Email is required.",
      params: {
        email: required("Contact email address."),
        firstname: optional("First name."),
        lastname: optional("Last name."),
        phone: optional("Phone number."),
        company: optional("Company name."),
      },
      run: async (c, i) => {
        const data = await request<{ id: string }>({
          url: "https://api.hubapi.com/crm/v3/objects/contacts",
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${c.privateAppToken}` },
          data: { properties: Object.fromEntries(Object.entries(i).filter(([, v]) => v)) },
        });
        return { created: true, id: data.id };
      },
    },
  ],
  pipedrive: [
    {
      name: "search_people",
      label: "Search people",
      description: "Find people (contacts) in Pipedrive by name, email or phone.",
      params: { term: required("Search text, at least 2 characters.") },
      run: async (c, i) => {
        const data = await request<{ data?: { items: { item: { id: number; name: string; emails?: string[]; phones?: string[]; organization?: { name: string } } }[] } }>({
          url: `https://${encodeURIComponent(c.companyDomain)}.pipedrive.com/api/v1/persons/search?term=${encodeURIComponent(i.term)}&limit=10&api_token=${encodeURIComponent(c.apiToken)}`,
        });
        return (data.data?.items ?? []).map(({ item }) => ({ id: item.id, name: item.name, emails: item.emails, phones: item.phones, organization: item.organization?.name }));
      },
    },
    {
      name: "create_person",
      label: "Create person",
      description: "Add a new person (contact) to Pipedrive. Search first to avoid duplicates.",
      params: { name: required("Full name."), email: optional("Email address."), phone: optional("Phone number.") },
      run: async (c, i) => {
        const data = await request<{ data: { id: number } }>({
          url: `https://${encodeURIComponent(c.companyDomain)}.pipedrive.com/api/v1/persons?api_token=${encodeURIComponent(c.apiToken)}`,
          method: "POST",
          headers: json,
          data: { name: i.name, ...(i.email ? { email: [i.email] } : {}), ...(i.phone ? { phone: [i.phone] } : {}) },
        });
        return { created: true, id: data.data.id };
      },
    },
  ],

  // --- Support ---------------------------------------------------------------
  zendesk: [
    {
      name: "create_ticket",
      label: "Create ticket",
      description: "Open a Zendesk support ticket for a customer — use when an issue needs a human. Include a clear subject and the full details.",
      params: {
        subject: required("Short summary of the issue."),
        description: required("Full details of the request, in plain text."),
        requester_email: required("Customer's email address."),
        requester_name: optional("Customer's name."),
      },
      run: async (c, i) => {
        const data = await request<{ ticket: { id: number; status: string } }>({
          url: `https://${encodeURIComponent(c.subdomain)}.zendesk.com/api/v2/tickets.json`,
          method: "POST",
          headers: { ...json, Authorization: basicAuth(`${c.email}/token`, c.apiToken) },
          data: { ticket: { subject: i.subject, comment: { body: i.description }, requester: { email: i.requester_email, name: i.requester_name || i.requester_email } } },
        });
        return { created: true, ticketId: data.ticket.id, status: data.ticket.status };
      },
    },
    {
      name: "get_ticket",
      label: "Get ticket",
      description: "Look up a Zendesk ticket's status and details by ticket number.",
      params: { ticket_id: { type: "integer", description: "Ticket number.", required: true } },
      run: async (c, i) => {
        const data = await request<{ ticket: { id: number; subject: string; status: string; priority: string; updated_at: string } }>({
          url: `https://${encodeURIComponent(c.subdomain)}.zendesk.com/api/v2/tickets/${i.ticket_id}.json`,
          headers: { Authorization: basicAuth(`${c.email}/token`, c.apiToken) },
        });
        const t = data.ticket;
        return { id: t.id, subject: t.subject, status: t.status, priority: t.priority, updatedAt: t.updated_at };
      },
    },
  ],
  freshdesk: [
    {
      name: "create_ticket",
      label: "Create ticket",
      description: "Open a Freshdesk support ticket for a customer — use when an issue needs a human.",
      params: { subject: required("Short summary of the issue."), description: required("Full details."), email: required("Customer's email address.") },
      run: async (c, i) => {
        const data = await request<{ id: number }>({
          url: `${baseUrl(c.domain)}/api/v2/tickets`,
          method: "POST",
          headers: { ...json, Authorization: basicAuth(c.apiKey, "X") },
          data: { subject: i.subject, description: i.description, email: i.email, status: 2, priority: 1 },
        });
        return { created: true, ticketId: data.id };
      },
    },
    {
      name: "get_ticket",
      label: "Get ticket",
      description: "Look up a Freshdesk ticket by its number.",
      params: { ticket_id: { type: "integer", description: "Ticket number.", required: true } },
      run: async (c, i) => {
        const STATUS: Record<number, string> = { 2: "open", 3: "pending", 4: "resolved", 5: "closed" };
        const t = await request<{ id: number; subject: string; status: number; updated_at: string }>({
          url: `${baseUrl(c.domain)}/api/v2/tickets/${i.ticket_id}`,
          headers: { Authorization: basicAuth(c.apiKey, "X") },
        });
        return { id: t.id, subject: t.subject, status: STATUS[t.status] ?? t.status, updatedAt: t.updated_at };
      },
    },
  ],

  // --- E-commerce ------------------------------------------------------------
  shopify: [
    {
      name: "get_order",
      label: "Look up order",
      description: "Look up a Shopify order by its order number (e.g. 1001 or #1001): status, payment, fulfilment and items.",
      params: { order_number: required("Order number, with or without #.") },
      run: async (c, i) => {
        const name = `#${String(i.order_number).replace(/^#/, "")}`;
        const data = await request<{ orders: Record<string, unknown>[] }>({
          url: `${baseUrl(c.shopDomain)}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&name=${encodeURIComponent(name)}&fields=name,created_at,financial_status,fulfillment_status,total_price,currency,line_items,cancelled_at`,
          headers: { "X-Shopify-Access-Token": c.adminApiToken },
        });
        if (!data.orders.length) return `No order found with number ${name}.`;
        const o = data.orders[0] as { line_items?: { title: string; quantity: number }[] } & Record<string, unknown>;
        return { ...o, line_items: o.line_items?.map((l) => ({ title: l.title, quantity: l.quantity })) };
      },
    },
    {
      name: "search_products",
      label: "Search products",
      description: "Search the Shopify catalog by product title. Returns title, price, stock and status.",
      params: { title: required("Product title or part of it.") },
      run: async (c, i) => {
        const data = await request<{ products: { title: string; status: string; handle: string; variants: { price: string; inventory_quantity: number; title: string }[] }[] }>({
          url: `${baseUrl(c.shopDomain)}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=10&title=${encodeURIComponent(i.title)}&fields=title,status,handle,variants`,
          headers: { "X-Shopify-Access-Token": c.adminApiToken },
        });
        return data.products.map((p) => ({
          title: p.title,
          status: p.status,
          url: `${baseUrl(c.shopDomain)}/products/${p.handle}`,
          variants: p.variants.map((v) => ({ title: v.title, price: v.price, inStock: v.inventory_quantity })),
        }));
      },
    },
  ],
  woocommerce: [
    {
      name: "get_order",
      label: "Look up order",
      description: "Look up a WooCommerce order by its order number: status, total, items and shipping.",
      params: { order_id: { type: "integer", description: "Order number.", required: true } },
      run: async (c, i) => {
        const o = await request<{ id: number; status: string; total: string; currency: string; date_created: string; line_items: { name: string; quantity: number }[]; shipping: Record<string, string> }>({
          url: `${baseUrl(c.storeUrl)}/wp-json/wc/v3/orders/${i.order_id}`,
          headers: { Authorization: basicAuth(c.consumerKey, c.consumerSecret) },
        });
        return { id: o.id, status: o.status, total: `${o.total} ${o.currency}`, created: o.date_created, items: o.line_items.map((l) => ({ name: l.name, quantity: l.quantity })), shippingTo: [o.shipping.city, o.shipping.country].filter(Boolean).join(", ") };
      },
    },
    {
      name: "search_products",
      label: "Search products",
      description: "Search WooCommerce products by keyword. Returns name, price, stock status and link.",
      params: { search: required("Keyword to search for.") },
      run: async (c, i) => {
        const items = await request<{ name: string; price: string; stock_status: string; permalink: string }[]>({
          url: `${baseUrl(c.storeUrl)}/wp-json/wc/v3/products?per_page=10&search=${encodeURIComponent(i.search)}`,
          headers: { Authorization: basicAuth(c.consumerKey, c.consumerSecret) },
        });
        return items.map((p) => ({ name: p.name, price: p.price, stock: p.stock_status, url: p.permalink }));
      },
    },
  ],

  // --- Payments --------------------------------------------------------------
  stripe: [
    {
      name: "find_customer",
      label: "Find customer",
      description: "Find a Stripe customer by email and list their subscriptions (status, plan, renewal date). Read-only.",
      params: { email: required("Customer email address.") },
      run: async (c, i) => {
        const auth = { Authorization: `Bearer ${c.secretKey}` };
        const customers = await request<{ data: { id: string; name: string | null; email: string; created: number }[] }>({
          url: `https://api.stripe.com/v1/customers/search?query=${encodeURIComponent(`email:'${String(i.email).replace(/'/g, "")}'`)}&limit=3`,
          headers: auth,
        });
        return Promise.all(
          customers.data.map(async (cu) => {
            const subs = await request<{ data: { status: string; current_period_end?: number; items: { data: { price: { nickname: string | null; unit_amount: number | null; currency: string; recurring?: { interval: string } } }[] } }[] }>({
              url: `https://api.stripe.com/v1/subscriptions?customer=${cu.id}&status=all&limit=10`,
              headers: auth,
            });
            return {
              id: cu.id,
              name: cu.name,
              email: cu.email,
              subscriptions: subs.data.map((s) => ({
                status: s.status,
                renews: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString().slice(0, 10) : undefined,
                plans: s.items.data.map((it) => `${it.price.nickname ?? "plan"} ${(it.price.unit_amount ?? 0) / 100} ${it.price.currency.toUpperCase()}/${it.price.recurring?.interval ?? "one-time"}`),
              })),
            };
          }),
        );
      },
    },
  ],

  // --- Productivity ----------------------------------------------------------
  notion: [
    {
      name: "search_pages",
      label: "Search pages",
      description: "Search Notion pages and databases shared with the integration, by title. Returns titles and links.",
      params: { query: required("Words in the page title.") },
      run: async (c, i) => {
        const data = await request<{ results: { object: string; url: string; properties?: Record<string, { type: string; title?: { plain_text: string }[] }>; title?: { plain_text: string }[] }[] }>({
          url: "https://api.notion.com/v1/search",
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${c.integrationToken}`, "Notion-Version": "2022-06-28" },
          data: { query: i.query, page_size: 10 },
        });
        return data.results.map((r) => {
          const titleProp = Object.values(r.properties ?? {}).find((p) => p.type === "title");
          const title = (titleProp?.title ?? r.title ?? []).map((t) => t.plain_text).join("") || "(untitled)";
          return { type: r.object, title, url: r.url };
        });
      },
    },
  ],
  airtable: [
    {
      name: "list_records",
      label: "List records",
      description: "Read up to 20 records from an Airtable table, optionally filtered with an Airtable formula like {Status}='Open'.",
      params: {
        table: required("Table name or ID."),
        filter_formula: optional("Airtable formula to filter by, e.g. {Email}='a@b.com'."),
        base_id: optional("Base ID (app…). Leave empty to use the default base."),
      },
      run: async (c, i) => {
        const base = i.base_id || c.baseId;
        if (!base) throw new ActionError("No base ID given and no default base configured");
        const qs = new URLSearchParams({ maxRecords: "20", ...(i.filter_formula ? { filterByFormula: i.filter_formula } : {}) });
        const data = await request<{ records: { id: string; fields: Record<string, unknown> }[] }>({
          url: `https://api.airtable.com/v0/${encodeURIComponent(base)}/${encodeURIComponent(i.table)}?${qs}`,
          headers: { Authorization: `Bearer ${c.accessToken}` },
        });
        return data.records.map((r) => ({ id: r.id, ...r.fields }));
      },
    },
    {
      name: "create_record",
      label: "Create record",
      description: "Add a row to an Airtable table. fields_json is a JSON object of column name to value, e.g. {\"Name\":\"Ann\",\"Email\":\"ann@x.com\"}.",
      params: {
        table: required("Table name or ID."),
        fields_json: required("JSON object mapping column names to values."),
        base_id: optional("Base ID (app…). Leave empty to use the default base."),
      },
      run: async (c, i) => {
        const base = i.base_id || c.baseId;
        if (!base) throw new ActionError("No base ID given and no default base configured");
        let fields: unknown;
        try {
          fields = JSON.parse(i.fields_json);
        } catch {
          throw new ActionError("fields_json must be valid JSON");
        }
        const data = await request<{ id: string }>({
          url: `https://api.airtable.com/v0/${encodeURIComponent(base)}/${encodeURIComponent(i.table)}`,
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${c.accessToken}` },
          data: { fields, typecast: true },
        });
        return { created: true, id: data.id };
      },
    },
  ],
  trello: [
    {
      name: "create_card",
      label: "Create card",
      description: "Create a Trello card on a list. Needs the list ID (from the board URL/JSON).",
      params: { list_id: required("Trello list ID."), name: required("Card title."), description: optional("Card description.") },
      run: async (c, i) => {
        const qs = new URLSearchParams({ idList: i.list_id, name: i.name, desc: i.description ?? "", key: c.apiKey, token: c.token });
        const data = await request<{ id: string; shortUrl: string }>({ url: `https://api.trello.com/1/cards?${qs}`, method: "POST" });
        return { created: true, url: data.shortUrl };
      },
    },
  ],
  asana: [
    {
      name: "list_projects",
      label: "List projects",
      description: "List Asana projects (name and gid) so you can pick where to create a task.",
      params: {},
      run: async (c) => {
        const auth = { Authorization: `Bearer ${c.accessToken}` };
        const me = await request<{ data: { workspaces: { gid: string; name: string }[] } }>({ url: "https://app.asana.com/api/1.0/users/me", headers: auth });
        const out: { workspace: string; project: string; gid: string }[] = [];
        for (const ws of me.data.workspaces.slice(0, 3)) {
          const projects = await request<{ data: { gid: string; name: string }[] }>({
            url: `https://app.asana.com/api/1.0/projects?workspace=${ws.gid}&archived=false&limit=50`,
            headers: auth,
          });
          out.push(...projects.data.map((p) => ({ workspace: ws.name, project: p.name, gid: p.gid })));
        }
        return out;
      },
    },
    {
      name: "create_task",
      label: "Create task",
      description:
        "Create an Asana task. Give a project_gid (from list_projects) to put it in a project; otherwise it goes to the connected user's My Tasks.",
      params: {
        name: required("Task name."),
        notes: optional("Task description."),
        project_gid: optional("Project gid from list_projects."),
        due_on: optional("Due date as YYYY-MM-DD."),
      },
      run: async (c, i) => {
        const auth = { Authorization: `Bearer ${c.accessToken}` };
        let target: Record<string, unknown>;
        if (i.project_gid) target = { projects: [i.project_gid] };
        else {
          const me = await request<{ data: { workspaces: { gid: string }[] } }>({ url: "https://app.asana.com/api/1.0/users/me", headers: auth });
          const workspace = me.data.workspaces[0]?.gid;
          if (!workspace) throw new ActionError("The connected Asana account has no workspace");
          target = { workspace, assignee: "me" };
        }
        const data = await request<{ data: { gid: string; permalink_url: string } }>({
          url: "https://app.asana.com/api/1.0/tasks?opt_fields=permalink_url",
          method: "POST",
          headers: { ...json, ...auth },
          data: { data: { name: i.name, notes: i.notes ?? "", ...(i.due_on ? { due_on: i.due_on } : {}), ...target } },
        });
        return { created: true, gid: data.data.gid, url: data.data.permalink_url };
      },
    },
  ],
  clickup: [
    {
      name: "create_task",
      label: "Create task",
      description: "Create a ClickUp task in a list. Needs the list ID.",
      params: { list_id: required("ClickUp list ID."), name: required("Task name."), description: optional("Task description.") },
      run: async (c, i) => {
        const data = await request<{ id: string; url: string }>({
          url: `https://api.clickup.com/api/v2/list/${encodeURIComponent(i.list_id)}/task`,
          method: "POST",
          headers: { ...json, Authorization: c.apiToken },
          data: { name: i.name, description: i.description ?? "" },
        });
        return { created: true, id: data.id, url: data.url };
      },
    },
  ],

  // --- Scheduling ------------------------------------------------------------
  calendly: [
    {
      name: "get_booking_links",
      label: "Get booking links",
      description: "Get this business's Calendly booking links (meeting types with duration). Share the right link when someone wants to book a meeting.",
      params: {},
      run: async (c) => {
        const auth = { Authorization: `Bearer ${c.accessToken}` };
        const me = await request<{ resource: { uri: string } }>({ url: "https://api.calendly.com/users/me", headers: auth });
        const types = await request<{ collection: { name: string; duration: number; scheduling_url: string; active: boolean }[] }>({
          url: `https://api.calendly.com/event_types?active=true&user=${encodeURIComponent(me.resource.uri)}`,
          headers: auth,
        });
        return types.collection.map((t) => ({ name: t.name, minutes: t.duration, link: t.scheduling_url }));
      },
    },
  ],

  // --- Developer -------------------------------------------------------------
  github: [
    {
      name: "create_issue",
      label: "Create issue",
      description: "Open a GitHub issue in a repository — e.g. to report a bug a customer described.",
      params: {
        repo: required("Repository name, e.g. website (or owner/website)."),
        title: required("Issue title."),
        body: optional("Issue description (Markdown)."),
      },
      run: async (c, i) => {
        const full = String(i.repo).includes("/") ? i.repo : `${c.defaultOwner}/${i.repo}`;
        if (full.startsWith("undefined/") || full.startsWith("/")) throw new ActionError("Give the repo as owner/name, or set a default owner");
        const data = await request<{ number: number; html_url: string }>({
          url: `https://api.github.com/repos/${full}/issues`,
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          data: { title: i.title, body: i.body ?? "" },
        });
        return { created: true, number: data.number, url: data.html_url };
      },
    },
    {
      name: "search_issues",
      label: "Search issues",
      description: "Search GitHub issues and pull requests with GitHub search syntax, e.g. 'repo:acme/web is:open label:bug login'.",
      params: { query: required("GitHub search query.") },
      run: async (c, i) => {
        const data = await request<{ total_count: number; items: { number: number; title: string; state: string; html_url: string }[] }>({
          url: `https://api.github.com/search/issues?per_page=10&q=${encodeURIComponent(i.query)}`,
          headers: { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        });
        return { total: data.total_count, items: data.items.map((it) => ({ number: it.number, title: it.title, state: it.state, url: it.html_url })) };
      },
    },
  ],
  jira: [
    {
      name: "create_issue",
      label: "Create issue",
      description: "Create a Jira issue in a project (by project key, e.g. SUP).",
      params: {
        project_key: required("Jira project key, e.g. SUP."),
        summary: required("Issue title."),
        description: optional("Issue details."),
        issue_type: { type: "string", description: "Issue type.", enum: ["Task", "Bug", "Story"] },
      },
      run: async (c, i) => {
        const data = await request<{ key: string }>({
          url: `${baseUrl(c.siteUrl)}/rest/api/3/issue`,
          method: "POST",
          headers: { ...json, Authorization: basicAuth(c.email, c.apiToken) },
          data: {
            fields: {
              project: { key: i.project_key },
              summary: i.summary,
              issuetype: { name: i.issue_type || "Task" },
              ...(i.description
                ? { description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: i.description }] }] } }
                : {}),
            },
          },
        });
        return { created: true, key: data.key, url: `${baseUrl(c.siteUrl)}/browse/${data.key}` };
      },
    },
    {
      name: "search_issues",
      label: "Search issues",
      description: "Search Jira issues with JQL, e.g. project = SUP AND status != Done ORDER BY created DESC.",
      params: { jql: required("JQL query.") },
      run: async (c, i) => {
        const data = await request<{ issues: { key: string; fields: { summary: string; status: { name: string } } }[] }>({
          url: `${baseUrl(c.siteUrl)}/rest/api/3/search/jql?maxResults=10&fields=summary,status&jql=${encodeURIComponent(i.jql)}`,
          headers: { Authorization: basicAuth(c.email, c.apiToken), Accept: "application/json" },
        });
        return data.issues.map((it) => ({ key: it.key, summary: it.fields.summary, status: it.fields.status.name }));
      },
    },
  ],
  linear: [
    {
      name: "create_issue",
      label: "Create issue",
      description: "File an issue in Linear for a team (by team key, e.g. ENG).",
      params: { title: required("Issue title."), description: optional("Issue details (Markdown)."), team_key: optional("Team key, e.g. ENG. Leave empty for the default team.") },
      run: async (c, i) => {
        const gql = <T>(query: string, variables: Record<string, unknown>) =>
          request<{ data?: T; errors?: { message: string }[] }>({
            url: "https://api.linear.app/graphql",
            method: "POST",
            headers: { ...json, Authorization: c.apiKey },
            data: { query, variables },
          }).then((r) => {
            if (r.errors?.length) throw new ActionError(`Linear: ${r.errors[0].message}`);
            return r.data as T;
          });
        const key = i.team_key || c.teamKey;
        if (!key) throw new ActionError("No team key given and no default team configured");
        const teams = await gql<{ teams: { nodes: { id: string }[] } }>(
          "query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }",
          { key },
        );
        const teamId = teams.teams.nodes[0]?.id;
        if (!teamId) throw new ActionError(`No Linear team with key ${key}`);
        const created = await gql<{ issueCreate: { success: boolean; issue: { identifier: string; url: string } } }>(
          "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
          { input: { teamId, title: i.title, description: i.description ?? "" } },
        );
        return { created: created.issueCreate.success, id: created.issueCreate.issue.identifier, url: created.issueCreate.issue.url };
      },
    },
  ],

  // --- Automation ------------------------------------------------------------
  zapier: [webhookAction("Zapier", "Zap")],
  make: [webhookAction("Make", "scenario")],
  n8n: [webhookAction("n8n", "workflow")],
};

function emailAction(send: (c: Creds, i: Input) => Promise<void>): IntegrationAction {
  return {
    name: "send_email",
    label: "Send email",
    description:
      "Send a plain-text email from the business's email account. Only send when the user has clearly asked for an email to be sent, to the address they gave.",
    params: { to: required("Recipient email address (one)."), subject: required("Email subject."), body: required("Plain-text email body.") },
    sends: true,
    run: async (c, i) => {
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(i.to)) throw new ActionError("to must be a single valid email address");
      await send(c, i);
      return { sent: true, to: i.to };
    },
  };
}

function webhookAction(product: string, noun: string): IntegrationAction {
  return {
    name: "trigger",
    label: `Trigger ${noun}`,
    description: `Start the connected ${product} ${noun}, passing data to it. data_json is a JSON object with whatever the ${noun} expects, e.g. {"email":"a@b.com","plan":"pro"}.`,
    params: {
      event: required("Short name of what happened, e.g. new_lead or refund_requested."),
      data_json: optional("JSON object with the data to send."),
    },
    run: async (c, i) => {
      let data: unknown = {};
      if (i.data_json) {
        try {
          data = JSON.parse(i.data_json);
        } catch {
          throw new ActionError("data_json must be valid JSON");
        }
      }
      await request({
        url: c.webhookUrl,
        method: "POST",
        headers: { ...json, ...(c.authHeader ? { Authorization: c.authHeader } : {}) },
        data: { event: i.event, data, sentAt: new Date().toISOString() },
      });
      return { triggered: true };
    },
  };
}
