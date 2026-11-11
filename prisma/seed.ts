import "dotenv/config";
import argon2 from "argon2";
import { db } from "../src/db.js";
if (!["development", "test"].includes(process.env.NODE_ENV || ""))
  throw new Error(
    "Seeding is restricted to explicit development/test environments.",
  );
if (!process.env.SEED_PASSWORD || process.env.SEED_PASSWORD.length < 12)
  throw new Error(
    "Set SEED_PASSWORD to your chosen demo account password (at least 12 characters).",
  );
const email = process.env.SEED_EMAIL || "emma@taskflow.local";
if (await db.user.findUnique({ where: { email } })) {
  console.log("Demo user already exists; nothing changed.");
  await db.$disconnect();
  process.exit(0);
}
const names = [
  "Emma Carter",
  "Alex Chen",
  "Maya Singh",
  "James Park",
  "Liam Brooks",
];
const users = await Promise.all(
  names.map(async (displayName, i) =>
    db.user.create({
      data: {
        displayName,
        username: displayName.toLowerCase().replace(" ", "_"),
        email:
          i === 0
            ? email
            : displayName.toLowerCase().replace(" ", ".") + "@taskflow.local",
        passwordHash: await argon2.hash(process.env.SEED_PASSWORD!),
      },
    }),
  ),
);
const w = await db.workspace.create({
  data: {
    name: "Acme Workspace",
    description: "A shared space for purposeful work.",
    members: {
      create: users.map((u, i) => ({
        userId: u.id,
        role: i === 0 ? "OWNER" : "MEMBER",
      })),
    },
  },
});
const projects = await Promise.all(
  [
    {
      name: "Website Redesign",
      color: "#4F46E5",
      description: "A thoughtful refresh of our digital home.",
    },
    {
      name: "Product",
      color: "#249CFF",
      description: "Build the next chapter of our product.",
    },
    {
      name: "Marketing",
      color: "#EAA321",
      description: "Bring our story to the right people.",
    },
  ].map((p) => db.project.create({ data: { ...p, workspaceId: w.id } })),
);
const titles = [
  "Finalize product roadmap",
  "Update marketing website",
  "Review Q1 analytics report",
  "Prepare launch campaign",
  "Fix checkout flow issues",
  "Design new pricing page",
  "Create FAQ content",
  "Set up A/B test",
  "Build landing page",
  "Implement analytics",
  "Write product copy",
  "Update design system",
  "Logo and brand assets",
  "Initial wireframes",
  "Review accessibility",
  "Plan customer interviews",
];
for (let i = 0; i < titles.length; i++) {
  const status =
    i === 2 || (i > 10 && i < 14)
      ? "COMPLETED"
      : i === 0 || i === 3 || i === 8 || i === 9
        ? "IN_PROGRESS"
        : "TODO";
  const d = new Date();
  d.setDate(d.getDate() + (i === 4 ? -2 : i < 3 ? 0 : i % 8));
  await db.task.create({
    data: {
      title: titles[i],
      description:
        "Coordinate with the team, review the details, and share an update when ready.",
      workspaceId: w.id,
      projectId: projects[i < 5 ? i % 3 : 0].id,
      creatorId: users[0].id,
      status,
      priority: i === 4 ? "HIGH" : "MEDIUM",
      dueDate: d.toISOString().slice(0, 10),
      completedAt: status === "COMPLETED" ? new Date() : null,
      assignees: { create: { userId: users[(i + 1) % users.length].id } },
      checklist: {
        create: [
          { text: "Review requirements", done: i > 7 },
          { text: "Share with the team", done: status === "COMPLETED" },
        ],
      },
    },
  });
  if (i < 5)
    await db.activity.create({
      data: {
        workspaceId: w.id,
        actorId: users[(i + 1) % users.length].id,
        actorName: users[(i + 1) % users.length].displayName,
        action: status === "COMPLETED" ? "task:completed" : "task:created",
        target: titles[i],
      },
    });
}
console.log(`Development workspace created for ${email}.`);
await db.$disconnect();
