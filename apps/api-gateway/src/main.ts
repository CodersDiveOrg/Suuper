import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadServiceConfig } from "@platform/shared-config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const config = loadServiceConfig("api-gateway", 3010);
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(config.port);
  console.log(`[api-gateway] listening on :${config.port}`);
}

bootstrap();
