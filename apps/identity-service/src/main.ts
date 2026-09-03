import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadServiceConfig } from "@platform/shared-config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const config = loadServiceConfig("identity-service", 3001);
  const app = await NestFactory.create(AppModule);
  await app.listen(config.port);
  console.log(`[identity-service] listening on :${config.port}`);
}

bootstrap();
