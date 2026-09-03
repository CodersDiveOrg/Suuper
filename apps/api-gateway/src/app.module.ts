import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { AuthProxyController } from "./auth/auth-proxy.controller";

@Module({
  controllers: [HealthController, AuthProxyController],
})
export class AppModule {}
