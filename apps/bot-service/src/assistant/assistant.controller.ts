import { Body, Controller, Post, Req, Res } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import type { Request, Response } from "express";
import { AssistantService, type AssistantEvent } from "./assistant.service";

const HEARTBEAT_MS = 15_000;

/**
 * The dashboard's home-page assistant. Every member can talk to it; each
 * action it takes is checked against the member's own permissions by the
 * service it calls. Always streams Server-Sent Events: started, text_delta,
 * tool_call, tool_result, done (or error). Problems before the first event
 * (no AI model, out of credits…) are ordinary HTTP errors.
 */
@Controller("businesses/current/assistant")
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post("messages")
  @RequirePermission("business:read")
  async send(
    @Req() req: Request & { businessContext: BusinessContext },
    @Res() res: Response,
    @Body() body: { message?: unknown; history?: unknown },
  ) {
    let opened = false;
    let heartbeat: NodeJS.Timeout | undefined;
    const write = (data: AssistantEvent | { type: "error"; message: string }) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const emit = (event: AssistantEvent) => {
      if (!opened) {
        opened = true;
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        heartbeat = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), HEARTBEAT_MS);
      }
      write(event);
    };

    try {
      await this.assistant.send(req.businessContext, req.headers.authorization ?? "", body ?? {}, emit);
      res.end();
    } catch (err) {
      if (!opened) throw err;
      write({ type: "error", message: (err as Error).message });
      res.end();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}
