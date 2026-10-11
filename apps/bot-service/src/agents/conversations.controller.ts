import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import type { Request, Response } from "express";
import { prisma } from "@platform/database";
import { ConversationsService } from "./conversations.service";
import type { RunEvent } from "./runtime/agent-runner";

type Ctx = { businessContext: BusinessContext };

const HEARTBEAT_MS = 15_000;

// Conversations are private to the member who started them.
@Controller("businesses/current/agents/:agentId/conversations")
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @RequirePermission("agents:run")
  async list(@Req() req: Ctx, @Param("agentId") agentId: string) {
    const { businessId, userId } = req.businessContext;
    return this.conversations.list(businessId, agentId, userId);
  }

  @Post()
  @RequirePermission("agents:run")
  async create(@Req() req: Ctx, @Param("agentId") agentId: string, @Body() body: { title?: string }) {
    const { businessId, userId } = req.businessContext;
    return this.conversations.create(businessId, agentId, userId, body?.title);
  }

  @Get(":conversationId")
  @RequirePermission("agents:run")
  async get(@Req() req: Ctx, @Param("agentId") agentId: string, @Param("conversationId") id: string) {
    const { businessId, userId } = req.businessContext;
    return this.conversations.get(businessId, agentId, userId, id);
  }

  @Patch(":conversationId")
  @RequirePermission("agents:run")
  async rename(
    @Req() req: Ctx,
    @Param("agentId") agentId: string,
    @Param("conversationId") id: string,
    @Body() body: { title?: unknown },
  ) {
    const { businessId, userId } = req.businessContext;
    return this.conversations.rename(businessId, agentId, userId, id, body?.title);
  }

  @Delete(":conversationId")
  @HttpCode(204)
  @RequirePermission("agents:run")
  async remove(@Req() req: Ctx, @Param("agentId") agentId: string, @Param("conversationId") id: string) {
    const { businessId, userId } = req.businessContext;
    await this.conversations.remove(businessId, agentId, userId, id);
  }

  /**
   * Send a message and run the agent. With `Accept: text/event-stream` the run
   * streams as SSE (run_started, text_delta, tool_call, tool_result,
   * run_finished); otherwise the finished run is returned as JSON. Validation
   * failures (409 busy, missing API key…) are normal HTTP errors in both modes,
   * because the stream only opens on the first event.
   */
  @Post(":conversationId/messages")
  @RequirePermission("agents:run")
  async send(
    @Req() req: Request & Ctx,
    @Res() res: Response,
    @Param("agentId") agentId: string,
    @Param("conversationId") id: string,
    @Body() body: { message?: unknown },
  ) {
    const { businessId, userId } = req.businessContext;
    const streaming = (req.headers.accept ?? "").includes("text/event-stream");
    let opened = false;
    let heartbeat: NodeJS.Timeout | undefined;

    const write = (event: string, data: unknown) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const emit = (event: RunEvent) => {
      if (!streaming) return;
      if (!opened) {
        opened = true;
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        // Comment lines keep idle proxies from closing the connection during long tool calls.
        heartbeat = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), HEARTBEAT_MS);
      }
      write(event.type, event);
    };

    try {
      const runId = await this.conversations.sendMessage(businessId, agentId, userId, id, body?.message, emit);
      if (streaming) {
        res.end();
      } else {
        const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
        res.json({ runId, conversationId: id, status: run.status, output: run.output, error: run.error ?? undefined });
      }
    } catch (err) {
      // Before the stream opened this is an ordinary HTTP error (Nest's filter handles it).
      if (!opened) throw err;
      write("error", { type: "error", message: (err as Error).message });
      res.end();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}
