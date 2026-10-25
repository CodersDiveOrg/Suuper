import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { BotsController } from "./bots.controller";
import { BotsService } from "./bots.service";
import { WidgetController } from "./widget.controller";
import { WidgetKeyGuard } from "./widget-key.guard";
import { WidgetThrottlerGuard } from "./widget-throttler.guard";

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }])],
  controllers: [BotsController, WidgetController],
  providers: [BotsService, WidgetKeyGuard, WidgetThrottlerGuard],
  exports: [BotsService],
})
export class BotsModule {}
