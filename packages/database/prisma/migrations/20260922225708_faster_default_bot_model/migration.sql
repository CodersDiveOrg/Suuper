-- DropIndex
DROP INDEX "Product_embedding_idx";

-- AlterTable
ALTER TABLE "Bot" ALTER COLUMN "model" SET DEFAULT 'llama3.2:1b';
