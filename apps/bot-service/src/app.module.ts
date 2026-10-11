import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { BotsModule } from "./bots/bots.module";
import { AgentsModule } from "./agents/agents.module";

@Module({
  imports: [BotsModule, AgentsModule],
  controllers: [HealthController],
})
export class AppModule {}
