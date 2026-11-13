-- Plans move from code (shared-types PLANS) to the database so they can be managed in the admin panel.
CREATE TABLE "Plan" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "priceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "interval" TEXT NOT NULL DEFAULT 'month',
    "limits" JSONB NOT NULL,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "stripePriceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Plan_pkey" PRIMARY KEY ("key")
);
CREATE UNIQUE INDEX "Plan_stripePriceId_key" ON "Plan"("stripePriceId");

CREATE TABLE "PlanGrant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountUsd" DOUBLE PRECISION,
    "note" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanGrant_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlanGrant_businessId_endedAt_idx" ON "PlanGrant"("businessId", "endedAt");
CREATE INDEX "PlanGrant_endsAt_idx" ON "PlanGrant"("endsAt");
ALTER TABLE "PlanGrant" ADD CONSTRAINT "PlanGrant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The plans that were in code, unchanged (sizes in bytes).
INSERT INTO "Plan" ("key", "name", "description", "priceUsd", "limits", "isDefault", "sortOrder") VALUES
('starter', 'Starter', 'One location getting started with an AI assistant.', 97,
 '{"ai_replies":2000,"ai_credits":1500,"agent_runs":300,"workflow_runs":2000,"bots":3,"members":3,"knowledge_storage":104857600,"app_records":10000}', true, 1),
('growth', 'Growth', 'A growing business with steady customer traffic.', 297,
 '{"ai_replies":10000,"ai_credits":6000,"agent_runs":1500,"workflow_runs":10000,"bots":10,"members":10,"knowledge_storage":524288000,"app_records":50000}', false, 2),
('pro', 'Pro', 'High volume, several teams or locations.', 497,
 '{"ai_replies":50000,"ai_credits":15000,"agent_runs":5000,"workflow_runs":50000,"bots":25,"members":25,"knowledge_storage":2147483648,"app_records":250000}', false, 3);
