import axios from "axios";
import { loadServiceConfig } from "@platform/shared-config";
import type { ClientTool } from "../agents/runtime/providers/types";

const config = loadServiceConfig("bot-service", 3002);

/** A link the web app shows under the assistant's reply ("Open bot", "Go to Integrations"…). */
export interface AssistantLink {
  label: string;
  href: string;
}

export interface AssistantToolResult {
  /** What goes back to the model. */
  content: string;
  isError?: boolean;
  /** Shown to the user as a button. */
  link?: AssistantLink;
}

// The assistant acts as the signed-in member: every call goes to the same
// service endpoint the dashboard uses, with the member's own token, so the
// service's validation and permission checks apply exactly as in the UI.
async function call(
  serviceUrl: string,
  authorization: string,
  method: "GET" | "POST",
  path: string,
  data?: unknown,
): Promise<{ ok: true; data: any } | { ok: false; message: string }> {
  try {
    const response = await axios.request({
      method,
      url: `${serviceUrl}${path}`,
      data,
      headers: { Authorization: authorization },
      timeout: 30_000,
      validateStatus: () => true,
    });
    if (response.status >= 400) {
      const message = (response.data as { message?: string | string[] } | undefined)?.message;
      const text = Array.isArray(message) ? message.join(", ") : message;
      if (response.status === 403) return { ok: false, message: `Not allowed: ${text ?? "the member's role doesn't permit this"}` };
      return { ok: false, message: text ?? `Request failed (${response.status})` };
    }
    return { ok: true, data: response.data };
  } catch (err) {
    return { ok: false, message: `Service unavailable: ${(err as Error).message}` };
  }
}

const json = (value: unknown) => JSON.stringify(value);

export const ASSISTANT_TOOLS: ClientTool[] = [
  {
    name: "get_workspace",
    description:
      "List what already exists in this business: bots, agents, knowledge bases, workflows and MCP servers (ids and names). Call this before creating things, to reuse existing items and avoid duplicates.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_knowledge_base",
    description:
      "Create a knowledge base that crawls a website (e.g. a store or docs site) and indexes its pages so bots and agents can answer from it. Crawling runs in the background.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name, e.g. 'Store catalog'." },
        sourceUrl: { type: "string", description: "Full http(s) URL to crawl." },
      },
      required: ["name", "sourceUrl"],
    },
  },
  {
    name: "create_bot",
    description:
      "Create a customer-facing chat bot (website widget, WhatsApp, Telegram). Bots answer customers from knowledge bases.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        systemPrompt: { type: "string", description: "Instructions: who the bot is, tone, what it should and shouldn't do." },
        knowledgeBaseIds: { type: "array", items: { type: "string" }, description: "Ids from get_workspace or create_knowledge_base." },
      },
      required: ["name", "systemPrompt"],
    },
  },
  {
    name: "create_agent",
    description:
      "Create an internal AI agent that team members chat with to do multi-step work (research, drafting, using integrations).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string", description: "One line on what it's for." },
        systemPrompt: { type: "string", description: "Instructions for the agent." },
        knowledgeBaseIds: { type: "array", items: { type: "string" } },
      },
      required: ["name", "systemPrompt"],
    },
  },
  {
    name: "get_workflow_catalog",
    description:
      "List the integration actions and AI models workflow steps can use, and which integrations are connected. Call before create_workflow when it needs 'action' steps.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_workflow",
    description: [
      "Create an automation: one trigger and ordered steps. Placeholders like {{trigger.field}} and {{steps.<stepId>.field}} reference earlier data.",
      'trigger: {"type":"manual"} | {"type":"webhook"} | {"type":"schedule","frequency":"minutes"|"hourly"|"daily"|"weekly","intervalMinutes"?:5|10|15|30,"time"?:"HH:MM","dayOfWeek"?:0-6,"timezone":"Asia/Karachi"}.',
      'steps (each needs a unique short id like "s1"):',
      '{"id","type":"ai","name"?,"prompt","model"?,"knowledgeBaseIds"?}',
      '{"id","type":"action","name"?,"provider","action","inputs":{...strings}} (provider/action from get_workflow_catalog)',
      '{"id","type":"http","name"?,"method":"GET"|"POST"|"PUT"|"PATCH"|"DELETE","url","headers"?,"body"?}',
      '{"id","type":"condition","name"?,"left","operator":"equals"|"not_equals"|"contains"|"not_contains"|"is_empty"|"is_not_empty"|"greater_than"|"less_than","right"?} (stops the run when false).',
      "The workflow is created disabled; the user turns it on after reviewing it.",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        trigger: { type: "object" },
        steps: { type: "array", items: { type: "object" } },
      },
      required: ["name", "trigger", "steps"],
    },
  },
  {
    name: "invite_member",
    description: "Invite someone to this business by email at a role (admin, member or viewer). They get an email with a link.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string" },
        role: { type: "string", enum: ["admin", "member", "viewer"] },
      },
      required: ["email", "role"],
    },
  },
  {
    name: "show_page",
    description:
      "Show the user a button to a dashboard page, for things done by hand (connecting an integration's account, adding an MCP server, adding an AI key, billing, uploading documents). Paths: /dashboard/bots, /dashboard/bots/channels, /dashboard/bots/widgets, /dashboard/bots/conversations, /dashboard/knowledge-bases, /dashboard/knowledge-bases/documents, /dashboard/agents, /dashboard/agents/templates, /dashboard/workflows, /dashboard/mcp-servers, /dashboard/integrations, /dashboard/apps, /dashboard/settings/members, /dashboard/settings/ai-models, /dashboard/usage.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Button text, e.g. 'Connect Gmail'." },
        path: { type: "string", description: "A path from the list above." },
      },
      required: ["label", "path"],
    },
  },
];

