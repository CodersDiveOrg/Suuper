import { Module } from "@nestjs/common";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";
import { RunsController } from "./runs.controller";
import { RunsService } from "./runs.service";
import { AgentRunner } from "./runtime/agent-runner";

@Module({
  controllers: [AgentsController, ConversationsController, RunsController],
  providers: [AgentsService, ConversationsService, RunsService, AgentRunner],
})
export class AgentsModule {}
