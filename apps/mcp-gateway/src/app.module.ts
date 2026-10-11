import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { ServersController } from "./servers/servers.controller";
import { ServersService } from "./servers/servers.service";
import { HostedToolsService } from "./hosted/hosted-tools.service";
import { HostedMcpController } from "./hosted/hosted-mcp.controller";
import { InternalController } from "./internal/internal.controller";
import { ToolRunnerService } from "./mcp/tool-runner.service";

@Module({
  controllers: [HealthController, ServersController, HostedMcpController, InternalController],
  providers: [ServersService, HostedToolsService, ToolRunnerService],
})
export class AppModule {}
