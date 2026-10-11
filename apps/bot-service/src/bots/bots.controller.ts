import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import type { Request } from "express";
import { BotsService } from "./bots.service";

interface CreateBotBody {
  name?: string;
  systemPrompt?: string;
  knowledgeBaseIds?: string[];
  mcpServerIds?: string[];
  model?: string;
  integrations?: string[];
}

interface UpdateBotBody {
  name?: string;
  systemPrompt?: string;
  knowledgeBaseIds?: string[];
  mcpServerIds?: string[];
  model?: string;
  integrations?: string[];
}

interface SendMessageBody {
  message?: string;
}

interface UpdateWidgetSettingsBody {
  enabled?: boolean;
  allowedOrigins?: string[];
}

// Business comes from the token, so the path is fixed at "current" — same
// pattern as identity-service's members/invitations controllers.
@Controller("businesses/current/bots")
export class BotsController {
  constructor(private readonly botsService: BotsService) {}

  @Post()
  @RequirePermission("bots:write")
  async create(@Req() request: { businessContext: BusinessContext }, @Body() body: CreateBotBody) {
    return this.botsService.create(
      request.businessContext.businessId,
      body.name ?? "",
      body.systemPrompt ?? "",
      body.knowledgeBaseIds ?? [],
      body.mcpServerIds ?? [],
      body.model,
      body.integrations ?? [],
    );
  }

  @Get()
  @RequirePermission("bots:read")
  async list(@Req() request: { businessContext: BusinessContext }) {
    return this.botsService.list(request.businessContext.businessId);
  }

  @Get(":id")
  @RequirePermission("bots:read")
  async get(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    return this.botsService.get(request.businessContext.businessId, id);
  }

  @Patch(":id")
  @RequirePermission("bots:write")
  async update(
    @Req() request: { businessContext: BusinessContext },
    @Param("id") id: string,
    @Body() body: UpdateBotBody,
  ) {
    return this.botsService.update(request.businessContext.businessId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("bots:write")
  async remove(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    await this.botsService.remove(request.businessContext.businessId, id);
  }

  // The playground chat endpoint: one stateless question in, one recommendation out.
  @Post(":id/messages")
  @RequirePermission("bots:run")
  async sendMessage(
    @Req() request: Request & { businessContext: BusinessContext },
    @Param("id") id: string,
    @Body() body: SendMessageBody,
  ) {
    return this.botsService.sendMessage(
      request.businessContext.businessId,
      id,
      body.message ?? "",
      request.headers.authorization,
    );
  }

  // Widget settings are gated the same as create/update/delete — regenerating
  // the key or flipping the origin allowlist is an owner/admin-level action.
  @Get(":id/widget")
  @RequirePermission("bots:write")
  async getWidgetSettings(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    return this.botsService.getWidgetSettings(request.businessContext.businessId, id);
  }

  @Patch(":id/widget")
  @RequirePermission("bots:write")
  async updateWidgetSettings(
    @Req() request: { businessContext: BusinessContext },
    @Param("id") id: string,
    @Body() body: UpdateWidgetSettingsBody,
  ) {
    return this.botsService.updateWidgetSettings(request.businessContext.businessId, id, body);
  }

  @Post(":id/widget/regenerate-key")
  @RequirePermission("bots:write")
  async regenerateWidgetKey(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    return this.botsService.regenerateWidgetKey(request.businessContext.businessId, id);
  }
}
