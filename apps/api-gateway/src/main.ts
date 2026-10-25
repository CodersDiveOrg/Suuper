import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { loadServiceConfig } from "@platform/shared-config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const config = loadServiceConfig("api-gateway", 3010);
  // rawBody: channel webhooks are relayed byte for byte (WhatsApp signs the raw body).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Knowledge-base file uploads arrive base64 in JSON (5 MB file ≈ 6.7 MB body).
  app.useBodyParser("json", { limit: "8mb" });
  app.enableCors();
  await app.listen(config.port);
  console.log(`[api-gateway] listening on :${config.port}`);
}

bootstrap();
