import { Module } from "@nestjs/common";
import { BillingController, StripeWebhookController } from "./billing.controller";
import { BillingService } from "./billing.service";

@Module({
  controllers: [BillingController, StripeWebhookController],
  providers: [BillingService],
})
export class BillingModule {}
