import {Prisma} from '@prisma/client';
import {db,table,databaseSchema} from '../db.js';
import {storageConfig,utilization} from '../config/storage.js';
import {currentLocation,type Location} from './provider.js';
import {fail} from '../security.js';
type Queryable=Pick<Prisma.TransactionClient,'$queryRaw'>;
type FileUsage={used:number|null;source:string;complete:boolean};
let cached:{expires:number;value:any}|undefined;
export const invalidateUsage=()=>{cached=undefined;};
export async function fileUsage(client:Queryable=db):Promise<FileUsage>{
 const provider=(process.env.STORAGE_PROVIDER||(process.env.SUPABASE_URL?'supabase':'s3')).toLowerCase();
 if(provider==='supabase'){
  try{const rows=await client.$queryRaw<{bytes:bigint;unknown:bigint}[]>`SELECT COALESCE(sum(CASE WHEN metadata->>'size' ~ '^[0-9]+$' THEN (metadata->>'size')::bigint ELSE 0 END),0)::bigint bytes,count(*) FILTER(WHERE metadata->>'size' IS NULL OR metadata->>'size' !~ '^[0-9]+$')::bigint unknown FROM storage.objects`;
   return {used:rows[0].unknown>0n?null:Number(rows[0].bytes),source:'Supabase current-object metadata across all buckets',complete:rows[0].unknown===0n};
  }catch{return {used:null,source:'Supabase Storage metadata unavailable',complete:false};}
 }
 const row=await client.$queryRaw<{bytes:bigint}[]>(Prisma.sql`SELECT COALESCE(sum(size),0)::bigint bytes FROM ${table('Attachment')} WHERE confirmed`);
 return {used:Number(row[0].bytes),source:'Application attachment metadata estimate (external S3 objects excluded)',complete:false};
}
export async function storageUsage(){
 if(cached&&cached.expires>Date.now())return cached.value;
 const [database,files,relations,queued]=await Promise.all([
  db.$queryRaw<{bytes:bigint}[]>`SELECT pg_database_size(current_database())::bigint bytes`,fileUsage(),
  db.$queryRaw<{name:string;tableBytes:bigint;indexBytes:bigint;totalBytes:bigint}[]>`SELECT c.relname name,pg_table_size(c.oid)::bigint "tableBytes",pg_indexes_size(c.oid)::bigint "indexBytes",pg_total_relation_size(c.oid)::bigint "totalBytes" FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${databaseSchema} AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC`,
  db.storageDeletion.count(),
 ]);
 const data={measuredAt:new Date().toISOString(),database:utilization(Number(database[0].bytes),storageConfig.DATABASE_LIMIT_BYTES),files:{...utilization(files.used,storageConfig.STORAGE_LIMIT_BYTES),source:files.source,complete:files.complete},applicationTables:relations.map(r=>({...r,tableBytes:Number(r.tableBytes),indexBytes:Number(r.indexBytes),totalBytes:Number(r.totalBytes)})),queuedObjectDeletions:queued,uploadsEnabled:!!currentLocation(),uploadMaxBytes:storageConfig.UPLOAD_MAX_BYTES,warningThresholds:[70,85,95],retention:{expiredSessionsDays:storageConfig.RETENTION_EXPIRED_SESSIONS_DAYS,expiredResetDays:storageConfig.RETENTION_EXPIRED_RESET_DAYS,readNotificationsDays:storageConfig.RETENTION_READ_NOTIFICATIONS_DAYS,activityDays:storageConfig.RETENTION_ACTIVITY_DAYS,auditDays:storageConfig.RETENTION_AUDIT_DAYS,temporaryHours:storageConfig.TEMP_UPLOAD_RETENTION_HOURS}};
 cached={expires:Date.now()+storageConfig.STORAGE_STATS_CACHE_SECONDS*1000,value:data};return data;
}
export async function reserveUpload(input:{workspaceId:string;taskId:string;uploaderId:string;name:string;mime:string;size:number;optimizeImage:boolean},location:Location){
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(1952543595)::text`;
  const usage=await fileUsage(tx);if(usage.used===null)return fail(503,'Storage usage cannot be verified. Retry later or ask your operator to check storage access.');
  let reservations=0;
  if(location.provider==='SUPABASE'){
   const rows=await tx.$queryRaw<{bytes:bigint}[]>(Prisma.sql`SELECT COALESCE(sum(GREATEST(a.size::bigint*2-COALESCE((SELECT CASE WHEN o.metadata->>'size' ~ '^[0-9]+$' THEN (o.metadata->>'size')::bigint ELSE 0 END FROM storage.objects o WHERE o.bucket_id=l.bucket AND o.name=a.key LIMIT 1),0),0)),0)::bigint bytes FROM ${table('Attachment')} a JOIN ${table('StorageLocation')} l ON a."locationId"=l.id WHERE NOT a.confirmed AND a."expiresAt">now()`);
   reservations=Number(rows[0].bytes);
  }else{const sum=await tx.attachment.aggregate({where:{confirmed:false,expiresAt:{gt:new Date()}},_sum:{size:true}});reservations=(sum._sum.size||0)*2;}
  const ceiling=storageConfig.STORAGE_LIMIT_BYTES*storageConfig.STORAGE_UPLOAD_CEILING_PERCENT/100;
  if(usage.used+reservations+input.size*2>ceiling)fail(507,'Storage upload budget reached. Empty explicitly deleted files or upgrade storage; important content is never deleted automatically.');
  const loc=await tx.storageLocation.upsert({where:{provider_bucket:location},create:location,update:{}});
  return tx.attachment.create({data:{...input,locationId:loc.id,key:`temporary/${crypto.randomUUID()}`,expiresAt:new Date(Date.now()+storageConfig.TEMP_UPLOAD_RETENTION_HOURS*3600000)},include:{location:true}});
 },{timeout:15000});
}
