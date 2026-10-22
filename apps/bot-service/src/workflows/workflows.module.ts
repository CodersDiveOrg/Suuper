import { Module } from "@nestjs/common";
import { WebhookThrottlerGuard } from "./webhook-throttler.guard";
import { WorkflowQueue } from "./workflow-queue";
import { WorkflowsController, WorkflowWebhookController } from "./workflows.controller";
import { WorkflowsService } from "./workflows.service";

@Module({
  // ThrottlerModule is global (registered in BotsModule); the webhook route sets its own limit.
  controllers: [WorkflowsController, WorkflowWebhookController],
  providers: [WorkflowsService, WorkflowQueue, WebhookThrottlerGuard],
})
export class WorkflowsModule {}
