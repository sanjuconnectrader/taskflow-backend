import { createHash, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db, userSelect } from "./db.js";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const tokenDigest = (s: string) => createHash('sha256').update(s).digest();
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
// The native shells have fixed, trusted local origins. They must remain
// available even when the deployment also configures public web origins.
const platformOrigins = [
  "https://taskflow-web-ten.vercel.app",
  "http://localhost:3000",
  "http://localhost",
  "https://localhost",
  "capacitor://localhost",
  "taskflow://app",
];
export const origins = [
  ...new Set(
    [...platformOrigins, process.env.APP_WEB_ORIGIN || "", ...(process.env.CORS_ALLOWED_ORIGINS || "").split(",")]
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];
export async function sessionFor(raw?: string) {
  if (!raw) return null;
  const s = await db.session.findUnique({
    where: { tokenHash: tokenDigest(raw) },
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
    if (s.user.mustChangePassword && !["/api/v1/auth/me", "/api/v1/auth/password", "/api/v1/auth/logout", "/api/v1/auth/logout-all"].includes(req.originalUrl.split("?")[0]))
      return next(new HttpError(403, "You must change your temporary password before continuing."));
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
  if (m!.employmentStatus !== 'ACTIVE') fail(403, "Company membership is inactive.");
  if (write && (m!.role === "VIEWER" || m!.workspace.archived))
    fail(403, "Workspace is read-only.");
  if (admin && !["OWNER", "ADMIN"].includes(m!.role))
    fail(403, "Administrator access required.");
  return m!;
}
// Newly provisioned employees have restricted access. Legacy members retain
// their existing workspace access until an administrator migrates their roles.
export type AccessMember = {employeeId:string|null;role:string;workspace?:{enforceProjectAccess:boolean}};
export function projectManager(member:AccessMember) {return ['PROJECT_MANAGER','TEAM_LEAD'].includes(member.role);}
export function restrictedEmployee(member:AccessMember) {
  return (member.role==='EMPLOYEE' || !!member.employeeId || !!member.workspace?.enforceProjectAccess) && !['OWNER','ADMIN','PROJECT_MANAGER','TEAM_LEAD'].includes(member.role);
}
export function projectScoped(member:AccessMember) {return restrictedEmployee(member)||projectManager(member);}
export function projectAccess(member:AccessMember,userId:string) {
  return projectScoped(member) ? {OR:[{members:{some:{userId}}},{restrictMembership:false,tasks:{some:{assignees:{some:{userId}}}}}]} : {};
}
export function taskAccess(member:AccessMember,userId:string) {
  if(restrictedEmployee(member))return {assignees:{some:{userId}}};
  if(projectManager(member))return {project:projectAccess(member,userId)};
  return {};
}
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: ((process.env.COOKIE_SAME_SITE || (process.env.NODE_ENV === "production" ? "none" : "lax")) === "none" ? "none" : "lax") as
      "none" | "lax",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30,
  };
}
