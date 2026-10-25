import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequirePermission } from "@platform/shared-auth";
import type { AppInstallRequest, AppUpdateInput, BusinessContext } from "@platform/shared-types";
import { AppsService } from "./apps.service";
import { AssistantService } from "./assistant.service";
import { PublicAppThrottlerGuard } from "./public-app-throttler.guard";
import { RecordsService } from "./records.service";

type Ctx = { businessContext: BusinessContext };

/** The viewer's UTC offset in minutes (from the browser), so "today" and "this month" are theirs. */
function tzOffset(value?: string): number {
  const minutes = Number(value);
  return Number.isFinite(minutes) && Math.abs(minutes) <= 14 * 60 ? Math.round(minutes) : 0;
}

// Business comes from the token, so the path is fixed at "current" — same
// pattern as BotsController. apps:write installs and configures apps;
// apps:records adds and edits their records (agents, staff); apps:read views.
@Controller("businesses/current/apps")
export class AppsController {
  constructor(
    private readonly apps: AppsService,
    private readonly records: RecordsService,
    private readonly assistant: AssistantService,
  ) {}

  // Declared before ":id" so these aren't captured as app ids.
  @Get("catalog")
  @RequirePermission("apps:read")
  catalog() {
    return this.apps.catalog();
  }

  /** A template's dashboard and records on sample data, for the store page. */
  @Get("catalog/:key/preview")
  @RequirePermission("apps:read")
  preview(@Param("key") key: string, @Query("tz") tz?: string) {
    return this.apps.preview(key, tzOffset(tz));
  }

  /** AI App Builder. Body: { description }. Returns the best app and its setup answers; nothing is created. */
  @Post("suggest")
  @HttpCode(200)
  @RequirePermission("apps:write")
  suggest(@Req() request: Ctx, @Body() body: { description?: string }) {
    return this.apps.suggest(request.businessContext.businessId, body?.description);
  }

  @Post()
  @RequirePermission("apps:write")
  install(@Req() request: Ctx, @Body() body: AppInstallRequest) {
    return this.apps.install(request.businessContext.businessId, request.businessContext.userId, body ?? ({} as AppInstallRequest));
  }

  @Get()
  @RequirePermission("apps:read")
  list(@Req() request: Ctx) {
    return this.apps.list(request.businessContext.businessId);
  }

  @Get(":id")
  @RequirePermission("apps:read")
  get(@Req() request: Ctx, @Param("id") id: string) {
    return this.apps.get(request.businessContext.businessId, id);
  }

