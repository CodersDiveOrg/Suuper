import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadServiceConfig } from "@platform/shared-config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const config = loadServiceConfig("bot-service", 3002);
  const app = await NestFactory.create(AppModule);
  // Lets WorkflowQueue close its worker cleanly on SIGTERM.
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`[bot-service] listening on :${config.port}`);
}

bootstrap();
