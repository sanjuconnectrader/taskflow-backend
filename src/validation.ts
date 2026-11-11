import { z } from "zod";
export const id = z.uuid();
export const password = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(128);
export const email = z.email().trim().toLowerCase();
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
    "Invalid calendar date",
  );
export const status = z.enum([
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "COMPLETED",
  "CANCELLED",
]);
export const taskInput = z.object({
  title: z.string().trim().min(1).max(250),
  description: z.string().max(20000).default(""),
  projectId: id,
  status: status.default("TODO"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  dueDate: date.nullable().optional(),
  startDate: date.nullable().optional(),
  assigneeIds: z.array(id).max(50).default([]),
  tags: z.array(z.string().max(40)).max(20).default([]),
  checklist: z
    .array(
      z.object({
        text: z.string().min(1).max(250),
        done: z.boolean().default(false),
      }),
    )
    .max(100)
    .default([]),
  parentId: id.nullable().optional(),
});
export const projectInput = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().max(10000).default(""),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#4F46E5"),
  dueDate: date.nullable().optional(),
});
