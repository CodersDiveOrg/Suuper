import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { BotsService, type BotRow } from "./bots.service";

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Guards the public embed widget route. There's no JWT here — the widgetKey in
 * the path stands in for auth, scoped down further by an Origin allowlist so a
 * leaked key can't be replayed from an arbitrary site.
 */
@Injectable()
export class WidgetKeyGuard implements CanActivate {
  constructor(private readonly botsService: BotsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const widgetKey = request.params.widgetKey;

    const bot = await this.botsService.findByWidgetKey(widgetKey);
    if (!bot) throw new NotFoundException("Widget not found");
    if (!bot.widgetEnabled) throw new ForbiddenException("Widget is disabled");

    const origin = request.headers.origin;
    const allowed = new Set(bot.allowedOrigins.map(normalizeOrigin));
    if (!origin || !allowed.has(normalizeOrigin(origin))) {
      throw new ForbiddenException("Origin not allowed");
    }

    (request as Request & { widgetBot: BotRow }).widgetBot = bot;
    return true;
  }
}
