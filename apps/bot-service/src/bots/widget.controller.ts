import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { BotsService, type BotRow } from "./bots.service";
import { WidgetKeyGuard } from "./widget-key.guard";
import { WidgetThrottlerGuard } from "./widget-throttler.guard";

interface WidgetMessageBody {
  message?: string;
}

// Public — no JWT. WidgetKeyGuard resolves + authorizes the bot from the path;
// this can't share BotsController's businesses/current prefix because there is
// no business-scoped token to derive that prefix from.
@Controller("public/widget/:widgetKey")
export class WidgetController {
  constructor(private readonly botsService: BotsService) {}

  @Post("messages")
  @UseGuards(WidgetThrottlerGuard, WidgetKeyGuard)
  async sendMessage(@Req() request: Request & { widgetBot: BotRow }, @Body() body: WidgetMessageBody) {
    return this.botsService.sendPublicMessage(request.widgetBot, body.message ?? "");
  }
}
