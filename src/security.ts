import { createHash, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db, userSelect } from "./db.js";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
export const origins = (
  process.env.CORS_ALLOWED_ORIGINS || "http://localhost:3000"
)
  .split(",")
  .map((x) => x.trim());
export async function sessionFor(raw?: string) {
  if (!raw) return null;
  const s = await db.session.findUnique({
    where: { tokenHash: hash(raw) },
    include: { user: { select: { ...userSelect, platformAdmin: true } } },
  });
  return s && s.expiresAt > new Date() ? s : null;
}
export function rawSession(req: Request) {
  return req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : req.cookies?.taskflow_session;
}
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const s = await sessionFor(rawSession(req));
    if (!s) return next(new HttpError(401, "Please sign in again."));
    res.locals.user = s.user;
    res.locals.sessionId = s.id;
    next();
  } catch (e) {
    next(e);
  }
}
export function csrf(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !origins.includes(origin))
    return next(new HttpError(403, "Origin is not allowed."));
  if (
    req.cookies?.taskflow_session &&
    (!origin || req.headers["x-taskflow-request"] !== "1")
  )
    return next(new HttpError(403, "CSRF validation failed."));
  next();
}
export async function membership(
  workspaceId: string,
  userId: string,
  write = false,
  admin = false,
) {
  const m = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    include: { workspace: true },
  });
  if (!m) fail(403, "Workspace access denied.");
  if (write && (m!.role === "VIEWER" || m!.workspace.archived))
    fail(403, "Workspace is read-only.");
  if (admin && !["OWNER", "ADMIN"].includes(m!.role))
    fail(403, "Administrator access required.");
  return m!;
}
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: (process.env.COOKIE_SAME_SITE === "none" ? "none" : "lax") as
      "none" | "lax",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30,
  };
}
