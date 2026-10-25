import { Module } from "@nestjs/common";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";
import { RunsController } from "./runs.controller";
import { RunsService } from "./runs.service";
import { AgentRunner } from "./runtime/agent-runner";
import { AgentScheduleQueue } from "./schedule-queue";
import { SchedulesController } from "./schedules.controller";
import { SchedulesService } from "./schedules.service";
import { SkillsController } from "./skills.controller";
import { SkillsService } from "./skills.service";

@Module({
  controllers: [AgentsController, ConversationsController, RunsController, SkillsController, SchedulesController],
  providers: [
    AgentsService,
    ConversationsService,
    RunsService,
    AgentRunner,
    SkillsService,
    SchedulesService,
    AgentScheduleQueue,
  ],
})
export class AgentsModule {}
