import { All, Controller, Req } from "@nestjs/common";
import type { Request } from "express";
import { loadServiceConfig } from "@platform/shared-config";
import { forwardTo } from "./forward";

const identityServiceUrl = loadServiceConfig("api-gateway", 3010).identityServiceUrl;

// Forwards the identity surface (auth, businesses, invitations) to
// identity-service unchanged. "businesses/current/knowledge-bases" and
// "businesses/current/bots" are more specific controllers registered before
// this one (see app.module.ts) so they win the route instead.
//
// Both "" and "*" are listed: "*" alone only matches a sub-path (e.g.
// /businesses/current), not the controller's bare base path (e.g. bare
// GET/POST /businesses), which Express's path-to-regexp treats as distinct.
@Controller("auth")
export class AuthProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(identityServiceUrl, req);
  }
}

@Controller("businesses")
export class BusinessesProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(identityServiceUrl, req);
  }
}

@Controller("invitations")
export class InvitationsProxyController {
  @All(["", "*"])
  handle(@Req() req: Request) {
    return forwardTo(identityServiceUrl, req);
  }
}
