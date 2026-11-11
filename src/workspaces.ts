import { Router } from "express";
import { z } from "zod";
import { db, taskInclude, taskListSelect, userSelect } from "./db.js";
import { authenticate, fail, membership, restrictedEmployee, projectManager, projectScoped, projectAccess as scopedProjects, taskAccess } from "./security.js";
import { id, projectInput, taskInput } from "./validation.js";
import type { Server } from "socket.io";
import type {Prisma} from '@prisma/client';
import argon2 from "argon2";
import { token } from "./security.js";
import { email, dateValue } from "./validation.js";
export function workspaceRoutes(io: Server) {
  const r = Router();
  r.use(authenticate);
  r.get("/", async (req, res) =>
    res.json(
      await db.workspaceMember.findMany({
        where: { userId: res.locals.user.id, employmentStatus:'ACTIVE' },
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
  const projectAccess = (res:any) => scopedProjects(res.locals.member,res.locals.user.id);
  const project = async (res: any, pid: string) => {
    const p = await db.project.findFirst({
      where: { id: id.parse(pid), workspaceId: wid(res), ...projectAccess(res) },
    });
    if (!p) fail(404, "Project not found.");
    return p!;
  };
  const task = async (res: any, tid: string) => {
    const t = await db.task.findFirst({
      where: { id: id.parse(tid), workspaceId: wid(res), ...taskAccess(res.locals.member,res.locals.user.id) },
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
        companyEmail: z.union([email,z.literal('')]).optional(),
        phone: z.string().trim().max(40).optional(),
        website: z.union([z.url().refine(value=>/^https?:\/\//i.test(value)),z.literal('')]).optional(),
        address: z.string().trim().max(500).optional(),
        industry: z.string().trim().max(100).optional(),
        companySize: z.string().trim().max(40).optional(),
        timezone: z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}}).optional(),
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
        where: { workspaceId: wid(res), ...(restrictedEmployee(res.locals.member) ? {userId:res.locals.user.id} : {}) },
        include: { user: { select: userSelect } },
      }),
    ),
  );
  // A new employee is created and attached to exactly this company atomically.
  // Existing accounts are never overwritten or silently added to another company.
  r.post("/:wid/employees", async (req, res) => {
    await admin(res);
    const data = z.object({
      fullName: z.string().trim().min(1).max(100), email,
      designation: z.string().trim().max(100).optional(),
      department: z.string().trim().max(100).optional(),
      phone: z.string().trim().max(40).optional(),
      joiningDate: dateValue.optional(),
      employmentStatus: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
      role: z.enum(["EMPLOYEE", "PROJECT_MANAGER", "TEAM_LEAD"]).default("EMPLOYEE"),
    }).parse(req.body);
    const temporaryPassword = token();
    const passwordHash = await argon2.hash(temporaryPassword, {type: argon2.argon2id});
    const member = await db.$transaction(async tx => {
      const user = await tx.user.create({data: {
        username: `employee_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        displayName: data.fullName, email: data.email, passwordHash, mustChangePassword: true,
      }, select: userSelect});
      const result = await tx.workspaceMember.create({data: {
        workspaceId: wid(res), userId: user.id, role: data.role,
        employeeId: `EMP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        designation: data.designation, department: data.department, phone: data.phone,
        joiningDate: data.joiningDate, employmentStatus: data.employmentStatus,
      }, include: {user: {select: userSelect}}});
      await tx.auditLog.create({data: {actorId: res.locals.user.id, action: "employee:created", targetId: user.id, metadata: {workspaceId: wid(res)}}});
      return result;
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({member, temporaryPassword});
  });
  r.post("/:wid/employees/:uid/reset-password", async (req, res) => {
    await admin(res);
    const targetId = id.parse(req.params.uid);
    const verification = z.object({identityVerified: z.literal(true), verificationNote: z.string().trim().min(8).max(500)}).parse(req.body);
    const temporaryPassword = token();
    const passwordHash = await argon2.hash(temporaryPassword, {type: argon2.argon2id});
    await db.$transaction(async tx => {
      const member = await tx.workspaceMember.findUnique({where: {workspaceId_userId: {workspaceId: wid(res), userId: targetId}}});
      const privileged = await tx.workspaceMember.findFirst({where: {userId: targetId, role: {in: ["OWNER", "ADMIN"]}}});
      const otherCompany = await tx.workspaceMember.findFirst({where: {userId: targetId, workspaceId: {not: wid(res)}}});
      const target = await tx.user.findUnique({where: {id: targetId}, select: {platformAdmin: true}});
      if (!member || !target || target.platformAdmin || privileged || otherCompany || targetId === res.locals.user.id) fail(403, "This account cannot be reset by a company administrator.");
      await tx.user.update({where: {id: targetId}, data: {passwordHash, mustChangePassword: true}});
      await tx.session.deleteMany({where: {userId: targetId}});
      await tx.auditLog.create({data: {actorId: res.locals.user.id, action: "employee:password-reset", targetId, metadata: {workspaceId: wid(res), verificationNote: verification.verificationNote}}});
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({temporaryPassword});
  });
  r.post("/:wid/members", async (req, res) => {
    await admin(res);
    const data = z
      .object({
        email: z.email().toLowerCase(),
        role: z.enum(["ADMIN", "MEMBER", "VIEWER", "PROJECT_MANAGER", "TEAM_LEAD", "EMPLOYEE"]).default("MEMBER"),
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
    const role = z.enum(["ADMIN", "MEMBER", "VIEWER", "PROJECT_MANAGER", "TEAM_LEAD", "EMPLOYEE"]).parse(req.body.role);
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
        where: { workspaceId: wid(res), ...projectAccess(res) },
        include: { _count: { select: { tasks: true } }, members:{select:{userId:true}} },
        orderBy: { createdAt: "desc" },
      }),
    ),
  );
  r.post("/:wid/projects", async (req, res) => {
    if(res.locals.member.role !== 'PROJECT_MANAGER') await admin(res);
    const {memberIds,...data} = projectInput.extend({memberIds:z.array(id).max(200).optional()}).parse(req.body);
    const members=[...new Set([...(memberIds||[]),...(res.locals.member.role==='PROJECT_MANAGER'?[res.locals.user.id]:[])])];
    if(await db.workspaceMember.count({where:{workspaceId:wid(res),employmentStatus:'ACTIVE',userId:{in:members}}})!==members.length) fail(400,'Project members must be active company members.');
    const p = await db.project.create({
      data: { ...data, workspaceId: wid(res), restrictMembership:memberIds!==undefined || res.locals.member.role==='PROJECT_MANAGER', members:{create:members.map(userId=>({member:{connect:{workspaceId_userId:{workspaceId:wid(res),userId}}}}))} },
    });
    const recipients=members.filter(userId=>userId!==res.locals.user.id);
    await db.notification.createMany({data:recipients.map(userId=>({userId,workspaceId:wid(res),projectId:p.id,title:`Assigned to project: ${p.name}`,message:p.name,type:'PROJECT_ASSIGNED'}))});
    for(const userId of recipients) io.to(`user:${userId}`).emit('notification',{title:`Assigned to project: ${p.name}`,message:p.name,type:'PROJECT_ASSIGNED',projectId:p.id});
    await activity(res, "project:created", p.name);
    res.status(201).json(p);
  });
  r.patch("/:wid/projects/:pid", async (req, res) => {
    if (res.locals.member.role !== 'PROJECT_MANAGER') await admin(res);
    await project(res, String(req.params.pid));
    const parsed = projectInput
      .partial()
      .extend({ archived: z.boolean().optional(), memberIds:z.array(id).max(200).optional() })
      .parse(req.body);
    const data = Object.fromEntries(Object.entries(parsed).filter(([key])=>Object.hasOwn(req.body,key))) as typeof parsed;
    const {memberIds,...fields}=data;
    const previously=memberIds?await db.projectMember.findMany({where:{projectId:String(req.params.pid)},select:{userId:true}}):[];
    const p = await db.$transaction(async tx=>{
      if(memberIds){
        const members=[...new Set(memberIds)];
        if(await tx.workspaceMember.count({where:{workspaceId:wid(res),employmentStatus:'ACTIVE',userId:{in:members}}})!==members.length) fail(400,'Project members must be active company members.');
        const outstanding=await tx.taskAssignee.count({where:{task:{projectId:String(req.params.pid)},userId:{notIn:members}}});
        if(outstanding) fail(409,'Reassign tasks before removing their employees from the project.');
        await tx.projectMember.deleteMany({where:{projectId:String(req.params.pid)}});
        await tx.projectMember.createMany({data:members.map(userId=>({projectId:String(req.params.pid),workspaceId:wid(res),userId}))});
      }
      return tx.project.update({where:{id:String(req.params.pid)},data:{...fields,...(memberIds?{restrictMembership:true}:{})}});
    });
    if(memberIds){const existing=new Set(previously.map(m=>m.userId));const added=[...new Set(memberIds)].filter(userId=>!existing.has(userId)&&userId!==res.locals.user.id);await db.notification.createMany({data:added.map(userId=>({userId,workspaceId:wid(res),projectId:p.id,title:`Assigned to project: ${p.name}`,message:p.name,type:'PROJECT_ASSIGNED'}))});for(const userId of added)io.to(`user:${userId}`).emit('notification',{title:`Assigned to project: ${p.name}`,message:p.name,type:'PROJECT_ASSIGNED',projectId:p.id});}
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
          .enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "COMPLETED", "CANCELLED"])
          .optional(),
        archived: z.enum(["true", "false"]).default("false"),
        assigneeId: id.optional(),
        summary:z.enum(['true','false']).default('false'),
      })
      .parse(req.query);
    const where = {
      workspaceId: wid(res),
      ...(projectScoped(res.locals.member) ? {AND:[taskAccess(res.locals.member,res.locals.user.id)]} : {}),
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
    if(q.summary==='false'){
      const [items,total]=await db.$transaction([db.task.findMany({where,include:taskInclude,orderBy:[{dueDate:'asc'},{createdAt:'desc'}],skip:(q.page-1)*q.limit,take:q.limit}),db.task.count({where})]);
      res.json({items,total,page:q.page,limit:q.limit});return;
    }
    const [items, total] = await db.$transaction([
      db.task.findMany({
        where,
        select: taskListSelect,
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      db.task.count({ where }),
    ]);
    const counts=await db.checklistItem.groupBy({by:['taskId','done'],where:{taskId:{in:items.map(item=>item.id)}},_count:{_all:true}});
    res.json({ items:items.map(item=>{const groups=counts.filter(c=>c.taskId===item.id);return {...item,checklistSummary:{total:item._count.checklist,completed:groups.filter(c=>c.done).reduce((sum,c)=>sum+c._count._all,0)}};}), total, page: q.page, limit: q.limit });
  });
  async function validateTask(res: any, data: any) {
    const p = await project(res, data.projectId);
    if (p.archived) fail(400, "Project is archived.");
    if (data.startDate && data.dueDate && data.startDate > data.dueDate)
      fail(400, "Start date must precede due date.");
    const count = await db.workspaceMember.count({
      where: {
        workspaceId: wid(res),
        employmentStatus:'ACTIVE',
        userId: { in: [...new Set<string>(data.assigneeIds)] },
      },
    });
    if (count !== new Set(data.assigneeIds).size)
      fail(400, "Assignees must belong to this workspace.");
    if(p.restrictMembership && await db.projectMember.count({where:{projectId:p.id,userId:{in:[...new Set<string>(data.assigneeIds)]}}})!==new Set(data.assigneeIds).size) fail(400,'Assignees must be members of this project.');
    if (data.parentId) {
      const parent = await task(res, data.parentId);
      if (parent.projectId !== data.projectId || parent.parentId)
        fail(400, "Subtasks must share the parent project and have one level.");
    }
  }
  async function notify(res: any, t: any, title: string) {
    const targets = t.assignees
      .filter((a:any)=>a.user?.preferences?.notifications!==false)
      .map((a: any) => a.userId)
      .filter((u: string) => u !== res.locals.user.id);
    const type=t.status==='IN_REVIEW'?'TASK_SUBMITTED':title.startsWith('Assigned:')?'TASK_ASSIGNED':'TASK_UPDATED';
    const created=await db.notification.createMany({data:targets.map((userId:string)=>({userId,workspaceId:wid(res),title,message:t.title,type,taskId:t.id}))});
    if(created.count) for (const uid of targets) io.to(`user:${uid}`).emit("notification",{title,message:t.title,type,taskId:t.id});
  }
  r.post("/:wid/tasks", async (req, res) => {
    if (restrictedEmployee(res.locals.member)) fail(403, "Only managers may create tasks.");
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
    const parsed = taskInput
      .partial()
      .extend({
        version: z.number().int().positive(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    // Zod defaults also apply inside partial objects; PATCH must not reset
    // omitted descriptions, assignees, checklists, or other existing values.
    const input = Object.fromEntries(Object.entries(parsed).filter(([key])=>Object.hasOwn(req.body,key))) as typeof parsed;
    if (restrictedEmployee(res.locals.member) && Object.keys(input).some(key => !['version','status','checklist'].includes(key))) fail(403, 'Employees may update task status and checklist progress only.');
    if (restrictedEmployee(res.locals.member) && input.checklist && (input.checklist.length !== existing.checklist.length || input.checklist.some((item,i)=>item.text!==existing.checklist[i].text))) fail(403, 'Employees cannot change checklist items.');
    if (restrictedEmployee(res.locals.member) && input.status === 'CANCELLED') fail(403, 'Employees cannot cancel tasks.');
    if (restrictedEmployee(res.locals.member) && existing.status === 'IN_REVIEW' && input.status && input.status !== 'IN_REVIEW') fail(403, 'A reviewer must approve or return this task.');
    if (restrictedEmployee(res.locals.member) && existing.requiresReview && input.status === 'COMPLETED') input.status = 'IN_REVIEW';
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
      !["OWNER", "ADMIN", "PROJECT_MANAGER"].includes(res.locals.member.role) &&
      t.creatorId !== res.locals.user.id
    )
      fail(403, "Only the creator or an administrator can delete this task.");
    await db.task.delete({ where: { id: t.id } });
    await activity(res, "task:deleted", t.title);
    res.json({ ok: true });
  });
  r.get("/:wid/activity", async (req, res) =>
    res.json(
      projectScoped(res.locals.member) ? [] : await db.activity.findMany({
        where: { workspaceId: wid(res) },
        take: 50,
        orderBy: { createdAt: "desc" },
      }),
    ),
  );
  r.get("/:wid/comments", async (req, res) => {
    const q = z
      .object({ taskId: id.optional(), projectId: id.optional(),cursor:id.optional(),limit:z.coerce.number().int().min(1).max(100).default(50),paged:z.enum(['true','false']).default('false') })
      .parse(req.query);
    if (projectScoped(res.locals.member)) {
      if(q.taskId) await task(res,q.taskId);
      else if(q.projectId) await project(res,q.projectId);
      else fail(403,'Choose an assigned task or project.');
    }
    const marker=q.cursor?await db.comment.findFirst({where:{id:q.cursor,workspaceId:wid(res)},select:{id:true,createdAt:true}}):null;if(q.cursor&&!marker)fail(404,'Comment cursor not found.');
    const rows=await db.comment.findMany({where:{workspaceId:wid(res),...(q.taskId?{taskId:q.taskId}:projectScoped(res.locals.member)?{taskId:null}:{}),...(q.projectId?{projectId:q.projectId}:{}),...(marker?{OR:[{createdAt:{gt:marker.createdAt}},{createdAt:marker.createdAt,id:{gt:marker.id}}]}:{})},select:{id:true,workspaceId:true,taskId:true,projectId:true,authorId:true,authorName:true,body:true,createdAt:true,updatedAt:true},take:q.paged==='true'?q.limit+1:100,orderBy:[{createdAt:'asc'},{id:'asc'}]});
    if(q.paged==='false'){res.json(rows);return;}const items=rows.slice(0,q.limit);res.json({items,nextCursor:rows.length>q.limit?items[items.length-1].id:null});
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
    await activity(res, "comment:created", data.taskId?'Task discussion':'Project discussion');
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
          title: `${res.locals.user.displayName} mentioned you`,message:data.body.slice(0,200),type:'MENTION',
        })),
    });
    for (const u of users) io.to(`user:${u.userId}`).emit("notification",{title:`${res.locals.user.displayName} mentioned you`,message:data.body.slice(0,200),type:'MENTION',taskId:data.taskId,projectId:data.projectId});
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
    await activity(res, "comment:updated", 'Discussion comment');
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
  r.get("/:wid/notifications", async (req, res) => {
      const rows = await db.notification.findMany({
        where: { userId: res.locals.user.id, workspaceId: wid(res) },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      if (!projectScoped(res.locals.member)) {res.json(rows);return;}
      const visible = await db.task.findMany({where:{workspaceId:wid(res),id:{in:rows.flatMap(row=>row.taskId?[row.taskId]:[])},...taskAccess(res.locals.member,res.locals.user.id)},select:{id:true}});
      const ids=new Set(visible.map(item=>item.id));
      const projects=await db.project.findMany({where:{workspaceId:wid(res),id:{in:rows.flatMap(row=>row.projectId?[row.projectId]:[])},...projectAccess(res)},select:{id:true}});
      const projectIds=new Set(projects.map(item=>item.id));
      res.json(rows.filter(row=>(row.taskId && ids.has(row.taskId)) || (row.projectId && projectIds.has(row.projectId))));
  });
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
    const restricted = restrictedEmployee(res.locals.member);
    const [tasks, projects, members, files] = await Promise.all([
      db.task.findMany({
        where: { ...scope, archived: false, title: contains, ...taskAccess(res.locals.member,res.locals.user.id) },
        select: { id: true, title: true },
        take: 10,
      }),
      db.project.findMany({
        where: { ...scope, name: contains, ...projectAccess(res) },
        select: { id: true, name: true },
        take: 10,
      }),
      db.workspaceMember.findMany({
        where: {
          ...scope,
          ...(restricted ? {userId:res.locals.user.id} : {}),
          user: { OR: [{ displayName: contains }, { email: contains }] },
        },
        include: { user: { select: userSelect } },
        take: 10,
      }),
      db.attachment.findMany({
        where: { ...scope, confirmed: true, name: contains, ...(projectScoped(res.locals.member) ? {task:taskAccess(res.locals.member,res.locals.user.id)} : {}) },
        select: { id: true, name: true, taskId: true },
        take: 10,
      }),
    ]);
    res.json({ tasks, projects, members, files });
  });
  return r;
}
