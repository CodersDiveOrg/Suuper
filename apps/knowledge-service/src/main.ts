import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { loadServiceConfig } from "@platform/shared-config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const config = loadServiceConfig("knowledge-service", 3004);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Knowledge-base file uploads arrive base64 in JSON (5 MB file ≈ 6.7 MB body).
  app.useBodyParser("json", { limit: "8mb" });
  await app.listen(config.port);
  console.log(`[knowledge-service] listening on :${config.port}`);
}

bootstrap();
