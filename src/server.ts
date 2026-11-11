import { server, io } from "./app.js";
import { db } from "./db.js";
import {sendReminders} from './reminders.js';
server.listen(Number(process.env.PORT || 4000), "0.0.0.0", () =>
  console.log("TaskFlow API listening"),
);
let remindersRunning=false;
const reminderMinutes=Number(process.env.REMINDERS_INTERVAL_MINUTES || 60);
const runReminders=async()=>{if(remindersRunning)return;remindersRunning=true;try{await sendReminders(new Date(),userId=>io.to(`user:${userId}`).emit('invalidate'));}catch{console.error('TaskFlow reminder scan failed.');}finally{remindersRunning=false;}};
const reminderTimer=setInterval(runReminders,Math.max(5,Number.isFinite(reminderMinutes)?reminderMinutes:60)*60_000);
reminderTimer.unref();
const firstReminder=setTimeout(runReminders,10_000);firstReminder.unref();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    clearInterval(reminderTimer);clearTimeout(firstReminder);
    io.close();
    server.close(async () => {
      await db.$disconnect();
      process.exit(0);
    });
  });
