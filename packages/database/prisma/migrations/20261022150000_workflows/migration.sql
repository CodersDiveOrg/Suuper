-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "trigger" JSONB NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "webhookKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "triggerData" JSONB,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "userId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_webhookKey_key" ON "Workflow"("webhookKey");

-- CreateIndex
CREATE INDEX "Workflow_businessId_idx" ON "Workflow"("businessId");

-- CreateIndex
CREATE INDEX "WorkflowRun_workflowId_startedAt_idx" ON "WorkflowRun"("workflowId", "startedAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_businessId_startedAt_idx" ON "WorkflowRun"("businessId", "startedAt");

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
