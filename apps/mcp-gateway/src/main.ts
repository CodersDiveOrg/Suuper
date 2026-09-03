import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadServiceConfig } from "@platform/shared-config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const config = loadServiceConfig("mcp-gateway", 3003);
  const app = await NestFactory.create(AppModule);
  await app.listen(config.port);
  console.log(`[mcp-gateway] listening on :${config.port}`);
}

bootstrap();
