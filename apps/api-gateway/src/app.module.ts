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
  ChannelsProxyController,
  ChannelWebhookProxyController,
  ConversationsProxyController,
} from "./proxy/channel-proxy.controller";
import { AiModelsProxyController, BillingProxyController, BillingWebhookProxyController } from "./proxy/billing-proxy.controller";
import {
  AgentMessagesStreamProxyController,
  AgentRunsProxyController,
  AgentSchedulesProxyController,
  AgentSkillsProxyController,
  AgentsProxyController,
  AnalyticsProxyController,
} from "./proxy/agent-proxy.controller";
import { HostedMcpProxyController, McpServersProxyController } from "./proxy/mcp-proxy.controller";
import { WidgetProxyController } from "./proxy/widget-proxy.controller";
import { WidgetAssetController } from "./proxy/widget-asset.controller";
import { UsageProxyController, WebhooksProxyController } from "./proxy/webhook-proxy.controller";
import { WorkflowsProxyController, WorkflowWebhookProxyController } from "./proxy/workflow-proxy.controller";
import { AppsProxyController, PublicAppsProxyController } from "./proxy/app-proxy.controller";

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
    ChannelsProxyController,
    ConversationsProxyController,
    BillingProxyController,
    AiModelsProxyController,
    AgentMessagesStreamProxyController,
    AgentRunsProxyController,
    AgentSkillsProxyController,
    AgentSchedulesProxyController,
    AgentsProxyController,
    AnalyticsProxyController,
    WebhooksProxyController,
    UsageProxyController,
    WidgetProxyController,
    WorkflowsProxyController,
    WorkflowWebhookProxyController,
    ChannelWebhookProxyController,
    BillingWebhookProxyController,
    AppsProxyController,
    PublicAppsProxyController,
    McpServersProxyController,
    HostedMcpProxyController,
    BusinessesProxyController,
    InvitationsProxyController,
  ],
})
export class AppModule {}
