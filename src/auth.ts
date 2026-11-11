import { Router } from "express";
import argon2 from "argon2";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { db, userSelect } from "./db.js";
import { authenticate, cookieOptions, fail, hash, token } from "./security.js";
import { email, password } from "./validation.js";
export const auth = Router();
const limit = rateLimit({
  windowMs: 900000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
async function issue(
  userId: string,
  device: string,
  native: boolean,
  res: any,
) {
  const raw = token();
  await db.session.create({
    data: {
      userId,
      tokenHash: hash(raw),
      device: device.slice(0, 200),
      expiresAt: new Date(Date.now() + 30 * 86400000),
    },
  });
  if (!native) res.cookie("taskflow_session", raw, cookieOptions());
  res.setHeader("Cache-Control", "no-store");
  return native ? { token: raw } : {};
}
auth.post("/register", limit, async (req, res) => {
  const data = z
    .object({
      username: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9_]{3,32}$/),
      email,
      password,
      confirmPassword: z.string(),
      acceptedTerms: z.literal(true),
      native: z.boolean().default(false),
    })
    .parse(req.body);
  if (data.password !== data.confirmPassword)
    fail(400, "Passwords do not match.");
  const passwordHash = await argon2.hash(data.password, {
    type: argon2.argon2id,
  });
  const user = await db.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        username: data.username,
        email: data.email,
        displayName: data.username,
        passwordHash,
      },
      select: userSelect,
    });
    await tx.workspace.create({
      data: {
        name: `${data.username}'s Workspace`,
        members: { create: { userId: u.id, role: "OWNER" } },
      },
    });
    return u;
  });
  res
    .status(201)
    .json({
      user,
      ...(await issue(
        user.id,
        req.get("user-agent") || "Unknown",
        data.native,
        res,
      )),
    });
});
// A valid Argon2 hash makes unknown-account login cost similar to a known account.
const dummyHash = argon2.hash(token(), { type: argon2.argon2id });
auth.post("/login", limit, async (req, res) => {
  const data = z
    .object({
      email,
      password: z.string().max(128),
      native: z.boolean().default(false),
    })
    .parse(req.body);
  const u = await db.user.findUnique({ where: { email: data.email } });
  const valid = await argon2.verify(
    u?.passwordHash || (await dummyHash),
    data.password,
  );
  if (!u || !valid) fail(401, "Email or password is incorrect.");
  const { passwordHash, platformAdmin, ...user } = u!;
  res.json({
    user,
    ...(await issue(
      user.id,
      req.get("user-agent") || "Unknown",
      data.native,
      res,
    )),
  });
});
auth.get("/me", authenticate, (req, res) => {
  const { platformAdmin, ...user } = res.locals.user;
  res.json(user);
});
auth.post("/logout", authenticate, async (req, res) => {
  await db.session.deleteMany({ where: { id: res.locals.sessionId } });
  res.clearCookie("taskflow_session", cookieOptions());
  res.json({ ok: true });
});
auth.post("/logout-all", authenticate, async (req, res) => {
  await db.session.deleteMany({ where: { userId: res.locals.user.id } });
  res.clearCookie("taskflow_session", cookieOptions());
  res.json({ ok: true });
});
auth.get("/sessions", authenticate, async (req, res) =>
  res.json(
    await db.session.findMany({
      where: { userId: res.locals.user.id, expiresAt: { gt: new Date() } },
      select: { id: true, device: true, createdAt: true, expiresAt: true },
    }),
  ),
);
auth.post("/password", authenticate, async (req, res) => {
  const data = z
    .object({
      currentPassword: z.string(),
      password,
      confirmPassword: z.string(),
    })
    .parse(req.body);
  if (data.password !== data.confirmPassword)
    fail(400, "Passwords do not match.");
  const u = await db.user.findUniqueOrThrow({
    where: { id: res.locals.user.id },
  });
  if (!(await argon2.verify(u.passwordHash, data.currentPassword)))
    fail(400, "Current password is incorrect.");
  await db.$transaction([
    db.user.update({
      where: { id: u.id },
      data: { passwordHash: await argon2.hash(data.password) },
    }),
    db.session.deleteMany({ where: { userId: u.id } }),
    db.auditLog.create({ data: { actorId: u.id, action: "password:changed" } }),
  ]);
  res.clearCookie("taskflow_session", cookieOptions());
  res.json({ ok: true });
});
auth.patch("/profile", authenticate, async (req, res) => {
  const data = z
    .object({
      displayName: z.string().trim().min(1).max(100).optional(),
      username: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9_]{3,32}$/)
        .optional(),
      preferences: z
        .object({
          theme: z.enum(["light", "dark", "system"]).optional(),
          reminders: z.boolean().optional(),
          notifications: z.boolean().optional(),
        })
        .optional(),
    })
    .parse(req.body);
  res.json(
    await db.user.update({
      where: { id: res.locals.user.id },
      data,
      select: userSelect,
    }),
  );
});
export const recovery = Router();
recovery.post("/request", limit, async (req, res) => {
  const data = z
    .object({ email, explanation: z.string().max(2000).default("") })
    .parse(req.body);
  const u = await db.user.findUnique({
    where: { email: data.email },
    select: { id: true },
  });
  await db.recoveryRequest.create({
    data: {
      reference: token(),
      userId: u?.id,
      explanation: data.explanation,
      expiresAt: new Date(Date.now() + 7 * 86400000),
    },
  });
  res
    .status(202)
    .json({
      message:
        "If an account matches the information provided, your recovery request will be reviewed. Please contact your administrator through your organization's established support channel.",
    });
});
async function recoverableIds(userId: string, platformAdmin: boolean) {
  const members = await db.workspaceMember.findMany({
    where: {
      role: { in: ["MEMBER", "VIEWER"] },
      workspace: {
        members: { some: { userId, role: { in: ["OWNER", "ADMIN"] } } },
      },
    },
    select: { userId: true },
  });
  // Never allow workspace admins to reset any owner, admin, or platform operator.
  const users = await db.user.findMany({
    where: {
      id: platformAdmin
        ? { not: userId }
        : { in: members.map((x) => x.userId) },
      platformAdmin: false,
      ...(!platformAdmin
        ? { memberships: { none: { role: { in: ["OWNER", "ADMIN"] } } } }
        : {}),
    },
    select: { id: true },
  });
  return users.map((x) => x.id);
}
recovery.get("/queue", authenticate, async (req, res) => {
  const ids = await recoverableIds(
    res.locals.user.id,
    res.locals.user.platformAdmin,
  );
  res.json(
    await db.recoveryRequest.findMany({
      where: {
        userId: { in: ids },
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        reference: true,
        userId: true,
        explanation: true,
        createdAt: true,
      },
      take: 100,
      orderBy: { createdAt: "asc" },
    }),
  );
});
recovery.post("/:id/approve", authenticate, async (req, res) => {
  const data = z
    .object({
      verificationNotes: z.string().trim().min(30).max(2000),
      verified: z.literal(true),
    })
    .parse(req.body);
  const ids = await recoverableIds(
    res.locals.user.id,
    res.locals.user.platformAdmin,
  );
  const raw = token();
  await db.$transaction(async (tx) => {
    const request = await tx.recoveryRequest.findFirst({
      where: {
        id: String(req.params.id),
        userId: { in: ids },
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
    });
    if (!request) fail(404, "Recovery request not available.");
    const changed = await tx.recoveryRequest.updateMany({
      where: { id: request!.id, status: "PENDING" },
      data: {
        status: "APPROVED",
        reviewedBy: res.locals.user.id,
        reviewedAt: new Date(),
        internalNotes: data.verificationNotes,
      },
    });
    if (changed.count !== 1) fail(409, "Request already reviewed.");
    await tx.resetAuthorization.create({
      data: {
        requestId: request!.id,
        tokenHash: hash(raw),
        expiresAt: new Date(Date.now() + 900000),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: res.locals.user.id,
        action: "recovery:approved",
        targetId: request!.id,
      },
    });
  });
  res
    .set("Cache-Control", "no-store")
    .json({
      authorization: raw,
      message:
        "Deliver once through the independently verified private support channel. Valid for 15 minutes.",
    });
});
recovery.post("/reset", limit, async (req, res) => {
  const data = z
    .object({
      authorization: z.string().min(30).max(100),
      password,
      confirmPassword: z.string(),
    })
    .parse(req.body);
  if (data.password !== data.confirmPassword)
    fail(400, "Passwords do not match.");
  const passwordHash = await argon2.hash(data.password);
  await db.$transaction(async (tx) => {
    const a = await tx.resetAuthorization.findUnique({
      where: { tokenHash: hash(data.authorization) },
      include: { request: true },
    });
    if (!a || a.usedAt || a.expiresAt < new Date() || !a.request.userId)
      fail(400, "Reset authorization is invalid or expired.");
    const used = await tx.resetAuthorization.updateMany({
      where: { id: a!.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1)
      fail(400, "Reset authorization is invalid or expired.");
    await tx.user.update({
      where: { id: a!.request.userId! },
      data: { passwordHash },
    });
    await tx.session.deleteMany({ where: { userId: a!.request.userId! } });
    await tx.recoveryRequest.update({
      where: { id: a!.requestId },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorId: a!.request.userId,
        action: "recovery:completed",
        targetId: a!.requestId,
      },
    });
  });
  res.json({ ok: true });
});
