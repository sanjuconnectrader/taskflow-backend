import { beforeAll, afterAll, describe, it, expect } from "vitest";
import supertest from "supertest";
import { app, io } from "../src/app.js";
import { db } from "../src/db.js";
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
