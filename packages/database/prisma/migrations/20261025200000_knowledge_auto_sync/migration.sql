
-- AlterTable
ALTER TABLE "KnowledgeBase" ADD COLUMN     "autoSync" TEXT,
ADD COLUMN     "nextSyncAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "KnowledgeDocument" ADD COLUMN     "autoSync" TEXT,
ADD COLUMN     "nextSyncAt" TIMESTAMP(3);

