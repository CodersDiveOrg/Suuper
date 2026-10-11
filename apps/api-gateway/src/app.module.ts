import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import {
  AuthProxyController,
  BusinessesProxyController,
  InvitationsProxyController,
} from "./proxy/identity-proxy.controller";
import { KnowledgeBasesProxyController } from "./proxy/knowledge-proxy.controller";
import { BotsProxyController } from "./proxy/bot-proxy.controller";
import {
  AgentMessagesStreamProxyController,
  AgentRunsProxyController,
  AgentsProxyController,
} from "./proxy/agent-proxy.controller";
import { HostedMcpProxyController, McpServersProxyController } from "./proxy/mcp-proxy.controller";
import { WidgetProxyController } from "./proxy/widget-proxy.controller";
import { WidgetAssetController } from "./proxy/widget-asset.controller";

@Module({
  controllers: [
    HealthController,
    WidgetAssetController,
    AuthProxyController,
    // More specific than BusinessesProxyController's "businesses/*" — must
    // come first so Nest/Express matches these routes before falling through
    // to the generic identity-service forward.
    KnowledgeBasesProxyController,
    BotsProxyController,
    AgentMessagesStreamProxyController,
    AgentRunsProxyController,
    AgentsProxyController,
    WidgetProxyController,
    McpServersProxyController,
    HostedMcpProxyController,
    BusinessesProxyController,
    InvitationsProxyController,
  ],
})
export class AppModule {}
