import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/** Rate-limits each channel's public webhook on its key (requests arrive via api-gateway, so not by IP). */
@Injectable()
export class ChannelWebhookThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return `channel-webhook:${req.params?.webhookKey}`;
  }
}
