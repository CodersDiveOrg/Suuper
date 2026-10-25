-- AlterTable
ALTER TABLE "UsageEvent" ADD COLUMN "credits" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Backfill: credits = list cost in USD × 100, i.e. (tokens × $/1M) / 1,000,000 × 100.
-- Own-key and local-model calls stay at 0.
UPDATE "UsageEvent" SET "credits" = CASE "model"
    WHEN 'claude-opus-5-5' THEN ("inputTokens" * 4 + "outputTokens" * 20) / 10000.0
    WHEN 'claude-sonnet-5-5' THEN ("inputTokens" * 2 + "outputTokens" * 10) / 10000.0
    WHEN 'claude-haiku-4-5' THEN ("inputTokens" * 1 + "outputTokens" * 5) / 10000.0
    WHEN 'gpt-6.1-sol' THEN ("inputTokens" * 2 + "outputTokens" * 10) / 10000.0
    WHEN 'gpt-6-astra' THEN ("inputTokens" * 10 + "outputTokens" * 50) / 10000.0
    WHEN 'gpt-6-luna' THEN ("inputTokens" * 0.1 + "outputTokens" * 0.5) / 10000.0
    WHEN 'gemini-4-argon' THEN ("inputTokens" * 2 + "outputTokens" * 10) / 10000.0
    WHEN 'gemini-3.8-flash' THEN ("inputTokens" * 0.75 + "outputTokens" * 3.75) / 10000.0
    WHEN 'gemini-3.5-flash-lite' THEN ("inputTokens" * 0.3 + "outputTokens" * 2.5) / 10000.0
    ELSE 0
  END
WHERE "type" = 'ai_call' AND "ownKey" = false;
