import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { rateLimit } from "express-rate-limit";
import { createServer } from "node:http";
import { Server } from "socket.io";
import swaggerUi from "swagger-ui-express";
import { ZodError } from "zod";
import { db } from "./db.js";
import { auth, recovery } from "./auth.js";
import {
  csrf,
  HttpError,
  membership,
  origins,
  sessionFor,
} from "./security.js";
import { workspaceRoutes } from "./workspaces.js";
import { reports } from "./reports.js";
import { files } from "./files.js";
import { openapi } from "./openapi.js";
export const app = express();
export const server = createServer(app);
export const io = new Server(server, {
  cors: { origin: origins, credentials: true },
});
app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.use(
  pinoHttp({
    serializers: {
      req: (r) => ({ id: r.id, method: r.method, path: r.url?.split("?")[0] }),
      res: (r) => ({ statusCode: r.statusCode }),
    },
    redact: [
      "req.headers.cookie",
      "req.headers.authorization",
      "res.headers.set-cookie",
    ],
    autoLogging: process.env.NODE_ENV !== "test",
  }),
);
app.use(helmet());
app.use(cors({ origin: origins, credentials: true }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use(csrf);
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.get("/health", async (req, res) => {
  await db.$queryRaw`SELECT 1`;
  res.json({ status: "ok" });
});
app.get("/api/v1/openapi.json", (req, res) => res.json(openapi));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi));
app.use("/api/v1/auth", auth);
app.use("/api/v1/recovery", recovery);
app.use("/api/v1/workspaces", workspaceRoutes(io));
app.use("/api/v1/reports", reports);
app.use("/api/v1/files", files);
app.use((req, res) =>
  res.status(404).json({ error: { message: "Endpoint not found." } }),
);
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof ZodError) {
      res
        .status(400)
        .json({
          error: {
            message: "Please check the submitted fields.",
            details: err.issues.map((x) => ({
              path: x.path.join("."),
              message: x.message,
            })),
          },
        });
      return;
    }
    if (err.code === "P2002") {
      res
        .status(409)
        .json({ error: { message: "This record already exists." } });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ error: { message: "Record not found." } });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: { message: "Invalid JSON." } });
      return;
    }
    const code = err instanceof HttpError ? err.status : 500;
    if (code === 500)
      req.log.error({ code: err.code, name: err.name }, "Request failed");
    res
      .status(code)
      .json({
        error: {
          message:
            code === 500
              ? "The server could not complete this request."
              : err.message,
        },
      });
  },
);
io.use(async (socket, next) => {
  try {
    const origin = socket.handshake.headers.origin;
    if (origin && !origins.includes(origin))
      return next(new Error("Origin denied"));
    const cookies = Object.fromEntries(
      (socket.handshake.headers.cookie || "")
        .split(";")
        .map((v) => v.trim().split("=")),
    );
    const session = await sessionFor(
      socket.handshake.auth.token || cookies.taskflow_session,
    );
    if (!session) return next(new Error("Unauthorized"));
    socket.data.userId = session.userId;
    socket.data.raw = socket.handshake.auth.token || cookies.taskflow_session;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});
io.on("connection", (socket) => {
  socket.join(`user:${socket.data.userId}`);
  socket.on("workspace:join", async (wid: string, ack?: Function) => {
    try {
      if (!(await sessionFor(socket.data.raw))) throw new Error("Expired");
      await membership(wid, socket.data.userId);
      for (const room of socket.rooms)
        if (room.startsWith("workspace:")) socket.leave(room);
      socket.join(`workspace:${wid}`);
      ack?.({ ok: true });
    } catch {
      ack?.({ ok: false });
    }
  });
  const check = setInterval(async () => {
    try {
      if (!(await sessionFor(socket.data.raw))) socket.disconnect(true);
    } catch {
      socket.disconnect(true);
    }
  }, 30000);
  socket.on("disconnect", () => clearInterval(check));
});
