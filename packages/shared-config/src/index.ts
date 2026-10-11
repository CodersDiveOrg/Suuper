import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

// Load the repo-root .env into process.env (without overriding anything already
// set by the shell/CI). Runs on import, before services touch Prisma, which
// reads DATABASE_URL straight from the environment. Services are launched from
// apps/<service>, so walk up from cwd to find it.
function loadRootEnv() {
  let dir = process.cwd();
  for (;;) {
    const file = join(dir, ".env");
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        const [, key, raw] = match;
        if (process.env[key] !== undefined) continue;
        process.env[key] = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadRootEnv();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadServiceConfig(serviceName: string, defaultPort = 3000) {
  return {
    serviceName,
    port: Number(process.env.PORT ?? defaultPort),
    databaseUrl: required("DATABASE_URL", "postgresql://postgres:postgres@localhost:5433/platform"),
    redisUrl: required("REDIS_URL", "redis://localhost:6380"),
    jwtSecret: required("JWT_SECRET", "dev-secret-change-me"),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    // Internal service URLs api-gateway proxies to, and that bot-service
    // calls knowledge-service through. Harmless to load everywhere for now.
    identityServiceUrl: required("IDENTITY_SERVICE_URL", "http://localhost:3001"),
    botServiceUrl: required("BOT_SERVICE_URL", "http://localhost:3002"),
    knowledgeServiceUrl: required("KNOWLEDGE_SERVICE_URL", "http://localhost:3004"),
    mcpGatewayUrl: required("MCP_GATEWAY_URL", "http://localhost:3003"),
    // Public base URL of api-gateway — used to show hosted MCP endpoints to users.
    publicApiUrl: (process.env.PUBLIC_API_URL || "http://localhost:3010").replace(/\/+$/, ""),
    // Local development only: let MCP servers / hosted tools reach localhost and
    // private networks. Off by default — those requests are an SSRF risk.
    mcpAllowPrivateUrls: process.env.MCP_ALLOW_PRIVATE_URLS === "true",
    // Local, free embeddings + chat model runtime (see packages/shared-ai).
    ollamaUrl: required("OLLAMA_URL", "http://localhost:11434"),
    ollamaEmbeddingModel: required("OLLAMA_EMBEDDING_MODEL", "nomic-embed-text"),
    ollamaChatModel: required("OLLAMA_CHAT_MODEL", "llama3.2:3b"),
    // Built by apps/widget (`pnpm --filter @platform/widget build`). Resolved
    // relative to the running service's cwd (apps/<service>), same as every
    // other app is launched by the root turbo scripts.
    widgetJsPath: process.env.WIDGET_JS_PATH ?? resolve(process.cwd(), "../widget/dist/widget.js"),
  };
}

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;
