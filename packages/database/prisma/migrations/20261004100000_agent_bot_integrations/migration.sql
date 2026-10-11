-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "integrations" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "integrations" TEXT[] DEFAULT ARRAY[]::TEXT[];

