import { Module } from "@nestjs/common";
import { BotsModule } from "../bots/bots.module";
import { ChannelWebhookThrottlerGuard } from "./channel-webhook-throttler.guard";
import { ChannelsController, ChannelWebhookController } from "./channels.controller";
import { ChannelsService } from "./channels.service";

@Module({
  // ThrottlerModule is global (registered in BotsModule); the webhook route sets its own limit.
  imports: [BotsModule],
  controllers: [ChannelsController, ChannelWebhookController],
  providers: [ChannelsService, ChannelWebhookThrottlerGuard],
  exports: [ChannelsService],
})
export class ChannelsModule {}
