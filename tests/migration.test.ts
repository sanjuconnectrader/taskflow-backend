import {test,expect} from 'vitest';
import pg from 'pg';
import fs from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
const baseline=fs.readFileSync('prisma/migrations/20261111050244_init/migration.sql','utf8');
const optimized=fs.readFileSync('prisma/migrations/20261111170000_free_tier/migration.sql','utf8');
async function fixture(run:(client:pg.Client)=>Promise<void>){
 const schema='taskflow_migration_'+randomUUID().slice(0,8);const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
 try{await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET search_path TO "${schema}"`);await client.query(baseline);await run(client);}
 finally{await client.query('ROLLBACK').catch(()=>{});if(!/^taskflow_migration_[0-9a-f]{8}$/.test(schema))throw Error('Unexpected fixture schema');await client.query(`DROP SCHEMA "${schema}" CASCADE`);await client.end();}
}
test('migration preserves existing text, dates, metadata and authentication hashes',async()=>fixture(async client=>{
 const [uid,wid,pid,tid,cid]=Array.from({length:5},()=>randomUUID());const hash=randomBytes(32).toString('hex');const content='客户描述 — accurate data 🔐\n'.repeat(2000);
 await client.query('INSERT INTO "User"(id,username,email,"displayName","passwordHash",preferences) VALUES($1,$2,$3,$4,$5,$6)',[uid,'migration','migration@test.invalid','Migration','argon2-placeholder',{theme:'dark'}]);
 await client.query('INSERT INTO "Workspace"(id,name) VALUES($1,$2)',[wid,'Migration']);
 await client.query('INSERT INTO "Project"(id,"workspaceId",name,"dueDate") VALUES($1,$2,$3,$4)',[pid,wid,'Migration','2026-11-30']);
 await client.query('INSERT INTO "Task"(id,"workspaceId","projectId","creatorId",title,description,"dueDate","startDate","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())',[tid,wid,pid,uid,'Migration',content,'2026-11-30','2026-11-01']);
 await client.query('INSERT INTO "Comment"(id,"workspaceId","taskId","authorId","authorName",body,"updatedAt") VALUES($1,$2,$3,$4,$5,$6,now())',[cid,wid,tid,uid,'Migration',content]);
 await client.query('INSERT INTO "Session"(id,"tokenHash","userId",device,"expiresAt") VALUES($1,$2,$3,$4,now()+interval \'1 day\')',[randomUUID(),hash,uid,'Fixture']);
 await client.query('INSERT INTO "AuditLog"(id,action,metadata) VALUES($1,$2,$3)',[randomUUID(),'fixture',{important:'retain this exactly'}]);
 await client.query(optimized);
 const task=(await client.query('SELECT description,to_char("dueDate",\'YYYY-MM-DD\') due,to_char("startDate",\'YYYY-MM-DD\') start,pg_column_size("dueDate") size FROM "Task"')).rows[0];expect(task).toEqual({description:content,due:'2026-11-30',start:'2026-11-01',size:4});
 expect((await client.query('SELECT body FROM "Comment"')).rows[0].body).toBe(content);
 expect((await client.query('SELECT encode("tokenHash",\'hex\') hash,octet_length("tokenHash") size FROM "Session"')).rows[0]).toEqual({hash,size:32});
 expect((await client.query('SELECT metadata FROM "AuditLog"')).rows[0].metadata).toEqual({important:'retain this exactly'});
 expect((await client.query('SELECT preferences FROM "User"')).rows[0].preferences).toEqual({theme:'dark'});
}),30000);
test('migration aborts rather than truncating malformed legacy dates',async()=>fixture(async client=>{
 const wid=randomUUID();await client.query('INSERT INTO "Workspace"(id,name) VALUES($1,$2)',[wid,'Invalid fixture']);await client.query('INSERT INTO "Project"(id,"workspaceId",name,"dueDate") VALUES($1,$2,$3,$4)',[randomUUID(),wid,'Invalid fixture','2026-11-30T12:34:56']);
 await expect(client.query(optimized)).rejects.toThrow();await client.query('ROLLBACK');expect((await client.query('SELECT "dueDate" FROM "Project"')).rows[0].dueDate).toBe('2026-11-30T12:34:56');
}));
