-- CreateTable
CREATE TABLE "BotConversation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sessionKey" TEXT,
    "origin" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "issueCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "outcome" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotConversation_businessId_startedAt_idx" ON "BotConversation"("businessId", "startedAt");

-- CreateIndex
CREATE INDEX "BotConversation_botId_lastMessageAt_idx" ON "BotConversation"("botId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "BotConversation_botId_sessionKey_key" ON "BotConversation"("botId", "sessionKey");

-- CreateIndex
CREATE INDEX "BotMessage_conversationId_createdAt_idx" ON "BotMessage"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "BotConversation" ADD CONSTRAINT "BotConversation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

