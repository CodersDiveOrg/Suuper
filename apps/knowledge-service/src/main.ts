import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadServiceConfig } from "@platform/shared-config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const config = loadServiceConfig("knowledge-service", 3004);
  const app = await NestFactory.create(AppModule);
  await app.listen(config.port);
  console.log(`[knowledge-service] listening on :${config.port}`);
}

bootstrap();
