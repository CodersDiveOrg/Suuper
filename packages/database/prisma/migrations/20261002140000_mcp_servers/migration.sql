-- AlterTable
ALTER TABLE "McpServer" ADD COLUMN     "accessKeyHash" TEXT,
ADD COLUMN     "accessKeyPrefix" TEXT,
ADD COLUMN     "authHeaderName" TEXT,
ADD COLUMN     "authType" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "secretsEncrypted" TEXT,
ADD COLUMN     "tools" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "transport" TEXT NOT NULL DEFAULT 'auto',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "status" SET DEFAULT 'pending';

-- CreateTable
CREATE TABLE "McpHostedTool" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '[]',
    "method" TEXT NOT NULL DEFAULT 'GET',
    "urlTemplate" TEXT NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "secretHeadersEncrypted" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 15000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpHostedTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpToolCall" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "userId" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "isError" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpHostedTool_serverId_name_key" ON "McpHostedTool"("serverId", "name");

-- CreateIndex
CREATE INDEX "McpToolCall_serverId_createdAt_idx" ON "McpToolCall"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "McpToolCall_businessId_createdAt_idx" ON "McpToolCall"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpServer_accessKeyHash_key" ON "McpServer"("accessKeyHash");

-- AddForeignKey
ALTER TABLE "McpHostedTool" ADD CONSTRAINT "McpHostedTool_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpToolCall" ADD CONSTRAINT "McpToolCall_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

