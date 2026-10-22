import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext, WorkflowInput } from "@platform/shared-types";
import { WorkflowsService } from "./workflows.service";
import { WebhookThrottlerGuard } from "./webhook-throttler.guard";

type Ctx = { businessContext: BusinessContext };

// Business comes from the token, so the path is fixed at "current" — same
// pattern as BotsController.
@Controller("businesses/current/workflows")
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  // Declared before ":id" so it isn't captured as a workflow id.
  @Get("catalog")
  @RequirePermission("workflows:read")
  catalog(@Req() request: Ctx) {
    return this.workflows.catalog(request.businessContext.businessId);
  }

  @Get()
  @RequirePermission("workflows:read")
  list(@Req() request: Ctx) {
    return this.workflows.list(request.businessContext.businessId);
  }

  @Post()
  @RequirePermission("workflows:write")
  create(@Req() request: Ctx, @Body() body: WorkflowInput) {
    return this.workflows.create(request.businessContext.businessId, body ?? {});
  }

  @Get(":id")
  @RequirePermission("workflows:read")
  get(@Req() request: Ctx, @Param("id") id: string) {
    return this.workflows.get(request.businessContext.businessId, id);
  }

  @Patch(":id")
  @RequirePermission("workflows:write")
  update(@Req() request: Ctx, @Param("id") id: string, @Body() body: WorkflowInput) {
    return this.workflows.update(request.businessContext.businessId, id, body ?? {});
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("workflows:write")
  async remove(@Req() request: Ctx, @Param("id") id: string) {
    await this.workflows.remove(request.businessContext.businessId, id);
  }

  @Post(":id/webhook/regenerate")
  @RequirePermission("workflows:write")
  regenerateWebhook(@Req() request: Ctx, @Param("id") id: string) {
    return this.workflows.regenerateWebhook(request.businessContext.businessId, id);
  }

  /** Body: { triggerData? } — sample data the steps see as {{trigger.…}}. */
  @Post(":id/run")
  @RequirePermission("workflows:run")
  run(@Req() request: Ctx, @Param("id") id: string, @Body() body: { triggerData?: unknown }) {
    const { businessId, userId } = request.businessContext;
    return this.workflows.runNow(businessId, id, userId, body?.triggerData);
  }

  @Get(":id/runs")
  @RequirePermission("workflows:read")
  runs(@Req() request: Ctx, @Param("id") id: string, @Query("limit") limit?: string) {
    return this.workflows.listRuns(request.businessContext.businessId, id, limit);
  }

  @Get(":id/runs/:runId")
  @RequirePermission("workflows:read")
  getRun(@Req() request: Ctx, @Param("id") id: string, @Param("runId") runId: string) {
    return this.workflows.getRun(request.businessContext.businessId, id, runId);
  }
}

// Public — no JWT. The unguessable key in the path identifies the workflow,
// like the embed widget's widgetKey.
@Controller("hooks/workflows/:webhookKey")
export class WorkflowWebhookController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Post()
  @HttpCode(202)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @UseGuards(WebhookThrottlerGuard)
  trigger(@Param("webhookKey") webhookKey: string, @Body() body: unknown, @Req() request: Request) {
    return this.workflows.runFromWebhook(webhookKey, body, request.query as Record<string, unknown>);
  }
}
