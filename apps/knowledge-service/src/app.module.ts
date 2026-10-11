import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { KnowledgeBasesModule } from "./knowledge-bases/knowledge-bases.module";

@Module({
  imports: [KnowledgeBasesModule],
  controllers: [HealthController],
})
export class AppModule {}
