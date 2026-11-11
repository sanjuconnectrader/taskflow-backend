import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import supertest from "supertest";
import { app, io } from "../src/app.js";
import { db } from "../src/db.js";
import {sendReminders} from '../src/reminders.js';
const api = supertest(app);
const suffix = crypto.randomUUID().slice(0, 8);
const password = "Test-only long passphrase " + suffix;
let owner: any, other: any, viewer: any, wid: string, pid: string, tid: string;
const userIds: string[] = [];
const workspaceIds: string[] = [];
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
async function register(name: string) {
  const r = await api
    .post("/api/v1/auth/register")
    .send({
      username: `${name}_${suffix}`,
      email: `${name}_${suffix}@integration.test`,
      password,
      confirmPassword: password,
      acceptedTerms: true,
      native: true,
    });
  expect(r.status).toBe(201);
  userIds.push(r.body.user.id);
  const memberships = await api
    .get("/api/v1/workspaces")
    .set(auth(r.body.token));
  workspaceIds.push(...memberships.body.map((m: any) => m.workspaceId));
  return r.body;
}
beforeAll(async () => {
  owner = await register("owner");
  other = await register("other");
  viewer = await register("viewer");
  wid = workspaceIds[0];
});
afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await db.recoveryRequest.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  io.close();
  await db.$disconnect();
});
describe("real PostgreSQL API", () => {
  it("only announces complete published releases and protects mobile download tickets", async () => {
    const originalFetch=globalThis.fetch;
    const release={tag_name:'v2.0.0',draft:false,prerelease:false,assets:[{id:7,name:'app-release.apk',size:3}]};
    vi.stubGlobal('fetch',vi.fn(async (url:string) => url.endsWith('/releases/latest') ? new Response(JSON.stringify(release),{status:200,headers:{'content-type':'application/json'}}) : new Response('apk',{status:200,headers:{'content-type':'application/octet-stream'}})));
    try {
      const latest=await api.get('/api/v1/updates/mobile').set(auth(owner.token));
      expect(latest.status).toBe(200);expect(latest.body.version).toBe('2.0.0');
      expect((await api.post('/api/v1/updates/mobile/ticket').send({})).status).toBe(401);
      const ticket=await api.post('/api/v1/updates/mobile/ticket').set(auth(owner.token)).send({});
      expect(ticket.status).toBe(200);
      const downloaded=await api.get(ticket.body.path);expect(downloaded.status).toBe(200);
      expect((await api.get(ticket.body.path)).status).toBe(404);
      release.prerelease=true;
      expect((await api.get('/api/v1/updates/desktop').set(auth(owner.token))).status).toBe(503);
    } finally {vi.stubGlobal('fetch',originalFetch);}
  });
  it("creates a company and its owner atomically", async () => {
    const response = await api.post('/api/v1/auth/register').send({username:`company_${suffix}`, email:`company_${suffix}@integration.test`, password, confirmPassword:password, acceptedTerms:true, native:true, fullName:'Company Owner', designation:'Director', company:{name:'Example Company',email:`business_${suffix}@integration.test`,timezone:'Asia/Kolkata'}});
    expect(response.status).toBe(201);
    userIds.push(response.body.user.id);
    const memberships = await api.get('/api/v1/workspaces').set(auth(response.body.token));
    expect(memberships.body).toHaveLength(1);
    expect(memberships.body[0].role).toBe('OWNER');
    expect(memberships.body[0].workspace.name).toBe('Example Company');
    expect(memberships.body[0].workspace.timezone).toBe('Asia/Kolkata');
    workspaceIds.push(memberships.body[0].workspaceId);
    const duplicate = await api.post('/api/v1/auth/register').send({username:`company2_${suffix}`,email:`company_${suffix}@integration.test`,password,confirmPassword:password,acceptedTerms:true,company:{name:'Should not exist',email:`business_${suffix}@integration.test`,timezone:'Asia/Kolkata'}});
    expect(duplicate.status).toBe(409);
    expect(await db.workspace.count({where:{name:'Should not exist'}})).toBe(0);
  });
  it("enforces temporary-password setup and rotates the session", async () => {
    const created = await api.post(`/api/v1/workspaces/${wid}/employees`).set(auth(owner.token)).send({fullName: "New Employee", email: `employee_${suffix}@integration.test`, designation: "Developer", department: "Engineering"});
    expect(created.status).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    userIds.push(created.body.member.userId);
    const stored=await db.user.findUniqueOrThrow({where:{id:created.body.member.userId},select:{passwordHash:true}});
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);expect(stored.passwordHash).not.toContain(created.body.temporaryPassword);
    const login = await api.post('/api/v1/auth/login').send({email: `employee_${suffix}@integration.test`, password: created.body.temporaryPassword, native: true});
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    expect((await api.get('/api/v1/workspaces').set(auth(login.body.token))).status).toBe(403);
    const changed = await api.post('/api/v1/auth/password').set(auth(login.body.token)).send({currentPassword: created.body.temporaryPassword, password, confirmPassword: password});
    expect(changed.status).toBe(200);
    expect(changed.body.token).toBeTruthy();
    expect((await api.get('/api/v1/workspaces').set(auth(login.body.token))).status).toBe(401);
    expect((await api.get('/api/v1/workspaces').set(auth(changed.body.token))).status).toBe(200);
    const privateProject=await api.post(`/api/v1/workspaces/${wid}/projects`).set(auth(owner.token)).send({name:'Restricted project'});
    const privateTask=await api.post(`/api/v1/workspaces/${wid}/tasks`).set(auth(owner.token)).send({title:'Secret task',projectId:privateProject.body.id,assigneeIds:[owner.user.id]});
    const privateFile=await db.attachment.create({data:{workspaceId:wid,taskId:privateTask.body.id,uploaderId:owner.user.id,name:'secret.txt',key:`test/${crypto.randomUUID()}`,mime:'text/plain',size:1,confirmed:true}});
    expect((await api.get(`/api/v1/workspaces/${wid}/tasks/${privateTask.body.id}`).set(auth(changed.body.token))).status).toBe(404);
    expect((await api.get(`/api/v1/workspaces/${wid}/tasks`).set(auth(changed.body.token))).body.items).toHaveLength(0);
    expect((await api.get(`/api/v1/workspaces/${wid}/projects`).set(auth(changed.body.token))).body).toHaveLength(0);
    expect((await api.get(`/api/v1/workspaces/${wid}/search?q=Secret`).set(auth(changed.body.token))).body.tasks).toHaveLength(0);
    expect((await api.get(`/api/v1/files/${wid}`).set(auth(changed.body.token))).body.items).toHaveLength(0);
    expect((await api.get(`/api/v1/files/${wid}/${privateFile.id}/download`).set(auth(changed.body.token))).status).toBe(404);
    expect((await api.get(`/api/v1/reports/${wid}?today=2026-11-11`).set(auth(changed.body.token))).body.total).toBe(0);
    const assigned=await api.patch(`/api/v1/workspaces/${wid}/tasks/${privateTask.body.id}`).set(auth(owner.token)).send({version:privateTask.body.version,assigneeIds:[created.body.member.userId],requiresReview:true});
    expect(assigned.status).toBe(200);
    const restrictedProject=await api.patch(`/api/v1/workspaces/${wid}/projects/${privateProject.body.id}`).set(auth(owner.token)).send({memberIds:[created.body.member.userId]});
    expect(restrictedProject.status).toBe(200);
    expect((await api.post(`/api/v1/workspaces/${wid}/tasks`).set(auth(owner.token)).send({title:'Invalid assignment',projectId:privateProject.body.id,assigneeIds:[owner.user.id]})).status).toBe(400);
    expect((await api.get(`/api/v1/workspaces/${wid}/projects`).set(auth(changed.body.token))).body).toHaveLength(1);
    expect((await api.get(`/api/v1/workspaces/${wid}/tasks/${privateTask.body.id}`).set(auth(changed.body.token))).status).toBe(200);
    expect((await api.patch(`/api/v1/workspaces/${wid}/tasks/${privateTask.body.id}`).set(auth(changed.body.token)).send({version:assigned.body.version,title:'Changed title'})).status).toBe(403);
    const submitted=await api.patch(`/api/v1/workspaces/${wid}/tasks/${privateTask.body.id}`).set(auth(changed.body.token)).send({version:assigned.body.version,status:'COMPLETED'});
    expect(submitted.status).toBe(200);expect(submitted.body.status).toBe('IN_REVIEW');
    await api.delete(`/api/v1/workspaces/${wid}/projects/${privateProject.body.id}`).set(auth(owner.token));
    expect((await api.post('/api/v1/auth/login').send({email: `employee_${suffix}@integration.test`, password: created.body.temporaryPassword})).status).toBe(401);
    const denied = await api.post(`/api/v1/workspaces/${wid}/employees/${created.body.member.userId}/reset-password`).set(auth(other.token)).send({identityVerified:true,verificationNote:'Verified in person'});
    expect(denied.status).toBe(403);
    const reset = await api.post(`/api/v1/workspaces/${wid}/employees/${created.body.member.userId}/reset-password`).set(auth(owner.token)).send({identityVerified:true,verificationNote:'Verified in person'});
    expect(reset.status).toBe(200);
    expect((await api.get('/api/v1/workspaces').set(auth(changed.body.token))).status).toBe(401);
    expect((await db.auditLog.count({where:{targetId:created.body.member.userId,action:'employee:password-reset'}}))).toBe(1);
  });
  it('scopes project manager operations and reports to assigned projects',async()=>{
    const created=await api.post(`/api/v1/workspaces/${wid}/employees`).set(auth(owner.token)).send({fullName:'Manager',email:`manager_${suffix}@integration.test`,role:'PROJECT_MANAGER'});
    expect(created.status).toBe(201);userIds.push(created.body.member.userId);
    const login=await api.post('/api/v1/auth/login').send({email:`manager_${suffix}@integration.test`,password:created.body.temporaryPassword,native:true});
    const changed=await api.post('/api/v1/auth/password').set(auth(login.body.token)).send({currentPassword:created.body.temporaryPassword,password,confirmPassword:password});
    const managed=await api.post(`/api/v1/workspaces/${wid}/projects`).set(auth(owner.token)).send({name:'Managed',memberIds:[created.body.member.userId]});
    const hidden=await api.post(`/api/v1/workspaces/${wid}/projects`).set(auth(owner.token)).send({name:'Not managed',memberIds:[owner.user.id]});
    expect((await api.patch(`/api/v1/workspaces/${wid}/projects/${hidden.body.id}`).set(auth(changed.body.token)).send({name:'Unauthorized'})).status).toBe(404);
    expect((await api.post(`/api/v1/workspaces/${wid}/tasks`).set(auth(changed.body.token)).send({title:'Hidden write',projectId:hidden.body.id})).status).toBe(404);
    expect((await api.post(`/api/v1/workspaces/${wid}/tasks`).set(auth(changed.body.token)).send({title:'Managed work',projectId:managed.body.id,assigneeIds:[created.body.member.userId]})).status).toBe(201);
    await api.post(`/api/v1/workspaces/${wid}/tasks`).set(auth(owner.token)).send({title:'Hidden work',projectId:hidden.body.id,assigneeIds:[owner.user.id]});
    expect((await api.get(`/api/v1/reports/${wid}?today=2026-11-11`).set(auth(changed.body.token))).body.total).toBe(1);
    expect((await api.get(`/api/v1/workspaces/${wid}/tasks`).set(auth(changed.body.token))).body.items).toHaveLength(1);
    await api.delete(`/api/v1/workspaces/${wid}/projects/${managed.body.id}`).set(auth(owner.token));
    await api.delete(`/api/v1/workspaces/${wid}/projects/${hidden.body.id}`).set(auth(owner.token));
  });
  it('uses the company time zone and deduplicates deadline notifications',async()=>{
    await db.workspace.update({where:{id:wid},data:{timezone:'Asia/Kolkata'}});
    const p=await api.post(`/api/v1/workspaces/${wid}/projects`).set(auth(owner.token)).send({name:'Reminder project'});
    const task=await api.post(`/api/v1/workspaces/${wid}/tasks`).set(auth(owner.token)).send({title:'Reminder task',projectId:p.body.id,assigneeIds:[owner.user.id],dueDate:'2026-11-11'});
    const alerts:string[]=[];const now=new Date('2026-11-10T20:00:00Z');
    await sendReminders(now,userId=>alerts.push(userId));await sendReminders(now,userId=>alerts.push(userId));
    expect(await db.notification.count({where:{taskId:task.body.id,title:'Due today: Reminder task'}})).toBe(1);
    expect(alerts.filter(userId=>userId===owner.user.id)).toHaveLength(1);
    await api.delete(`/api/v1/workspaces/${wid}/projects/${p.body.id}`).set(auth(owner.token));
    await db.workspace.update({where:{id:wid},data:{timezone:'UTC'}});
  });
  it("authenticates with email and rejects unknown passwords", async () => {
    expect(
      (
        await api
          .post("/api/v1/auth/login")
          .send({ email: owner.user.email, password: "wrong" })
      ).status,
    ).toBe(401);
    expect(
      (
        await api
          .post("/api/v1/auth/login")
          .send({ email: owner.user.email, password, native: true })
      ).status,
    ).toBe(200);
  });
  it("denies another workspace before exposing data", async () => {
    expect(
      (await api.get(`/api/v1/workspaces/${wid}/tasks`).set(auth(other.token)))
        .status,
    ).toBe(403);
  });
  it("creates a project and task persisted in PostgreSQL", async () => {
    const p = await api
      .post(`/api/v1/workspaces/${wid}/projects`)
      .set(auth(owner.token))
      .send({ name: "Integration project" });
    expect(p.status).toBe(201);
    pid = p.body.id;
    const t = await api
      .post(`/api/v1/workspaces/${wid}/tasks`)
      .set(auth(owner.token))
      .send({
        title: "Persist me",
        projectId: pid,
        assigneeIds: [owner.user.id],
        dueDate: "2026-11-11",
      });
    expect(t.status).toBe(201);
    tid = t.body.id;
    expect((await db.task.findUnique({ where: { id: tid } }))?.title).toBe(
      "Persist me",
    );
  });
  it("enforces viewer role and foreign-project boundaries", async () => {
    expect(
      (
        await api
          .post(`/api/v1/workspaces/${wid}/members`)
          .set(auth(owner.token))
          .send({ email: viewer.user.email, role: "VIEWER" })
      ).status,
    ).toBe(201);
    expect(
      (
        await api
          .post(`/api/v1/workspaces/${wid}/tasks`)
          .set(auth(viewer.token))
          .send({ title: "Forbidden", projectId: pid })
      ).status,
    ).toBe(403);
    const p = await api
      .post(`/api/v1/workspaces/${workspaceIds[1]}/projects`)
      .set(auth(other.token))
      .send({ name: "Private" });
    expect(
      (
        await api
          .post(`/api/v1/workspaces/${wid}/tasks`)
          .set(auth(owner.token))
          .send({ title: "Foreign", projectId: p.body.id })
      ).status,
    ).toBe(404);
  });
  it("persists board moves and rejects stale versions", async () => {
    const t = await api
      .patch(`/api/v1/workspaces/${wid}/tasks/${tid}`)
      .set(auth(owner.token))
      .send({ status: "COMPLETED", version: 1 });
    expect(t.status).toBe(200);
    expect(t.body.completedAt).toBeTruthy();
    expect(
      (
        await api
          .patch(`/api/v1/workspaces/${wid}/tasks/${tid}`)
          .set(auth(owner.token))
          .send({ status: "TODO", version: 1 })
      ).status,
    ).toBe(409);
    const get = await api
      .get(`/api/v1/workspaces/${wid}/tasks/${tid}`)
      .set(auth(owner.token));
    expect(get.body.status).toBe("COMPLETED");
  });
  it("persists comments and prevents editing another author", async () => {
    const c = await api
      .post(`/api/v1/workspaces/${wid}/comments`)
      .set(auth(owner.token))
      .send({ taskId: tid, body: "A real comment" });
    expect(c.status).toBe(201);
    expect(
      (
        await api
          .patch(`/api/v1/workspaces/${wid}/comments/${c.body.id}`)
          .set(auth(other.token))
          .send({ body: "Hijack" })
      ).status,
    ).toBe(403);
  });
  it("computes metrics from scoped records and exports CSV", async () => {
    const r = await api
      .get(`/api/v1/reports/${wid}?today=2026-11-11`)
      .set(auth(owner.token));
    expect(r.body.total).toBe(1);
    expect(r.body.completed).toBe(1);
    expect(r.body.completionRate).toBe(100);
    const csv = await api
      .get(`/api/v1/reports/${wid}?today=2026-11-11&format=csv`)
      .set(auth(owner.token));
    expect(csv.text).toContain("Persist me");
  });
  it("rejects cookie mutations lacking CSRF headers and hostile origins", async () => {
    const l = await api
      .post("/api/v1/auth/login")
      .send({ email: owner.user.email, password });
    const cookie = l.headers["set-cookie"][0].split(";")[0];
    expect(
      (await api.post("/api/v1/auth/logout").set("Cookie", cookie).send({}))
        .status,
    ).toBe(403);
    expect(
      (
        await api
          .post("/api/v1/auth/logout")
          .set("Cookie", cookie)
          .set("Origin", "https://evil.test")
          .set("X-TaskFlow-Request", "1")
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await api
          .post("/api/v1/auth/logout")
          .set("Cookie", cookie)
          .set("Origin", "http://localhost:3000")
          .set("X-TaskFlow-Request", "1")
          .send({})
      ).status,
    ).toBe(200);
  });
  it("does not enumerate recovery accounts and enforces verification", async () => {
    const known = await api
      .post("/api/v1/recovery/request")
      .send({ email: other.user.email });
    const unknown = await api
      .post("/api/v1/recovery/request")
      .send({ email: `unknown_${suffix}@integration.test` });
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    await db.recoveryRequest.deleteMany({ where: { userId: null } });
    const request = await db.recoveryRequest.findFirstOrThrow({
      where: { userId: other.user.id },
    });
    expect(
      (
        await api
          .post(`/api/v1/recovery/${request.id}/approve`)
          .set(auth(owner.token))
          .send({
            verified: true,
            verificationNotes:
              "Independently verified through established contact.",
          })
      ).status,
    ).toBe(404);
    await db.user.update({
      where: { id: owner.user.id },
      data: { platformAdmin: true },
    });
    const approved = await api
      .post(`/api/v1/recovery/${request.id}/approve`)
      .set(auth(owner.token))
      .send({
        verified: true,
        verificationNotes:
          "Independently verified through established operator contact.",
      });
    expect(approved.status).toBe(200);
    const reset = await api
      .post("/api/v1/recovery/reset")
      .send({
        authorization: approved.body.authorization,
        password: password + " reset",
        confirmPassword: password + " reset",
      });
    expect(reset.status).toBe(200);
    expect(
      (await api.get("/api/v1/auth/me").set(auth(other.token))).status,
    ).toBe(401);
    expect(
      (
        await api
          .post("/api/v1/recovery/reset")
          .send({
            authorization: approved.body.authorization,
            password,
            confirmPassword: password,
          })
      ).status,
    ).toBe(400);
  });
  it("revokes all sessions", async () => {
    expect(
      (
        await api
          .post("/api/v1/auth/logout-all")
          .set(auth(owner.token))
          .send({})
      ).status,
    ).toBe(200);
    expect(
      (await api.get("/api/v1/auth/me").set(auth(owner.token))).status,
    ).toBe(401);
  });
});