  @Patch(":id")
  @RequirePermission("apps:write")
  update(@Req() request: Ctx, @Param("id") id: string, @Body() body: AppUpdateInput) {
    return this.apps.update(request.businessContext.businessId, id, body ?? {});
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("apps:write")
  async remove(@Req() request: Ctx, @Param("id") id: string) {
    await this.apps.remove(request.businessContext.businessId, id);
  }

  /** Removes the example records added at install. */
  @Delete(":id/samples")
  @RequirePermission("apps:write")
  clearSamples(@Req() request: Ctx, @Param("id") id: string) {
    return this.apps.clearSamples(request.businessContext.businessId, id);
  }

  /** People records can be assigned to. */
  @Get(":id/members")
  @RequirePermission("apps:read")
  async members(@Req() request: Ctx, @Param("id") id: string) {
    await this.apps.require(request.businessContext.businessId, id);
    return this.records.members(request.businessContext.businessId);
  }

  @Get(":id/dashboard")
  @RequirePermission("apps:read")
  dashboard(@Req() request: Ctx, @Param("id") id: string, @Query("tz") tz?: string) {
    const { businessId, userId } = request.businessContext;
    return this.apps.dashboard(businessId, id, userId, tzOffset(tz));
  }

  // --- Records ------------------------------------------------------------------

  /** ?entity= or ?view= (its filters and sort), optional ?q= search. */
  @Get(":id/records")
  @RequirePermission("apps:read")
  async listRecords(@Req() request: Ctx, @Param("id") id: string, @Query() query: { entity?: string; view?: string; q?: string; tz?: string }) {
    const { businessId, userId } = request.businessContext;
    const app = await this.apps.require(businessId, id);
    return this.records.list(app, query.entity ?? "", { viewKey: query.view, q: query.q, ctx: { userId, now: new Date(), tzOffsetMinutes: tzOffset(query.tz) } });
  }

  /** Body: { entity, data }. */
  @Post(":id/records")
  @RequirePermission("apps:records")
  async createRecord(@Req() request: Ctx, @Param("id") id: string, @Body() body: { entity?: string; data?: unknown }) {
    const { businessId, userId } = request.businessContext;
    const app = await this.apps.require(businessId, id);
    return this.records.create(app, String(body?.entity ?? ""), body?.data, await this.records.actor(businessId, userId));
  }

  /** Body: { data } — only the fields that change. */
  @Patch(":id/records/:recordId")
  @RequirePermission("apps:records")
  async updateRecord(@Req() request: Ctx, @Param("id") id: string, @Param("recordId") recordId: string, @Body() body: { data?: unknown }) {
    const { businessId, userId } = request.businessContext;
    const app = await this.apps.require(businessId, id);
    return this.records.update(app, recordId, body?.data, await this.records.actor(businessId, userId));
  }

  @Delete(":id/records/:recordId")
  @HttpCode(204)
  @RequirePermission("apps:records")
  async removeRecord(@Req() request: Ctx, @Param("id") id: string, @Param("recordId") recordId: string) {
    await this.records.remove(await this.apps.require(request.businessContext.businessId, id), recordId);
  }

  @Get(":id/records/:recordId/activity")
  @RequirePermission("apps:read")
  async activity(@Req() request: Ctx, @Param("id") id: string, @Param("recordId") recordId: string) {
    return this.records.activity(await this.apps.require(request.businessContext.businessId, id), recordId);
  }

  @Post(":id/records/:recordId/comments")
  @RequirePermission("apps:records")
  async comment(@Req() request: Ctx, @Param("id") id: string, @Param("recordId") recordId: string, @Body() body: { text?: string }) {
    const { businessId, userId } = request.businessContext;
    const app = await this.apps.require(businessId, id);
    return this.records.comment(app, recordId, body?.text, await this.records.actor(businessId, userId));
  }

  // --- AI helpers -----------------------------------------------------------------

  /** Body: { question, tz }. */
  @Post(":id/ai/ask")
  @HttpCode(200)
  @RequirePermission("apps:read")
  async ask(@Req() request: Ctx, @Param("id") id: string, @Body() body: { question?: string; tz?: string }) {
    const { businessId, userId } = request.businessContext;
    return this.assistant.ask(await this.apps.require(businessId, id), body?.question, userId, tzOffset(body?.tz));
  }

  /** Body: { entity, field, data } -> { value } for a choice field. */
  @Post(":id/ai/suggest")
  @HttpCode(200)
  @RequirePermission("apps:records")
  async suggestValue(@Req() request: Ctx, @Param("id") id: string, @Body() body: { entity?: string; field?: string; data?: unknown }) {
    return this.assistant.suggest(await this.apps.require(request.businessContext.businessId, id), body?.entity, body?.field, body?.data);
  }

  @Post(":id/records/:recordId/ai/:action")
  @HttpCode(200)
  @RequirePermission("apps:records")
  async recordAction(@Req() request: Ctx, @Param("id") id: string, @Param("recordId") recordId: string, @Param("action") action: string) {
    return this.assistant.action(await this.apps.require(request.businessContext.businessId, id), recordId, action);
  }
}

// Public — no JWT. An app's public forms at /a/<slug>; only live apps answer.
@Controller("public/apps/:slug")
@UseGuards(PublicAppThrottlerGuard)
export class PublicAppsController {
  constructor(private readonly apps: AppsService) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  profile(@Param("slug") slug: string) {
    return this.apps.publicProfile(slug);
  }

  @Post("forms/:formKey")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(@Param("slug") slug: string, @Param("formKey") formKey: string, @Body() body: { data?: unknown }) {
    return this.apps.publicSubmit(slug, formKey, body?.data);
  }
}
