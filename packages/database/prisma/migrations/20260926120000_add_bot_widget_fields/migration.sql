-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "widgetEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "widgetKey" TEXT NOT NULL DEFAULT gen_random_uuid(),
ADD COLUMN     "allowedOrigins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE UNIQUE INDEX "Bot_widgetKey_key" ON "Bot"("widgetKey");
