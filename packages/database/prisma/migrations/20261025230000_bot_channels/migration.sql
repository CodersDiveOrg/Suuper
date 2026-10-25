-- CreateTable
CREATE TABLE "BotChannel" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "webhookKey" TEXT NOT NULL,
    "verifyToken" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "contactName" TEXT,
    "direction" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "externalId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotChannel_webhookKey_key" ON "BotChannel"("webhookKey");

-- CreateIndex
CREATE INDEX "BotChannel_botId_idx" ON "BotChannel"("botId");

-- CreateIndex
CREATE UNIQUE INDEX "BotChannel_businessId_provider_key" ON "BotChannel"("businessId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMessage_externalId_key" ON "ChannelMessage"("externalId");

-- CreateIndex
CREATE INDEX "ChannelMessage_channelId_contact_createdAt_idx" ON "ChannelMessage"("channelId", "contact", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelMessage_channelId_createdAt_idx" ON "ChannelMessage"("channelId", "createdAt");

-- AddForeignKey
ALTER TABLE "BotChannel" ADD CONSTRAINT "BotChannel_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotChannel" ADD CONSTRAINT "BotChannel_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "BotChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

