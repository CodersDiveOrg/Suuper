import { Module } from "@nestjs/common";
import { UsageController } from "./usage.controller";
import { UsageService } from "./usage.service";

// Metering (meter.ts) and limits (quota.ts) are plain functions used across modules; this serves the Usage page.
@Module({
  controllers: [UsageController],
  providers: [UsageService],
})
export class UsageModule {}
