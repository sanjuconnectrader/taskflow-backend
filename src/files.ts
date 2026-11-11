import { Router } from "express";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { db } from "./db.js";
import { authenticate, fail, membership } from "./security.js";
import { id } from "./validation.js";
export const files = Router();
files.use(authenticate);
const enabled = () =>
  Boolean(
    process.env.OBJECT_STORAGE_BUCKET && process.env.OBJECT_STORAGE_ACCESS_KEY,
  );
const s3 = new S3Client({
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT || undefined,
  region: process.env.OBJECT_STORAGE_REGION || "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY || "",
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY || "",
  },
});
const bucket = () => process.env.OBJECT_STORAGE_BUCKET!;
files.get("/:wid", async (req, res) => {
  const wid = id.parse(req.params.wid);
  await membership(wid, res.locals.user.id);
  res.json({
    enabled: enabled(),
    items: await db.attachment.findMany({
      where: { workspaceId: wid, confirmed: true },
      select: {
        id: true,
        name: true,
        mime: true,
        size: true,
        createdAt: true,
        taskId: true,
      },
      take: 100,
      orderBy: { createdAt: "desc" },
    }),
  });
});
files.post("/:wid/upload", async (req, res) => {
  const wid = id.parse(req.params.wid);
  await membership(wid, res.locals.user.id, true);
  if (!enabled()) fail(503, "Private file storage has not been configured.");
  const data = z
    .object({
      taskId: id,
      name: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^\/\\]+\.(pdf|png|jpg|jpeg|txt)$/i),
      mime: z.enum([
        "application/pdf",
        "image/png",
        "image/jpeg",
        "text/plain",
      ]),
      size: z
        .number()
        .int()
        .positive()
        .max(10 * 1024 * 1024),
    })
    .parse(req.body);
  const ext = data.name.split(".").pop()!.toLowerCase();
  const mimeByExt: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    txt: "text/plain",
  };
  if (mimeByExt[ext] !== data.mime)
    fail(400, "File extension does not match its content type.");
  const t = await db.task.findFirst({
    where: { id: data.taskId, workspaceId: wid },
  });
  if (!t) fail(404, "Task not found.");
  const key = `${wid}/${crypto.randomUUID()}`;
  const f = await db.attachment.create({
    data: { ...data, key, workspaceId: wid, uploaderId: res.locals.user.id },
  });
  res.status(201).json({
    id: f.id,
    url: await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        ContentType: data.mime,
        ContentLength: data.size,
      }),
      { expiresIn: 120 },
    ),
  });
});
files.post("/:wid/:fid/confirm", async (req, res) => {
  const wid = id.parse(req.params.wid);
  await membership(wid, res.locals.user.id, true);
  const f = await db.attachment.findFirst({
    where: {
      id: id.parse(req.params.fid),
      workspaceId: wid,
      uploaderId: res.locals.user.id,
    },
  });
  if (!f) fail(404, "File not found.");
  if (f!.confirmed) {
    res.json({ ok: true });
    return;
  }
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket(), Key: f!.key }),
  );
  if (head.ContentLength !== f!.size || head.ContentType !== f!.mime)
    fail(400, "Uploaded file metadata mismatch.");
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: bucket(),
      Key: f!.key,
      Range: "bytes=0-511",
      IfMatch: head.ETag,
    }),
  );
  const bytes = Buffer.from(await result.Body!.transformToByteArray());
  const ascii = bytes.toString("utf8");
  const valid =
    f!.mime === "application/pdf"
      ? ascii.startsWith("%PDF-")
      : f!.mime === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : f!.mime === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : !bytes.includes(0) && !/<(?:script|html|svg)/i.test(ascii);
  if (!valid) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: f!.key }));
    await db.attachment.delete({ where: { id: f!.id } });
    fail(400, "File content does not match the allowed format.");
  }
  // Publish under a new key so a still-valid staging PUT URL cannot alter a confirmed file.
  const publishedKey = `${wid}/confirmed/${crypto.randomUUID()}`;
  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket(),
      Key: publishedKey,
      CopySource: `${bucket()}/${f!.key}`,
      CopySourceIfMatch: head.ETag,
      MetadataDirective: "COPY",
    }),
  );
  const published = await db.attachment.updateMany({
    where: { id: f!.id, confirmed: false },
    data: { confirmed: true, key: publishedKey },
  });
  if (!published.count)
    await s3.send(
      new DeleteObjectCommand({ Bucket: bucket(), Key: publishedKey }),
    );
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: f!.key }));
  res.json({ ok: true });
});
files.get("/:wid/:fid/download", async (req, res) => {
  const wid = id.parse(req.params.wid);
  await membership(wid, res.locals.user.id);
  const f = await db.attachment.findFirst({
    where: { id: id.parse(req.params.fid), workspaceId: wid, confirmed: true },
  });
  if (!f) fail(404, "File not found.");
  res.json({
    url: await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket(),
        Key: f!.key,
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(f!.name)}`,
      }),
      { expiresIn: 60 },
    ),
  });
});
files.delete("/:wid/:fid", async (req, res) => {
  const wid = id.parse(req.params.wid);
  const m = await membership(wid, res.locals.user.id, true);
  const f = await db.attachment.findFirst({
    where: { id: id.parse(req.params.fid), workspaceId: wid },
  });
  if (!f) fail(404, "File not found.");
  if (
    f!.uploaderId !== res.locals.user.id &&
    !["OWNER", "ADMIN"].includes(m.role)
  )
    fail(403, "File deletion denied.");
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: f!.key }));
  await db.attachment.delete({ where: { id: f!.id } });
  res.json({ ok: true });
});
