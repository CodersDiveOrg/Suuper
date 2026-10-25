-- AlterTable
ALTER TABLE "Business" ADD COLUMN "defaultModel" TEXT;

-- AlterTable
ALTER TABLE "UsageEvent" ADD COLUMN "ownKey" BOOLEAN NOT NULL DEFAULT false;
