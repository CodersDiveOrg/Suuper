-- CreateTable
CREATE TABLE "App" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "templateKey" TEXT,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'live',
    "definition" JSONB NOT NULL,
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "App_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'app',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppRecordActivity" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppRecordActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "App_slug_key" ON "App"("slug");

-- CreateIndex
CREATE INDEX "App_businessId_idx" ON "App"("businessId");

-- CreateIndex
CREATE INDEX "AppRecord_appId_entity_createdAt_idx" ON "AppRecord"("appId", "entity", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppRecord_appId_entity_number_key" ON "AppRecord"("appId", "entity", "number");

-- CreateIndex
CREATE INDEX "AppRecordActivity_recordId_createdAt_idx" ON "AppRecordActivity"("recordId", "createdAt");

-- AddForeignKey
ALTER TABLE "App" ADD CONSTRAINT "App_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppRecord" ADD CONSTRAINT "AppRecord_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppRecordActivity" ADD CONSTRAINT "AppRecordActivity_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "AppRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

