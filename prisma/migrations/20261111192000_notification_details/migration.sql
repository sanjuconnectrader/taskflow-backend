ALTER TABLE "Notification" ADD COLUMN "message" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Notification" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'GENERAL';
CREATE INDEX "Notification_userId_workspaceId_type_read_createdAt_idx" ON "Notification"("userId", "workspaceId", "type", "read", "createdAt");
