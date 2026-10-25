import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { BotsModule } from "./bots/bots.module";
import { AgentsModule } from "./agents/agents.module";
import { WorkflowsModule } from "./workflows/workflows.module";
import { AppsModule } from "./apps/apps.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { UsageModule } from "./usage/usage.module";
import { ChannelsModule } from "./channels/channels.module";
import { ConversationsModule } from "./conversations/conversations.module";
import { BillingModule } from "./billing/billing.module";
import { AiModelsModule } from "./ai-models/ai-models.module";

@Module({
  imports: [BotsModule, AgentsModule, WorkflowsModule, AppsModule, AnalyticsModule, WebhooksModule, UsageModule, ChannelsModule, ConversationsModule, BillingModule, AiModelsModule],
  controllers: [HealthController],
})
export class AppModule {}
