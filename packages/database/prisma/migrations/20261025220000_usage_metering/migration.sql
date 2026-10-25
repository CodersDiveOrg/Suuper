
-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'starter';

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageEvent_businessId_createdAt_idx" ON "UsageEvent"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Businesses that existed before plans start on Pro, so turning on limits blocks no one.
UPDATE "Business" SET "plan" = 'pro';
