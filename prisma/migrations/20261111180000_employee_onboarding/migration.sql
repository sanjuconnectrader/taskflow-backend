-- Existing users retain access; only newly provisioned accounts require a change.
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WorkspaceMember"
  ADD COLUMN "employeeId" TEXT,
  ADD COLUMN "designation" TEXT,
  ADD COLUMN "department" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "joiningDate" DATE,
  ADD COLUMN "employmentStatus" TEXT NOT NULL DEFAULT 'ACTIVE';
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_employeeId_key" ON "WorkspaceMember" ("workspaceId", "employeeId");
