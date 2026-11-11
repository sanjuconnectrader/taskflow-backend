-- Preserve legacy workspace access. New company registrations opt into project isolation.
ALTER TABLE "Workspace" ADD COLUMN "enforceProjectAccess" BOOLEAN NOT NULL DEFAULT false;
