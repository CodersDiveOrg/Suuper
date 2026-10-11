import { All, Controller, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { loadServiceConfig } from "@platform/shared-config";
import { forwardTo, streamTo } from "./forward";

// Agents live in bot-service alongside Bots — same target service.
const botServiceUrl = loadServiceConfig("api-gateway", 3010).botServiceUrl;

// Sending a message can stream (SSE), so it's piped rather than buffered.
// Registered before AgentsProxyController so this route wins.
@Controller("businesses/current/agents/:agentId/conversations/:conversationId/messages")
export class AgentMessagesStreamProxyController {
  @Post()
  handle(@Req() req: Request, @Res() res: Response) {
    return streamTo(botServiceUrl, req, res);
  }
}

@Controller("businesses/current/agent-runs")
export class AgentRunsProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}

// Registered before BusinessesProxyController (see app.module.ts) so this
// more specific path wins over the generic "businesses/*" forward.
@Controller("businesses/current/agents")
export class AgentsProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(botServiceUrl, req);
  }
}
