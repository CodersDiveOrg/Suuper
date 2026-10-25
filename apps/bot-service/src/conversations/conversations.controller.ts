import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { ConversationsService, type ListConversationsQuery } from "./conversations.service";

// The bots' conversation inbox: every widget, playground, WhatsApp and Telegram chat.
@Controller("businesses/current/conversations")
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @RequirePermission("bots:read")
  list(@Req() request: { businessContext: BusinessContext }, @Query() query: ListConversationsQuery) {
    return this.conversations.list(request.businessContext.businessId, query);
  }

  @Get(":id")
  @RequirePermission("bots:read")
  get(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    return this.conversations.get(request.businessContext.businessId, id);
  }

  // Answering customers is day-to-day work, so members (bots:run) can do it.
  @Post(":id/reply")
  @RequirePermission("bots:run")
  reply(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string, @Body() body: { text?: unknown }) {
    return this.conversations.reply(request.businessContext.businessId, id, body.text);
  }

  @Post(":id/takeover")
  @RequirePermission("bots:run")
  takeover(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string, @Body() body: { active?: unknown }) {
    return this.conversations.setTakeover(request.businessContext.businessId, id, body.active);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("bots:write")
  async remove(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    await this.conversations.remove(request.businessContext.businessId, id);
  }
}
