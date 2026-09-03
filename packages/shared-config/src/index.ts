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
    // Internal service URLs api-gateway proxies to. Not used by services
    // other than the gateway; harmless to load everywhere for now.
    identityServiceUrl: required("IDENTITY_SERVICE_URL", "http://localhost:3001"),
  };
}

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;
