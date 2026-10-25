import { Module } from "@nestjs/common";
import { WorkflowsModule } from "../workflows/workflows.module";
import { AppsController, PublicAppsController } from "./apps.controller";
import { AppsService } from "./apps.service";
import { AssistantService } from "./assistant.service";
import { PublicAppThrottlerGuard } from "./public-app-throttler.guard";
import { RecordsService } from "./records.service";

@Module({
  imports: [WorkflowsModule],
  controllers: [AppsController, PublicAppsController],
  providers: [AppsService, RecordsService, AssistantService, PublicAppThrottlerGuard],
})
export class AppsModule {}
