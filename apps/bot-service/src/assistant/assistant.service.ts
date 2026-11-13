import { BadRequestException, Injectable } from "@nestjs/common";
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@platform/database";
import type { BusinessContext } from "@platform/shared-types";
import { defaultModelFor, findModel, ollamaReachable, type AgentModel } from "../agents/runtime/models";
import { createProvider } from "../agents/runtime/providers";
import type { ContentBlockParam, MessageParam } from "../agents/runtime/providers/types";
import { withUsage } from "../usage/meter";
import { assertWithinQuota, creditMetersFor } from "../usage/quota";
import { ASSISTANT_TOOLS, TOOL_LABELS, executeAssistantTool, type AssistantLink } from "./assistant-tools";

const MAX_STEPS = 12;
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 8_000;
const LOCAL_FALLBACK = "llama3.2:3b";

export type AssistantEvent =
  | { type: "started"; model: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; name: string; label: string }
  | { type: "tool_result"; name: string; ok: boolean; error?: string; link?: AssistantLink }
  | { type: "done"; reply: string; transcript: string; links: AssistantLink[] };

export interface AssistantHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

function systemPrompt(ctx: BusinessContext, businessName: string) {
  return [
    `You are the Suuper assistant inside the Suuper dashboard for the business "${businessName}".`,
    "Suuper lets businesses build customer-facing chat bots (website widget, WhatsApp, Telegram), internal AI agents, knowledge bases (crawled websites or uploaded documents), workflows (automations with a trigger and steps), apps and MCP servers.",
    "",
    "You DO things in the workspace with your tools rather than explaining how to click through the UI:",
    "- When the request is clear enough, act. Call get_workspace first to reuse what exists and avoid duplicates.",
    "- Fill in sensible defaults yourself (names, bot instructions, prompts). Only ask a question when something essential is missing and can't be guessed, such as a website URL or an email address; ask everything you need in one short message.",
    "- Chain tools: e.g. create a knowledge base from the store URL, then a bot that uses it.",
    "- Workflows are created disabled; tell the user to review and turn them on.",
    "- For things only a person can do (connecting an integration account, adding an AI key, uploading documents, billing, adding an MCP server), explain the steps briefly and call show_page with the right page.",
    "- If a tool fails, say what went wrong in plain words and what the user can do.",
    "- If the request isn't about Suuper, answer briefly and steer back to what you can set up.",
    "",
    "After acting, reply in a few short sentences: what you created or changed and the next step. Don't paste ids or JSON. Use plain text or simple Markdown.",
    "",
    `The member's role is "${ctx.role}". Their permissions: ${ctx.permissions.join(", ") || "none"}. Don't attempt actions they lack permission for; tell them who can do it.`,
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
  ].join("\n");
}

function cleanHistory(raw: unknown): AssistantHistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m): m is AssistantHistoryMessage =>
        !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim() !== "",
    )
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

@Injectable()
export class AssistantService {
  private async pickModel(businessId: string): Promise<AgentModel> {
    const cloud = await defaultModelFor(businessId, "capable");
    if (cloud) return cloud;
    const local = findModel(LOCAL_FALLBACK);
    if (local && (await ollamaReachable())) return local;
    throw new BadRequestException("The assistant needs an AI model. Add an API key under Settings → AI Models.");
  }

  async send(
    ctx: BusinessContext,
    authorization: string,
    body: { message?: unknown; history?: unknown },
    emit: (event: AssistantEvent) => void,
  ) {
    const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE_CHARS) : "";
    if (!message) throw new BadRequestException("message is required");

    const business = await prisma.business.findUnique({ where: { id: ctx.businessId }, select: { name: true } });
    const model = await this.pickModel(ctx.businessId);
    await assertWithinQuota(ctx.businessId, await creditMetersFor(ctx.businessId, model.id));
    const provider = await createProvider(ctx.businessId, model);

    const messages: MessageParam[] = [
      ...cleanHistory(body.history).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ];
    // Providers need the conversation to start with the user.
    while (messages.length && messages[0].role !== "user") messages.shift();

    const system = systemPrompt(ctx, business?.name ?? "this business");
    const links: AssistantLink[] = [];
    const actionNotes: string[] = [];
    let reply = "";

    emit({ type: "started", model: model.label });

    await withUsage(ctx.businessId, "agent", async () => {
      for (let step = 0; step < MAX_STEPS; step++) {
        const turn = await provider.runTurn(
          { model: model.id, system, messages, tools: ASSISTANT_TOOLS, serverTools: [] },
          (text) => emit({ type: "text_delta", text }),
        );
        const text = turn.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        if (text) reply = reply ? `${reply}\n\n${text}` : text;
        if (turn.content.length) messages.push({ role: "assistant", content: turn.content });
        if (turn.stopReason === "refusal") break;
        if (turn.stopReason === "pause_turn") continue;

        const uses = turn.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use");
        if (turn.stopReason === "max_tokens" && uses.length) break;
        if (uses.length === 0) break;

        // Writes run one at a time, in order: a later call often needs an earlier one's id.
        const results: ContentBlockParam[] = [];
        for (const use of uses) {
          emit({ type: "tool_call", name: use.name, label: TOOL_LABELS[use.name] ?? use.name });
          const result = await executeAssistantTool(authorization, use.name, use.input);
          if (result.link) links.push(result.link);
          if (!result.isError && use.name.startsWith("create_")) actionNotes.push(`${use.name}: ${result.content}`);
          if (!result.isError && use.name === "invite_member") actionNotes.push(`invite_member: ${result.content}`);
          emit({
            type: "tool_result",
            name: use.name,
            ok: !result.isError,
            error: result.isError ? result.content : undefined,
            link: result.link,
          });
          results.push({ type: "tool_result", tool_use_id: use.id, content: result.content, is_error: result.isError || undefined });
        }
        messages.push({ role: "user", content: results });
      }
    });

    if (!reply) reply = links.length ? "Done." : "I couldn't finish that. Try rephrasing, or tell me a bit more.";
    // What the browser sends back as this turn's history: the reply plus the
    // ids of anything created, so follow-ups ("add it to the bot") can use them.
    const transcript = actionNotes.length ? `${reply}\n\n[Actions taken: ${actionNotes.join("; ")}]` : reply;
    emit({ type: "done", reply, transcript, links });
  }
}
