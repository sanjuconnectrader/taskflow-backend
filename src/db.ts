import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { Prisma } from '@prisma/client';
import { PrismaPg } from "@prisma/adapter-pg";
export const db = new PrismaClient({
  adapter: new PrismaPg(
    {
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 15000,
    },
    {
      schema: process.env.DATABASE_URL
        ? new URL(process.env.DATABASE_URL).searchParams.get("schema") ||
          "public"
        : "public",
    },
  ),
});
export const userSelect = {
  id: true,
  username: true,
  email: true,
  displayName: true,
  mustChangePassword: true,
  preferences: true,
} as const;
export const taskInclude = {
  assignees: { include: { user: { select: userSelect } } },
  checklist: true,
  project: { select: { id: true, name: true, color: true } },
} as const;
export const databaseSchema=process.env.DATABASE_URL?new URL(process.env.DATABASE_URL).searchParams.get('schema')||'public':'public';
if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(databaseSchema))throw new Error('Invalid database schema name.');
export const table=(name:'Task'|'TaskAssignee'|'Project'|'ProjectMember'|'Attachment'|'StorageLocation'|'StorageDeletion'|'MaintenanceLease')=>Prisma.raw(`"${databaseSchema}"."${name}"`);
// List responses omit large descriptions/checklists and full user preferences.
export const taskListSelect={
  id:true,workspaceId:true,projectId:true,creatorId:true,title:true,status:true,priority:true,requiresReview:true,
  dueDate:true,startDate:true,tags:true,parentId:true,archived:true,version:true,createdAt:true,updatedAt:true,completedAt:true,
  project:{select:{id:true,name:true,color:true}},
  assignees:{select:{userId:true,user:{select:{id:true,displayName:true,username:true}}}},
  _count:{select:{checklist:true}},
} as const;
