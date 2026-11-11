import { Router } from "express";
import { z } from "zod";
import { db, taskInclude, userSelect } from "./db.js";
import { authenticate, fail, membership } from "./security.js";
import { id, projectInput, taskInput } from "./validation.js";
import type { Server } from "socket.io";
export function workspaceRoutes(io: Server) {
  const r = Router();
  r.use(authenticate);
  r.get("/", async (req, res) =>
    res.json(
      await db.workspaceMember.findMany({
        where: { userId: res.locals.user.id },
        include: { workspace: true },
      }),
    ),
  );
  r.post("/", async (req, res) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(150),
        description: z.string().max(2000).default(""),
      })
      .parse(req.body);
    res
      .status(201)
      .json(
        await db.workspace.create({
          data: {
            ...data,
            members: { create: { userId: res.locals.user.id, role: "OWNER" } },
          },
        }),
      );
  });
  r.use("/:wid", async (req, res, next) => {
    try {
      const wid = id.parse(req.params.wid);
      res.locals.wid = wid;
      const ownNotification = req.path.endsWith("/notifications/read");
      const workspaceEdit =
        req.method === "PATCH" &&
        req.path.split("/").filter(Boolean).length === 1;
      res.locals.member = await membership(
        wid,
        res.locals.user.id,
        !["GET", "HEAD"].includes(req.method) &&
          !ownNotification &&
          !workspaceEdit,
      );
      next();
    } catch (e) {
      next(e);
    }
  });
  const wid = (res: any) => res.locals.wid as string;
  const admin = async (res: any) =>
    membership(wid(res), res.locals.user.id, true, true);
  const activity = async (res: any, action: string, target: string) => {
    await db.activity.create({
      data: {
        workspaceId: wid(res),
        actorId: res.locals.user.id,
        actorName: res.locals.user.displayName,
        action,
        target,
      },
    });
    io.to(`workspace:${wid(res)}`).emit("invalidate", {
      event: action,
      id: crypto.randomUUID(),
    });
  };
  const project = async (res: any, pid: string) => {
    const p = await db.project.findFirst({
      where: { id: id.parse(pid), workspaceId: wid(res) },
    });
    if (!p) fail(404, "Project not found.");
    return p!;
  };
  const task = async (res: any, tid: string) => {
    const t = await db.task.findFirst({
      where: { id: id.parse(tid), workspaceId: wid(res) },
      include: taskInclude,
    });
    if (!t) fail(404, "Task not found.");
    return t!;
  };
  r.patch("/:wid", async (req, res) => {
    const m = await membership(wid(res), res.locals.user.id, false, true);
    if (m.role !== "OWNER")
      fail(403, "Workspace settings require owner access.");
    const data = z
      .object({
        name: z.string().min(1).max(150).optional(),
        description: z.string().max(2000).optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    res.json(await db.workspace.update({ where: { id: wid(res) }, data }));
  });
  r.delete("/:wid", async (req, res) => {
    if (res.locals.member.role !== "OWNER")
      fail(403, "Only the owner may delete this workspace.");
    const data = z.object({ confirmation: z.string() }).parse(req.body);
    if (data.confirmation !== res.locals.member.workspace.name)
      fail(400, "Enter the workspace name to confirm.");
    await db.workspace.delete({ where: { id: wid(res) } });
    res.json({ ok: true });
  });
  r.get("/:wid/members", async (req, res) =>
    res.json(
      await db.workspaceMember.findMany({
        where: { workspaceId: wid(res) },
        include: { user: { select: userSelect } },
      }),
    ),
  );
  r.post("/:wid/members", async (req, res) => {
    await admin(res);
    const data = z
      .object({
        email: z.email().toLowerCase(),
        role: z.enum(["ADMIN", "MEMBER", "VIEWER"]).default("MEMBER"),
      })
      .parse(req.body);
    if (data.role === "ADMIN" && res.locals.member.role !== "OWNER")
      fail(403, "Only owners can appoint administrators.");
    const u = await db.user.findUnique({ where: { email: data.email } });
    if (!u)
      fail(
        422,
        "This person must register before being added. No email invitation has been sent.",
      );
    res
      .status(201)
      .json(
        await db.workspaceMember.create({
          data: { workspaceId: wid(res), userId: u!.id, role: data.role },
          include: { user: { select: userSelect } },
        }),
      );
    await activity(res, "member:added", u!.displayName);
  });
  r.patch("/:wid/members/:uid", async (req, res) => {
    await admin(res);
    const role = z.enum(["ADMIN", "MEMBER", "VIEWER"]).parse(req.body.role);
    const m = await db.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: wid(res),
          userId: id.parse(req.params.uid),
        },
      },
    });
    if (!m || m.role === "OWNER" || res.locals.member.role !== "OWNER")
      fail(403, "Only owners may change non-owner roles.");
    res.json(
      await db.workspaceMember.update({
        where: {
          workspaceId_userId: { workspaceId: wid(res), userId: m!.userId },
        },
        data: { role },
      }),
    );
    io.to(`workspace:${wid(res)}`).emit("invalidate");
  });
  r.delete("/:wid/members/:uid", async (req, res) => {
    await admin(res);
    const uid = id.parse(req.params.uid);
    const m = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: wid(res), userId: uid } },
    });
    if (
      !m ||
      m.role === "OWNER" ||
      (m.role === "ADMIN" && res.locals.member.role !== "OWNER")
    )
      fail(403, "Cannot remove this member.");
    await db.$transaction(async (tx) => {
      await tx.taskAssignee.deleteMany({
        where: { userId: uid, task: { workspaceId: wid(res) } },
      });
      await tx.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId: wid(res), userId: uid } },
      });
    });
    for (const s of await io.in(`user:${uid}`).fetchSockets())
      await s.leave(`workspace:${wid(res)}`);
    res.json({ ok: true });
  });
  r.get("/:wid/projects", async (req, res) =>
    res.json(
      await db.project.findMany({
        where: { workspaceId: wid(res) },
        include: { _count: { select: { tasks: true } } },
        orderBy: { createdAt: "desc" },
      }),
    ),
  );
  r.post("/:wid/projects", async (req, res) => {
    await admin(res);
    const data = projectInput.parse(req.body);
    const p = await db.project.create({
      data: { ...data, workspaceId: wid(res) },
    });
    await activity(res, "project:created", p.name);
    res.status(201).json(p);
  });
  r.patch("/:wid/projects/:pid", async (req, res) => {
    await admin(res);
    await project(res, String(req.params.pid));
    const data = projectInput
      .partial()
      .extend({ archived: z.boolean().optional() })
      .parse(req.body);
    const p = await db.project.update({
      where: { id: String(req.params.pid) },
      data,
    });
    await activity(res, "project:updated", p.name);
    res.json(p);
  });
  r.delete("/:wid/projects/:pid", async (req, res) => {
    await admin(res);
    const p = await project(res, String(req.params.pid));
    await db.project.delete({ where: { id: p.id } });
    await activity(res, "project:deleted", p.name);
    res.json({ ok: true });
  });
  r.get("/:wid/tasks", async (req, res) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        search: z.string().max(200).optional(),
        projectId: id.optional(),
        status: z
          .enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "COMPLETED", "CANCELLED"])
          .optional(),
        archived: z.enum(["true", "false"]).default("false"),
        assigneeId: id.optional(),
      })
      .parse(req.query);
    const where = {
      workspaceId: wid(res),
      archived: q.archived === "true",
      ...(q.search
        ? { title: { contains: q.search, mode: "insensitive" as const } }
        : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.assigneeId
        ? { assignees: { some: { userId: q.assigneeId } } }
        : {}),
    };
    const [items, total] = await db.$transaction([
      db.task.findMany({
        where,
        include: taskInclude,
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      db.task.count({ where }),
    ]);
    res.json({ items, total, page: q.page, limit: q.limit });
  });
  async function validateTask(res: any, data: any) {
    const p = await project(res, data.projectId);
    if (p.archived) fail(400, "Project is archived.");
    if (data.startDate && data.dueDate && data.startDate > data.dueDate)
      fail(400, "Start date must precede due date.");
    const count = await db.workspaceMember.count({
      where: {
        workspaceId: wid(res),
        userId: { in: [...new Set<string>(data.assigneeIds)] },
      },
    });
    if (count !== new Set(data.assigneeIds).size)
      fail(400, "Assignees must belong to this workspace.");
    if (data.parentId) {
      const parent = await task(res, data.parentId);
      if (parent.projectId !== data.projectId || parent.parentId)
        fail(400, "Subtasks must share the parent project and have one level.");
    }
  }
  async function notify(res: any, t: any, title: string) {
    const targets = t.assignees
      .map((a: any) => a.userId)
      .filter((u: string) => u !== res.locals.user.id);
    await db.notification.createMany({
      data: targets.map((userId: string) => ({
        userId,
        workspaceId: wid(res),
        title,
        taskId: t.id,
      })),
    });
    for (const uid of targets) io.to(`user:${uid}`).emit("invalidate");
  }
  r.post("/:wid/tasks", async (req, res) => {
    const data = taskInput.parse(req.body);
    await validateTask(res, data);
    const { assigneeIds, checklist, ...rest } = data;
    const t = await db.task.create({
      data: {
        ...rest,
        workspaceId: wid(res),
        creatorId: res.locals.user.id,
        completedAt: data.status === "COMPLETED" ? new Date() : null,
        assignees: {
          create: [...new Set(assigneeIds)].map((userId) => ({ userId })),
        },
        checklist: { create: checklist },
      },
      include: taskInclude,
    });
    await activity(res, "task:created", t.title);
    await notify(res, t, `Assigned: ${t.title}`);
    res.status(201).json(t);
  });
  r.get("/:wid/tasks/:tid", async (req, res) =>
    res.json(await task(res, String(req.params.tid))),
  );
  r.patch("/:wid/tasks/:tid", async (req, res) => {
    const existing = await task(res, String(req.params.tid));
    const input = taskInput
      .partial()
      .extend({
        version: z.number().int().positive(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    const merged = {
      ...existing,
      ...input,
      assigneeIds: input.assigneeIds ?? existing.assignees.map((a) => a.userId),
    };
    await validateTask(res, merged);
    if (input.parentId === existing.id)
      fail(400, "A task cannot be its own parent.");
    if (
      input.projectId &&
      input.projectId !== existing.projectId &&
      (existing.parentId ||
        (await db.task.count({ where: { parentId: existing.id } })))
    )
      fail(400, "Move subtasks separately before changing the project.");
    const { version, assigneeIds, checklist, ...rest } = input;
    const t = await db.$transaction(async (tx) => {
      const changed = await tx.task.updateMany({
        where: { id: existing.id, version },
        data: {
          ...rest,
          version: { increment: 1 },
          ...(input.status
            ? {
                completedAt:
                  input.status === "COMPLETED"
                    ? (existing.completedAt ?? new Date())
                    : null,
              }
            : {}),
        },
      });
      if (changed.count !== 1)
        fail(409, "This task changed on another device. Reload and try again.");
      if (assigneeIds) {
        await tx.taskAssignee.deleteMany({ where: { taskId: existing.id } });
        await tx.taskAssignee.createMany({
          data: [...new Set(assigneeIds)].map((userId) => ({
            taskId: existing.id,
            userId,
          })),
        });
      }
      if (checklist) {
        await tx.checklistItem.deleteMany({ where: { taskId: existing.id } });
        await tx.checklistItem.createMany({
          data: checklist.map((x) => ({ ...x, taskId: existing.id })),
        });
      }
      return tx.task.findUniqueOrThrow({
        where: { id: existing.id },
        include: taskInclude,
      });
    });
    await activity(
      res,
      input.status === "COMPLETED" ? "task:completed" : "task:updated",
      t.title,
    );
    await notify(res, t, `Updated: ${t.title}`);
    res.json(t);
  });
  r.delete("/:wid/tasks/:tid", async (req, res) => {
    const t = await task(res, String(req.params.tid));
    if (
      !["OWNER", "ADMIN"].includes(res.locals.member.role) &&
      t.creatorId !== res.locals.user.id
    )
      fail(403, "Only the creator or an administrator can delete this task.");
    await db.task.delete({ where: { id: t.id } });
    await activity(res, "task:deleted", t.title);
    res.json({ ok: true });
  });
  r.get("/:wid/activity", async (req, res) =>
    res.json(
      await db.activity.findMany({
        where: { workspaceId: wid(res) },
        take: 50,
        orderBy: { createdAt: "desc" },
      }),
    ),
  );
  r.get("/:wid/comments", async (req, res) => {
    const q = z
      .object({ taskId: id.optional(), projectId: id.optional() })
      .parse(req.query);
    res.json(
      await db.comment.findMany({
        where: { workspaceId: wid(res), ...q },
        take: 100,
        orderBy: { createdAt: "asc" },
      }),
    );
  });
  r.post("/:wid/comments", async (req, res) => {
    const data = z
      .object({
        body: z.string().trim().min(1).max(10000),
        taskId: id.optional(),
        projectId: id.optional(),
      })
      .parse(req.body);
    if (!data.taskId && !data.projectId)
      fail(400, "Choose a task or project thread.");
    if (data.taskId) await task(res, data.taskId);
    if (data.projectId) await project(res, data.projectId);
    const c = await db.comment.create({
      data: {
        ...data,
        workspaceId: wid(res),
        authorId: res.locals.user.id,
        authorName: res.locals.user.displayName,
      },
    });
    await activity(res, "comment:created", data.body.slice(0, 100));
    if (data.taskId)
      await notify(
        res,
        await task(res, data.taskId),
        `${res.locals.user.displayName} commented on a task`,
      );
    const mentions = [...data.body.matchAll(/@([a-z0-9_]+)/g)].map((x) => x[1]);
    const users = await db.workspaceMember.findMany({
      where: { workspaceId: wid(res), user: { username: { in: mentions } } },
    });
    await db.notification.createMany({
      data: users
        .filter((x) => x.userId !== res.locals.user.id)
        .map((x) => ({
          userId: x.userId,
          workspaceId: wid(res),
          taskId: data.taskId,
          title: `${res.locals.user.displayName} mentioned you`,
        })),
    });
    for (const u of users) io.to(`user:${u.userId}`).emit("invalidate");
    res.status(201).json(c);
  });
  r.patch("/:wid/comments/:cid", async (req, res) => {
    const body = z.string().trim().min(1).max(10000).parse(req.body.body);
    const changed = await db.comment.updateMany({
      where: {
        id: id.parse(req.params.cid),
        workspaceId: wid(res),
        authorId: res.locals.user.id,
      },
      data: { body },
    });
    if (!changed.count) fail(404, "Comment not found.");
    await activity(res, "comment:updated", body.slice(0, 100));
    res.json({ ok: true });
  });
  r.delete("/:wid/comments/:cid", async (req, res) => {
    const result = await db.comment.deleteMany({
      where: {
        id: id.parse(req.params.cid),
        workspaceId: wid(res),
        authorId: res.locals.user.id,
      },
    });
    if (!result.count) fail(404, "Comment not found.");
    await activity(res, "comment:deleted", "Comment");
    res.json({ ok: true });
  });
  r.get("/:wid/notifications", async (req, res) =>
    res.json(
      await db.notification.findMany({
        where: { userId: res.locals.user.id, workspaceId: wid(res) },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ),
  );
  r.post("/:wid/notifications/read", async (req, res) => {
    const data = z.object({ id: id.optional() }).parse(req.body);
    await db.notification.updateMany({
      where: {
        userId: res.locals.user.id,
        workspaceId: wid(res),
        ...(data.id ? { id: data.id } : {}),
      },
      data: { read: true },
    });
    res.json({ ok: true });
  });
  r.get("/:wid/search", async (req, res) => {
    const q = z.string().trim().min(1).max(200).parse(req.query.q);
    const contains = { contains: q, mode: "insensitive" as const };
    const scope = { workspaceId: wid(res) };
    const [tasks, projects, members, files] = await Promise.all([
      db.task.findMany({
        where: { ...scope, archived: false, title: contains },
        select: { id: true, title: true },
        take: 10,
      }),
      db.project.findMany({
        where: { ...scope, name: contains },
        select: { id: true, name: true },
        take: 10,
      }),
      db.workspaceMember.findMany({
        where: {
          ...scope,
          user: { OR: [{ displayName: contains }, { email: contains }] },
        },
        include: { user: { select: userSelect } },
        take: 10,
      }),
      db.attachment.findMany({
        where: { ...scope, confirmed: true, name: contains },
        select: { id: true, name: true, taskId: true },
        take: 10,
      }),
    ]);
    res.json({ tasks, projects, members, files });
  });
  return r;
}
