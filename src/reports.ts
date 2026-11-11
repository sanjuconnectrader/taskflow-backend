import { Router } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { authenticate, membership } from "./security.js";
import { date, id } from "./validation.js";
export const reports = Router();
reports.use(authenticate);
export const csvCell = (v: unknown) =>
  `"${String(v ?? "")
    .replace(/^[=+@\-\t\r]/, "'$&")
    .replaceAll('"', '""')}"`;
reports.get("/:wid", async (req, res) => {
  const wid = id.parse(req.params.wid);
  await membership(wid, res.locals.user.id);
  const q = z
    .object({
      from: date.optional(),
      to: date.optional(),
      today: date,
      projectId: id.optional(),
      memberId: id.optional(),
      format: z.enum(["json", "csv"]).default("json"),
    })
    .parse(req.query);
  const tasks = await db.task.findMany({
    where: {
      workspaceId: wid,
      archived: false,
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.memberId ? { assignees: { some: { userId: q.memberId } } } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from + "T00:00:00Z") } : {}),
              ...(q.to ? { lte: new Date(q.to + "T23:59:59.999Z") } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      dueDate: true,
      completedAt: true,
      createdAt: true,
      projectId: true,
      assignees: { select: { userId: true } },
    },
  });
  if (q.format === "csv") {
    res
      .type("text/csv")
      .attachment("taskflow-report.csv")
      .send(
        [
          ["Title", "Status", "Priority", "Due date"],
          ...tasks.map((t) => [t.title, t.status, t.priority, t.dueDate]),
        ]
          .map((row) => row.map(csvCell).join(","))
          .join("\r\n"),
      );
    return;
  }
  const active = tasks.filter(
    (t) => !["COMPLETED", "CANCELLED"].includes(t.status),
  );
  const completed = tasks.filter((t) => t.status === "COMPLETED");
  const week = new Date(q.today + "T00:00:00Z");
  week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
  const counts = (key: "status" | "priority") =>
    Object.fromEntries(
      [...new Set(tasks.map((t) => t[key]))].map((k) => [
        k,
        tasks.filter((t) => t[key] === k).length,
      ]),
    );
  res.json({
    total: tasks.length,
    completed: completed.length,
    dueToday: active.filter((t) => t.dueDate === q.today).length,
    inProgress: active.filter((t) => t.status === "IN_PROGRESS").length,
    completedThisWeek: completed.filter(
      (t) => t.completedAt && t.completedAt >= week,
    ).length,
    overdue: active.filter((t) => t.dueDate && t.dueDate < q.today).length,
    completionRate: tasks.length
      ? Math.round((completed.length / tasks.length) * 100)
      : 0,
    byStatus: counts("status"),
    byPriority: counts("priority"),
    byProject: Object.fromEntries(
      [...new Set(tasks.map((t) => t.projectId))].map((k) => [
        k,
        {
          total: tasks.filter((t) => t.projectId === k).length,
          completed: completed.filter((t) => t.projectId === k).length,
        },
      ]),
    ),
    completedOverTime: Object.fromEntries(
      [
        ...new Set(
          completed.map((t) => t.completedAt!.toISOString().slice(0, 10)),
        ),
      ].map((k) => [
        k,
        completed.filter((t) => t.completedAt!.toISOString().slice(0, 10) === k)
          .length,
      ]),
    ),
    workload: Object.fromEntries(
      [...new Set(tasks.flatMap((t) => t.assignees.map((a) => a.userId)))].map(
        (uid) => [
          uid,
          active.filter((t) => t.assignees.some((a) => a.userId === uid))
            .length,
        ],
      ),
    ),
  });
});
