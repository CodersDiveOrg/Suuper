import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * Keys the public widget endpoint's rate limit on ip + widgetKey, so abuse
 * against one bot doesn't throttle every other bot sharing an IP (e.g. behind
 * the same corporate NAT), and one bot can't be hammered from a single IP.
 */
@Injectable()
export class WidgetThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return `${req.ip}:${req.params?.widgetKey}`;
  }
}
