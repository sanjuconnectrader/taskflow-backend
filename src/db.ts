import "dotenv/config";
import { PrismaClient } from "@prisma/client";
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
  preferences: true,
} as const;
export const taskInclude = {
  assignees: { include: { user: { select: userSelect } } },
  checklist: true,
  project: { select: { id: true, name: true, color: true } },
} as const;
