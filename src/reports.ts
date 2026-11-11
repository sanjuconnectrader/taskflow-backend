import {Router} from 'express';
import {once} from 'node:events';
import {Prisma} from '@prisma/client';
import {z} from 'zod';
import {db,table} from './db.js';
import {authenticate,membership,restrictedEmployee,projectManager,projectScoped,taskAccess} from './security.js';
import {date,id} from './validation.js';
export const reports=Router();reports.use(authenticate);
export const csvCell=(v:unknown)=>`"${String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')}"`;
reports.get('/:wid',async(req,res)=>{
 const wid=id.parse(req.params.wid);const member=await membership(wid,res.locals.user.id);const restricted=restrictedEmployee(member);
 const q=z.object({from:date.optional(),to:date.optional(),today:date,projectId:id.optional(),memberId:id.optional(),format:z.enum(['json','csv']).default('json')}).parse(req.query);
 if(q.from&&q.to&&q.from>q.to){res.status(400).json({error:{message:'Start date must not follow end date.'}});return;}
 const where:Prisma.TaskWhereInput={workspaceId:wid,archived:false,...(projectScoped(member)?{AND:[taskAccess(member,res.locals.user.id)]}:{}),...(q.projectId?{projectId:q.projectId}:{}),...(q.memberId?{assignees:{some:{userId:q.memberId}}}:{}),...(q.from||q.to?{createdAt:{...(q.from?{gte:new Date(q.from+'T00:00:00Z')}:{}),...(q.to?{lte:new Date(q.to+'T23:59:59.999Z')}: {})}}:{})};
 if(q.format==='csv'){
   res.type('text/csv').attachment('taskflow-report.csv');res.write(['Title','Status','Priority','Due date'].map(csvCell).join(',')+'\r\n');let cursor:string|undefined;
   while(!res.destroyed){const page=await db.task.findMany({where:{...where,...(cursor?{id:{gt:cursor}}:{})},select:{id:true,title:true,status:true,priority:true,dueDate:true},orderBy:{id:'asc'},take:100});if(!page.length)break;
     for(const task of page){const line=[task.title,task.status,task.priority,task.dueDate?.toISOString().slice(0,10)].map(csvCell).join(',')+'\r\n';if(res.destroyed)break;if(!res.write(line))await Promise.race([once(res,'drain'),once(res,'close')]);}
     cursor=page[page.length-1].id;
   }res.end();return;
 }
 const week=new Date(q.today+'T00:00:00Z');week.setUTCDate(week.getUTCDate()-((week.getUTCDay()+6)%7));const weekEnd=new Date(week.getTime()+7*86400000);
 const conditions=[Prisma.sql`t."workspaceId"=${wid}::uuid`,Prisma.sql`NOT t.archived`];
 if(restricted)conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM ${table('TaskAssignee')} own WHERE own."taskId"=t.id AND own."userId"=${res.locals.user.id}::uuid)`);
 if(projectManager(member))conditions.push(Prisma.sql`(EXISTS (SELECT 1 FROM ${table('ProjectMember')} pm WHERE pm."projectId"=t."projectId" AND pm."userId"=${res.locals.user.id}::uuid) OR EXISTS (SELECT 1 FROM ${table('Project')} p JOIN ${table('Task')} t2 ON t2."projectId"=p.id JOIN ${table('TaskAssignee')} a2 ON a2."taskId"=t2.id WHERE p.id=t."projectId" AND NOT p."restrictMembership" AND a2."userId"=${res.locals.user.id}::uuid))`);
 if(q.projectId)conditions.push(Prisma.sql`t."projectId"=${q.projectId}::uuid`);
 if(q.memberId)conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM ${table('TaskAssignee')} a WHERE a."taskId"=t.id AND a."userId"=${q.memberId}::uuid)`);
 if(q.from)conditions.push(Prisma.sql`t."createdAt">=${new Date(q.from+'T00:00:00Z')}`);
 if(q.to)conditions.push(Prisma.sql`t."createdAt"<=${new Date(q.to+'T23:59:59.999Z')}`);
 const scope=Prisma.join(conditions,' AND ');
 const [summary,status,priority,projects,timeline,workload]=await db.$transaction([
  db.$queryRaw<any[]>(Prisma.sql`SELECT count(*)::int total,count(*) FILTER(WHERE status='COMPLETED')::int completed,count(*) FILTER(WHERE status NOT IN ('COMPLETED','CANCELLED') AND "dueDate"=${q.today}::date)::int "dueToday",count(*) FILTER(WHERE status='IN_PROGRESS')::int "inProgress",count(*) FILTER(WHERE status='COMPLETED' AND "completedAt">=${week} AND "completedAt"<${weekEnd})::int "completedThisWeek",count(*) FILTER(WHERE status NOT IN ('COMPLETED','CANCELLED') AND "dueDate"<${q.today}::date)::int overdue FROM ${table('Task')} t WHERE ${scope}`),
  db.$queryRaw<any[]>(Prisma.sql`SELECT status::text key,count(*)::int count FROM ${table('Task')} t WHERE ${scope} GROUP BY status`),
  db.$queryRaw<any[]>(Prisma.sql`SELECT priority::text key,count(*)::int count FROM ${table('Task')} t WHERE ${scope} GROUP BY priority`),
  db.$queryRaw<any[]>(Prisma.sql`SELECT "projectId" key,count(*)::int total,count(*) FILTER(WHERE status='COMPLETED')::int completed FROM ${table('Task')} t WHERE ${scope} GROUP BY "projectId"`),
  db.$queryRaw<any[]>(Prisma.sql`SELECT to_char("completedAt",'YYYY-MM-DD') key,count(*)::int count FROM ${table('Task')} t WHERE ${scope} AND status='COMPLETED' AND "completedAt" IS NOT NULL GROUP BY key ORDER BY key`),
  db.$queryRaw<any[]>(Prisma.sql`SELECT a."userId" key,count(*)::int count FROM ${table('Task')} t JOIN ${table('TaskAssignee')} a ON a."taskId"=t.id WHERE ${scope} AND t.status NOT IN ('COMPLETED','CANCELLED') GROUP BY a."userId"`),
 ],{isolationLevel:'RepeatableRead'});
 const counts=(rows:any[])=>Object.fromEntries(rows.map(row=>[row.key,row.count]));const s=summary[0];
 res.json({...s,completionRate:s.total?Math.round(s.completed/s.total*100):0,byStatus:counts(status),byPriority:counts(priority),byProject:Object.fromEntries(projects.map(p=>[p.key,{total:p.total,completed:p.completed}])),completedOverTime:counts(timeline),workload:restricted?{}:counts(workload)});
});
