import { Module } from "@nestjs/common";
import { WebhookQueue } from "./webhook-queue";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

// Events are emitted with emitWebhookEvent (delivery.ts), so other modules don't import this one.
@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookQueue],
})
export class WebhooksModule {}
