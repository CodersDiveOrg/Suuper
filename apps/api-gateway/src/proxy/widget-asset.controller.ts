import { Controller, Get, InternalServerErrorException, Res } from "@nestjs/common";
import { readFileSync } from "fs";
import type { Response } from "express";
import { loadServiceConfig } from "@platform/shared-config";

const widgetJsPath = loadServiceConfig("api-gateway", 3010).widgetJsPath;

// Serves apps/widget's build output. Not under /public/widget so it doesn't
// collide with WidgetProxyController's wildcard forward on that prefix.
@Controller()
export class WidgetAssetController {
  @Get("widget.js")
  serveWidgetJs(@Res() res: Response) {
    let contents: string;
    try {
      contents = readFileSync(widgetJsPath, "utf-8");
    } catch {
      throw new InternalServerErrorException(
        `Widget bundle not found at ${widgetJsPath} — run "pnpm --filter @platform/widget build"`,
      );
    }
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(contents);
  }
}
