-- In-place conversions preserve every credential, date and relationship.
-- PostgreSQL rolls back the entire migration on invalid legacy values.
BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "Session" WHERE "tokenHash" !~ '^[0-9a-f]{64}$') OR EXISTS (SELECT 1 FROM "ResetAuthorization" WHERE "tokenHash" !~ '^[0-9a-f]{64}$') THEN
  RAISE EXCEPTION 'Unexpected token hash format; migration stopped without data loss';
 END IF;
 IF EXISTS (SELECT 1 FROM "Project" WHERE "dueDate" IS NOT NULL AND ("dueDate" !~ '^\d{4}-\d{2}-\d{2}$' OR "dueDate"::date::text<>"dueDate")) OR
 EXISTS (SELECT 1 FROM "Task" WHERE ("dueDate" IS NOT NULL AND ("dueDate" !~ '^\d{4}-\d{2}-\d{2}$' OR "dueDate"::date::text<>"dueDate")) OR ("startDate" IS NOT NULL AND ("startDate" !~ '^\d{4}-\d{2}-\d{2}$' OR "startDate"::date::text<>"startDate"))) THEN
  RAISE EXCEPTION 'Unexpected date format; migration stopped without truncation';
 END IF;
END $$;
-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('SUPABASE', 'S3');

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "preferences" DROP NOT NULL,
ALTER COLUMN "preferences" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "tokenHash" TYPE BYTEA USING decode("tokenHash",'hex');
ALTER TABLE "Session" ADD CONSTRAINT "Session_tokenHash_length" CHECK (octet_length("tokenHash")=32);

-- AlterTable
ALTER TABLE "Project" ALTER COLUMN "dueDate" TYPE DATE USING "dueDate"::date;

-- AlterTable
ALTER TABLE "Task" ALTER COLUMN "dueDate" TYPE DATE USING "dueDate"::date,
ALTER COLUMN "startDate" TYPE DATE USING "startDate"::date;

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (now() + '24 hours'::interval),
ADD COLUMN     "locationId" INTEGER,
ADD COLUMN     "optimizeImage" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "processingExpiresAt" TIMESTAMP(3),
ADD COLUMN     "processingToken" UUID;

-- AlterTable
ALTER TABLE "Notification" ALTER COLUMN "dedupeKey" TYPE BYTEA USING sha256(convert_to("dedupeKey",'UTF8'));

-- AlterTable
ALTER TABLE "ResetAuthorization" ALTER COLUMN "tokenHash" TYPE BYTEA USING decode("tokenHash",'hex');
ALTER TABLE "ResetAuthorization" ADD CONSTRAINT "ResetAuthorization_tokenHash_length" CHECK (octet_length("tokenHash")=32);

-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "metadata" DROP NOT NULL,
ALTER COLUMN "metadata" DROP DEFAULT;

-- CreateTable
CREATE TABLE "StorageLocation" (
    "id" SERIAL NOT NULL,
    "provider" "StorageProvider" NOT NULL,
    "bucket" TEXT NOT NULL,

    CONSTRAINT "StorageLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageDeletion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "locationId" INTEGER,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" VARCHAR(80),

    CONSTRAINT "StorageDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceLease" (
    "name" VARCHAR(80) NOT NULL,
    "token" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceLease_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorageLocation_provider_bucket_key" ON "StorageLocation"("provider", "bucket");

-- CreateIndex
CREATE INDEX "StorageDeletion_nextAttemptAt_createdAt_idx" ON "StorageDeletion"("nextAttemptAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StorageDeletion_locationId_key_key" ON "StorageDeletion"("locationId", "key");

-- CreateIndex
-- Session token unique index is preserved by ALTER TYPE.

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
-- The existing workspace/status/deadline index is preserved by ALTER TYPE.

-- CreateIndex
CREATE INDEX "ChecklistItem_taskId_idx" ON "ChecklistItem"("taskId");

-- CreateIndex
CREATE INDEX "Comment_taskId_createdAt_idx" ON "Comment"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_projectId_createdAt_idx" ON "Comment"("projectId", "createdAt");

-- CreateIndex
-- Notification deduplication unique index is preserved by ALTER TYPE.

-- CreateIndex
CREATE INDEX "Notification_read_createdAt_idx" ON "Notification"("read", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_createdAt_idx" ON "Activity"("createdAt");

-- CreateIndex
-- Reset token unique index is preserved by ALTER TYPE.

-- CreateIndex
CREATE INDEX "ResetAuthorization_expiresAt_idx" ON "ResetAuthorization"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StorageLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageDeletion" ADD CONSTRAINT "StorageDeletion_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StorageLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "User" SET preferences=NULL WHERE preferences='{}'::jsonb;
UPDATE "AuditLog" SET metadata=NULL WHERE metadata='{}'::jsonb;
CREATE INDEX "Task_parent_nonnull_idx" ON "Task"("parentId") WHERE "parentId" IS NOT NULL;
CREATE INDEX "Attachment_pending_expiry_idx" ON "Attachment"("expiresAt") WHERE NOT confirmed;

-- Preserve native PostgreSQL lossless TOAST, using LZ4 when the server supports it.
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT * FROM (VALUES ('Task','description'),('Comment','body'),('Project','description'),('Workspace','description'),('RecoveryRequest','explanation'),('RecoveryRequest','internalNotes'),('AuditLog','metadata')) AS columns_to_compress(t,c) LOOP
  EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET STORAGE EXTENDED',item.t,item.c);
  BEGIN
   EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET COMPRESSION lz4',item.t,item.c);
  EXCEPTION WHEN feature_not_supported OR undefined_object THEN
   EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET COMPRESSION pglz',item.t,item.c);
  END;
 END LOOP;
END $$;

-- Durable outbox survives cascades from explicit task/project/workspace deletion.
CREATE FUNCTION taskflow_queue_deleted_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('INSERT INTO %I."StorageDeletion" ("locationId",key) VALUES ($1,$2) ON CONFLICT DO NOTHING',TG_TABLE_SCHEMA) USING OLD."locationId",OLD.key;
 RETURN OLD;
END $$;
CREATE TRIGGER taskflow_attachment_deletion_outbox AFTER DELETE ON "Attachment" FOR EACH ROW EXECUTE FUNCTION taskflow_queue_deleted_attachment();
COMMIT;
