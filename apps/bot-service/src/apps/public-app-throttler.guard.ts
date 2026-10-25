import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/** Rate-limits each app's public page on its slug (requests arrive via api-gateway, so not by IP). */
@Injectable()
export class PublicAppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return `public-app:${req.params?.slug}`;
  }
}
