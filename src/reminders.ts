import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {db} from './db.js';
import {tokenDigest} from './security.js';
import {storageConfig} from './config/storage.js';
export async function sendReminders(now=new Date(), onCreated?:(userId:string)=>void){
 const utcToday=new Date(now.toISOString().slice(0,10)+'T00:00:00Z');const oldest=new Date(utcToday.getTime()-(storageConfig.REMINDER_MAX_OVERDUE_DAYS+1)*86400000);const latest=new Date(utcToday.getTime()+86400000);let cursor:string|undefined;let scanned=0;
 const dates=new Map<string,Date>();
 while(true){const tasks=await db.task.findMany({where:{archived:false,workspace:{archived:false},status:{notIn:['COMPLETED','CANCELLED']},dueDate:{gte:oldest,lte:latest},...(cursor?{id:{gt:cursor}}:{})},select:{id:true,title:true,workspaceId:true,dueDate:true,workspace:{select:{timezone:true}},assignees:{select:{userId:true,user:{select:{preferences:true}}}}},orderBy:{id:'asc'},take:100});if(!tasks.length)break;
  for(const task of tasks){const timezone=task.workspace.timezone;let today=dates.get(timezone);if(!today){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);const get=(type:string)=>parts.find(p=>p.type===type)!.value;today=new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);dates.set(timezone,today);}if(task.dueDate!.getTime()>today.getTime() || task.dueDate!.getTime()<today.getTime()-storageConfig.REMINDER_MAX_OVERDUE_DAYS*86400000)continue;
   for(const assignee of task.assignees){const prefs=assignee.user.preferences as any;if(prefs?.reminders===false||prefs?.notifications===false)continue;
   const phase=task.dueDate!.getTime()===today.getTime()?'today':'overdue';const deadline=task.dueDate!.toISOString().slice(0,10);
   const dedupeKey=tokenDigest(`deadline:${task.id}:${assignee.userId}:${deadline}:${phase}`);
   const result=await db.notification.createMany({data:[{userId:assignee.userId,workspaceId:task.workspaceId,taskId:task.id,title:`${phase==='today'?'Due today':'Overdue'}: ${task.title}`,message:deadline,type:phase==='today'?'DEADLINE_DUE':'DEADLINE_OVERDUE',dedupeKey}],skipDuplicates:true});
   if(result.count)onCreated?.(assignee.userId);
  }}
  scanned+=tasks.length;cursor=tasks[tasks.length-1].id;
 }return {scanned};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{console.log(JSON.stringify(await sendReminders()));}finally{await db.$disconnect();}}
