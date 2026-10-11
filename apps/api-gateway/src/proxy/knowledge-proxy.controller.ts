import { All, Controller, Req } from "@nestjs/common";
import type { Request } from "express";
import { loadServiceConfig } from "@platform/shared-config";
import { forwardTo } from "./forward";

const knowledgeServiceUrl = loadServiceConfig("api-gateway", 3010).knowledgeServiceUrl;

// Registered before BusinessesProxyController (see app.module.ts) so this
// more specific path wins over the generic "businesses/*" forward.
@Controller("businesses/current/knowledge-bases")
export class KnowledgeBasesProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(knowledgeServiceUrl, req);
  }
}
