ALTER TABLE "Project" ADD COLUMN "restrictMembership" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Project_id_workspaceId_key" ON "Project"("id", "workspaceId");
CREATE TABLE "ProjectMember" (
  "projectId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("projectId", "userId"),
  CONSTRAINT "ProjectMember_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "Project"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectMember_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProjectMember_workspaceId_userId_idx" ON "ProjectMember"("workspaceId", "userId");
