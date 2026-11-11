import "dotenv/config";
import { db } from "../src/db.js";
// Operator-only bootstrap: no HTTP endpoint and no public account promotion.
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
if (!email || process.env.CONFIRM_OPERATOR_BOOTSTRAP !== "yes")
  throw new Error(
    "Set BOOTSTRAP_ADMIN_EMAIL and CONFIRM_OPERATOR_BOOTSTRAP=yes in a trusted operator shell.",
  );
const user = await db.user.update({
  where: { email: email.toLowerCase() },
  data: { platformAdmin: true },
  select: { id: true },
});
await db.auditLog.create({
  data: { actorId: user.id, action: "operator:bootstrap", targetId: user.id },
});
await db.$disconnect();
console.log("Operator account provisioned.");
