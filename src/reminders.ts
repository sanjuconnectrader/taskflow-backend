import { db } from "./db.js";
const today = new Date().toISOString().slice(0, 10);
const tasks = await db.task.findMany({
  where: {
    archived: false,
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    dueDate: { lte: today },
  },
  include: { assignees: { include: { user: true } } },
});
for (const task of tasks)
  for (const a of task.assignees) {
    const prefs = a.user.preferences as any;
    if (prefs.reminders === false || prefs.notifications === false) continue;
    const dedupeKey = `deadline:${task.id}:${a.userId}:${today}`;
    await db.notification.upsert({
      where: { dedupeKey },
      create: {
        userId: a.userId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        title: `${task.dueDate === today ? "Due today" : "Overdue"}: ${task.title}`,
        dedupeKey,
      },
      update: {},
    });
  }
await db.$disconnect();