/** Friendly label for the "working…" line the web app shows while a tool runs. */
export const TOOL_LABELS: Record<string, string> = {
  get_workspace: "Looking at your workspace",
  create_knowledge_base: "Creating knowledge base",
  create_bot: "Creating bot",
  create_agent: "Creating agent",
  get_workflow_catalog: "Checking available actions",
  create_workflow: "Building workflow",
  invite_member: "Sending invitation",
  show_page: "Preparing link",
};

export async function executeAssistantTool(
  authorization: string,
  name: string,
  rawInput: unknown,
): Promise<AssistantToolResult> {
  const input = (rawInput ?? {}) as Record<string, any>;
  const fail = (message: string): AssistantToolResult => ({ content: message, isError: true });

  switch (name) {
    case "get_workspace": {
      const [bots, agents, kbs, workflows, mcp] = await Promise.all([
        call(config.botServiceUrl, authorization, "GET", "/businesses/current/bots"),
        call(config.botServiceUrl, authorization, "GET", "/businesses/current/agents"),
        call(config.knowledgeServiceUrl, authorization, "GET", "/businesses/current/knowledge-bases"),
        call(config.botServiceUrl, authorization, "GET", "/businesses/current/workflows"),
        call(config.mcpGatewayUrl, authorization, "GET", "/businesses/current/mcp-servers"),
      ]);
      const pick = (r: Awaited<ReturnType<typeof call>>, fields: string[]) => {
        if (!r.ok) return { unavailable: r.message };
        const rows: any[] = Array.isArray(r.data) ? r.data : (r.data?.items ?? []);
        return rows.map((row) => Object.fromEntries(fields.filter((f) => row[f] !== undefined).map((f) => [f, row[f]])));
      };
      return {
        content: json({
          bots: pick(bots, ["id", "name", "knowledgeBaseIds"]),
          agents: pick(agents, ["id", "name", "description"]),
          knowledgeBases: pick(kbs, ["id", "name", "sourceUrl", "status"]),
          workflows: pick(workflows, ["id", "name", "enabled"]),
          mcpServers: pick(mcp, ["id", "name"]),
        }),
      };
    }

    case "create_knowledge_base": {
      const r = await call(config.knowledgeServiceUrl, authorization, "POST", "/businesses/current/knowledge-bases", {
        name: input.name,
        sourceType: "crawl",
        sourceUrl: input.sourceUrl,
      });
      if (!r.ok) return fail(r.message);
      return {
        content: json({ created: true, id: r.data.id, name: r.data.name, note: "Crawling started in the background." }),
        link: { label: `Open ${r.data.name ?? "knowledge base"}`, href: "/dashboard/knowledge-bases" },
      };
    }

    case "create_bot": {
      const r = await call(config.botServiceUrl, authorization, "POST", "/businesses/current/bots", {
        name: input.name,
        systemPrompt: input.systemPrompt,
        knowledgeBaseIds: Array.isArray(input.knowledgeBaseIds) ? input.knowledgeBaseIds : [],
      });
      if (!r.ok) return fail(r.message);
      return {
        content: json({ created: true, id: r.data.id, name: r.data.name }),
        link: { label: `Open ${r.data.name ?? "bot"}`, href: "/dashboard/bots" },
      };
    }

    case "create_agent": {
      const r = await call(config.botServiceUrl, authorization, "POST", "/businesses/current/agents", {
        name: input.name,
        description: input.description,
        systemPrompt: input.systemPrompt,
        knowledgeBaseIds: Array.isArray(input.knowledgeBaseIds) ? input.knowledgeBaseIds : [],
      });
      if (!r.ok) return fail(r.message);
      return {
        content: json({ created: true, id: r.data.id, name: r.data.name }),
        link: { label: `Open ${r.data.name ?? "agent"}`, href: `/dashboard/agents/${r.data.id}` },
      };
    }

    case "get_workflow_catalog": {
      const r = await call(config.botServiceUrl, authorization, "GET", "/businesses/current/workflows/catalog");
      if (!r.ok) return fail(r.message);
      return { content: json(r.data).slice(0, 30_000) };
    }

    case "create_workflow": {
      const r = await call(config.botServiceUrl, authorization, "POST", "/businesses/current/workflows", {
        name: input.name,
        description: input.description,
        enabled: false,
        trigger: input.trigger,
        steps: input.steps,
      });
      if (!r.ok) return fail(r.message);
      return {
        content: json({ created: true, id: r.data.id, name: r.data.name, enabled: false }),
        link: { label: `Review ${r.data.name ?? "workflow"}`, href: `/dashboard/workflows/${r.data.id}` },
      };
    }

    case "invite_member": {
      const r = await call(config.identityServiceUrl, authorization, "POST", "/businesses/current/invitations", {
        email: input.email,
        role: input.role,
      });
      if (!r.ok) return fail(r.message);
      return {
        content: json({ invited: true, email: input.email, role: input.role, emailSent: r.data?.emailSent }),
        link: { label: "See members", href: "/dashboard/settings/members" },
      };
    }

    case "show_page": {
      const path = String(input.path ?? "");
      if (!path.startsWith("/dashboard")) return fail("path must start with /dashboard");
      return { content: json({ shown: true }), link: { label: String(input.label ?? "Open"), href: path } };
    }

    default:
      return fail(`Unknown tool ${name}`);
  }
}
