import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/** Rate-limits each workflow's public webhook on its key (requests arrive via api-gateway, so not by IP). */
@Injectable()
export class WebhookThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return `workflow-webhook:${req.params?.webhookKey}`;
  }
}
