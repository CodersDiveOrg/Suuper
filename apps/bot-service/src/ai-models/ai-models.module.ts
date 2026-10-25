import { Module } from "@nestjs/common";
import { AiModelsController } from "./ai-models.controller";
import { AiModelsService } from "./ai-models.service";

@Module({
  controllers: [AiModelsController],
  providers: [AiModelsService],
})
export class AiModelsModule {}
