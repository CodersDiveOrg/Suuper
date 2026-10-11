import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePermission } from "@platform/shared-auth";
import type { BusinessContext } from "@platform/shared-types";
import { AgentsService, type AgentInput } from "./agents.service";
import { ConversationsService } from "./conversations.service";

interface SendMessageBody {
  message?: string;
}

// Business comes from the token, so the path is fixed at "current" — same
// pattern as BotsController.
@Controller("businesses/current/agents")
export class AgentsController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly conversations: ConversationsService,
  ) {}

  @Post()
  @RequirePermission("agents:write")
  async create(@Req() request: { businessContext: BusinessContext }, @Body() body: AgentInput) {
    return this.agentsService.create(request.businessContext.businessId, body ?? {});
  }

  // Declared before ":id" so these aren't captured as agent ids.
  @Get("models")
  @RequirePermission("agents:read")
  async models(@Req() request: { businessContext: BusinessContext }) {
    return this.agentsService.models(request.businessContext.businessId);
  }

  @Get("tools")
  @RequirePermission("agents:read")
  tools() {
    return this.agentsService.tools();
  }

  /** Integrations agents and bots can use, with their actions and connection status. */
  @Get("integration-tools")
  @RequirePermission("agents:read")
  integrationTools(@Req() request: { businessContext: BusinessContext }) {
    return this.agentsService.integrationTools(request.businessContext.businessId);
  }

  @Get()
  @RequirePermission("agents:read")
  async list(@Req() request: { businessContext: BusinessContext }) {
    return this.agentsService.list(request.businessContext.businessId);
  }

  @Get(":id")
  @RequirePermission("agents:read")
  async get(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    return this.agentsService.get(request.businessContext.businessId, id);
  }

  @Patch(":id")
  @RequirePermission("agents:write")
  async update(
    @Req() request: { businessContext: BusinessContext },
    @Param("id") id: string,
    @Body() body: AgentInput,
  ) {
    return this.agentsService.update(request.businessContext.businessId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("agents:write")
  async remove(@Req() request: { businessContext: BusinessContext }, @Param("id") id: string) {
    await this.agentsService.remove(request.businessContext.businessId, id);
  }

  // Legacy one-shot endpoint kept for the original Playground: runs the message
  // in a fresh conversation through the full agent runtime.
  @Post(":id/messages")
  @RequirePermission("agents:run")
  async sendMessage(
    @Req() request: { businessContext: BusinessContext },
    @Param("id") id: string,
    @Body() body: SendMessageBody,
  ) {
    const { businessId, userId } = request.businessContext;
    return this.conversations.oneShot(businessId, id, userId, body.message);
  }
}
