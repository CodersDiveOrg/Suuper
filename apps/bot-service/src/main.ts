import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { auditMiddleware } from "@platform/database";
import { loadServiceConfig } from "@platform/shared-config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const config = loadServiceConfig("bot-service", 3002);
  // rawBody: channel webhooks check WhatsApp's signature over the exact bytes sent.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // Records members' changes for the audit log (see @platform/database audit.ts).
  app.use(auditMiddleware);
  // Lets WorkflowQueue close its worker cleanly on SIGTERM.
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`[bot-service] listening on :${config.port}`);
}

bootstrap();
