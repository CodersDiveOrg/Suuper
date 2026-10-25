import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { AiModelsService } from "./ai-models.service";

type Ctx = { businessContext: BusinessContext };

// Keys are stored as integration connections, so the same permissions apply as on Integrations.
@Controller("businesses/current/ai-models")
export class AiModelsController {
  constructor(private readonly aiModels: AiModelsService) {}

  @Get()
  @RequirePermission("integrations:read")
  overview(@Req() req: Ctx) {
    return this.aiModels.overview(req.businessContext.businessId);
  }

  @Put("providers/:provider")
  @RequirePermission("integrations:write")
  saveKey(@Req() req: Ctx, @Param("provider") provider: string, @Body() body: { apiKey?: unknown }) {
    return this.aiModels.saveKey(req.businessContext, provider, body?.apiKey);
  }

  @Delete("providers/:provider")
  @RequirePermission("integrations:write")
  removeKey(@Req() req: Ctx, @Param("provider") provider: string) {
    return this.aiModels.removeKey(req.businessContext.businessId, provider);
  }

  @Post("providers/:provider/test")
  @HttpCode(200)
  @RequirePermission("integrations:write")
  test(@Req() req: Ctx, @Param("provider") provider: string) {
    return this.aiModels.test(req.businessContext.businessId, provider);
  }

  @Patch("default")
  @RequirePermission("integrations:write")
  setDefault(@Req() req: Ctx, @Body() body: { model?: unknown }) {
    return this.aiModels.setDefaultModel(req.businessContext.businessId, body?.model ?? null);
  }
}
