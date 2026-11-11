import { server, io } from "./app.js";
import { db } from "./db.js";
server.listen(Number(process.env.PORT || 4000), "0.0.0.0", () =>
  console.log("TaskFlow API listening"),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    io.close();
    server.close(async () => {
      await db.$disconnect();
      process.exit(0);
    });
  });
