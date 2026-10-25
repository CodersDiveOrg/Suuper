import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Put, Query, Req, UseGuards, type RawBodyRequest } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import type { Request } from "express";
import { ChannelsService } from "./channels.service";
import { ChannelWebhookThrottlerGuard } from "./channel-webhook-throttler.guard";

interface SaveChannelBody {
  botId?: string;
  enabled?: boolean;
}

// Not under businesses/current/bots: BotsController's ":id" routes would catch it.
@Controller("businesses/current/channels")
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @RequirePermission("bots:read")
  list(@Req() request: { businessContext: BusinessContext }) {
    return this.channels.list(request.businessContext.businessId);
  }

  @Put(":provider")
  @RequirePermission("bots:write")
  save(@Req() request: { businessContext: BusinessContext }, @Param("provider") provider: string, @Body() body: SaveChannelBody) {
    return this.channels.save(request.businessContext.businessId, provider, body);
  }

  @Delete(":provider")
  @HttpCode(204)
  @RequirePermission("bots:write")
  async remove(@Req() request: { businessContext: BusinessContext }, @Param("provider") provider: string) {
    await this.channels.remove(request.businessContext.businessId, provider);
  }

  @Get(":provider/messages")
  @RequirePermission("bots:read")
  messages(
    @Req() request: { businessContext: BusinessContext },
    @Param("provider") provider: string,
    @Query("limit") limit?: string,
  ) {
    return this.channels.messages(request.businessContext.businessId, provider, Number(limit) || 50);
  }
}

// Public — called by WhatsApp/Telegram. The key in the path picks the channel;
// each provider's own check (signature / secret token) proves the sender.
@Controller("hooks/channels/:webhookKey")
@UseGuards(ChannelWebhookThrottlerGuard)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class ChannelWebhookController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @Header("Content-Type", "text/plain")
  verify(@Param("webhookKey") webhookKey: string, @Query() query: Record<string, unknown>) {
    return this.channels.verify(webhookKey, query);
  }

  @Post()
  @HttpCode(200)
  receive(@Param("webhookKey") webhookKey: string, @Body() body: unknown, @Req() request: RawBodyRequest<Request>) {
    return this.channels.receive(webhookKey, body, request.headers as Record<string, string | undefined>, request.rawBody);
  }
}
