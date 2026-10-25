import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { auditMiddleware } from "@platform/database";
import { loadServiceConfig } from "@platform/shared-config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const config = loadServiceConfig("identity-service", 3001);
  const app = await NestFactory.create(AppModule);
  // Records members' changes for the audit log (see @platform/database audit.ts).
  app.use(auditMiddleware);
  await app.listen(config.port);
  console.log(`[identity-service] listening on :${config.port}`);
}

bootstrap();
