import { randomUUID, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { db } from "../src/db.js";

const id = randomUUID();
class RollbackProbe extends Error {}
try {
  const passwordHash = await argon2.hash(randomBytes(32));
  try {
    await db.$transaction(
      async (tx) => {
        const user = await tx.user.create({
          data: {
            id,
            username: `probe_${id.slice(0, 8)}`,
            email: `${id}@connection-check.invalid`,
            displayName: "Connection verification",
            passwordHash,
          },
        });
        const workspace = await tx.workspace.create({
          data: {
            name: "Connection verification",
            members: { create: { userId: user.id, role: "OWNER" } },
          },
        });
        const project = await tx.project.create({
          data: { workspaceId: workspace.id, name: "Connection verification" },
        });
        const task = await tx.task.create({
          data: {
            workspaceId: workspace.id,
            projectId: project.id,
            creatorId: user.id,
            title: "Verify Supabase write",
            assignees: { create: { userId: user.id } },
          },
        });
        await tx.task.update({
          where: { id: task.id },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
        const saved = await tx.task.findUniqueOrThrow({
          where: { id: task.id },
          include: { assignees: true },
        });
        if (saved.status !== "COMPLETED" || saved.assignees[0]?.userId !== id)
          throw new Error("Database write/read verification failed.");
        throw new RollbackProbe();
      },
      { timeout: 15000 },
    );
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error;
  }
  if (await db.user.findUnique({ where: { id } }))
    throw new Error("Verification transaction was not rolled back.");
  console.log(
    "Verified Prisma user/workspace/project/task writes, assignment and status reads. Probe transaction rolled back; no test records retained.",
  );
} catch (error) {
  const e = error as NodeJS.ErrnoException;
  console.error(
    JSON.stringify({
      verified: false,
      code: e.code || e.name,
      message: e.message,
    }),
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
