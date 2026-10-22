import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { BotsModule } from "./bots/bots.module";
import { AgentsModule } from "./agents/agents.module";
import { WorkflowsModule } from "./workflows/workflows.module";

@Module({
  imports: [BotsModule, AgentsModule, WorkflowsModule],
  controllers: [HealthController],
})
export class AppModule {}
