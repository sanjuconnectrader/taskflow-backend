import {Prisma} from '@prisma/client';
import {db,table} from '../db.js';
import {storageConfig} from '../config/storage.js';
import {objectStore,type Location} from './provider.js';
import {drainDeletions} from './deletions.js';
import {invalidateUsage} from './usage.js';

export async function maintenance(dryRun=true,now=new Date()){
 const batch=storageConfig.MAINTENANCE_BATCH_SIZE,maxBatches=storageConfig.MAINTENANCE_MAX_BATCHES;
 const before=(days:number)=>new Date(now.getTime()-days*86400000);
 const pending={confirmed:false,expiresAt:{lt:now},OR:[{processingExpiresAt:null},{processingExpiresAt:{lt:now}}]};
 const sessionWhere={expiresAt:{lt:before(storageConfig.RETENTION_EXPIRED_SESSIONS_DAYS)}};
 const resetWhere={expiresAt:{lt:before(storageConfig.RETENTION_EXPIRED_RESET_DAYS)}};
 const notificationWhere={read:true,createdAt:{lt:before(storageConfig.RETENTION_READ_NOTIFICATIONS_DAYS)}};
 const activityWhere={createdAt:{lt:before(storageConfig.RETENTION_ACTIVITY_DAYS)}};
 const auditWhere={createdAt:{lt:before(storageConfig.RETENTION_AUDIT_DAYS)}};
 const counts={expiredSessions:await db.session.count({where:sessionWhere}),expiredResetAuthorizations:await db.resetAuthorization.count({where:resetWhere}),temporaryUploads:await db.attachment.count({where:pending}),readNotifications:storageConfig.RETENTION_READ_NOTIFICATIONS_DAYS?await db.notification.count({where:notificationWhere}):0,activities:storageConfig.RETENTION_ACTIVITY_DAYS?await db.activity.count({where:activityWhere}):0,auditLogs:storageConfig.RETENTION_AUDIT_DAYS?await db.auditLog.count({where:auditWhere}):0};
 if(dryRun)return {dryRun:true,eligible:counts,policy:'Only expired credentials and unconfirmed temporary uploads are enabled by default. Activity/audit/read notification deletion is opt-in.'};
 const token=crypto.randomUUID();const expires=new Date(Date.now()+5*60000);
 const claimed=await db.$queryRaw<{token:string}[]>(Prisma.sql`INSERT INTO ${table('MaintenanceLease')} (name,token,"expiresAt") VALUES ('storage-maintenance',${token}::uuid,${expires}) ON CONFLICT(name) DO UPDATE SET token=EXCLUDED.token,"expiresAt"=EXCLUDED."expiresAt" WHERE ${table('MaintenanceLease')}."expiresAt"<now() RETURNING token::text`);
 if(!claimed.length)return {dryRun:false,busy:true};
 const removed={expiredSessions:0,expiredResetAuthorizations:0,temporaryUploads:0,readNotifications:0,activities:0,auditLogs:0,temporaryOrphans:0,objects:0};
 try {
  // IDs and eligibility predicates are both checked at DELETE time, so a concurrent update cannot turn a live row into a cleanup target.
  async function prune(model:any,where:any){let count=0;for(let i=0;i<maxBatches;i++){const rows=await model.findMany({where,select:{id:true},orderBy:{id:'asc'},take:batch});if(!rows.length)break;const result=await model.deleteMany({where:{...where,id:{in:rows.map((r:any)=>r.id)}}});count+=result.count;if(rows.length<batch)break;}return count;}
  removed.expiredSessions=await prune(db.session,sessionWhere);
  removed.expiredResetAuthorizations=await prune(db.resetAuthorization,resetWhere);
  removed.temporaryUploads=await prune(db.attachment,pending);
  if(storageConfig.RETENTION_READ_NOTIFICATIONS_DAYS)removed.readNotifications=await prune(db.notification,notificationWhere);
  if(storageConfig.RETENTION_ACTIVITY_DAYS)removed.activities=await prune(db.activity,activityWhere);
  if(storageConfig.RETENTION_AUDIT_DAYS)removed.auditLogs=await prune(db.auditLog,auditWhere);
  const locations=await db.storageLocation.findMany({take:100});
  for(const location of locations){let cursor:string|undefined;const store=objectStore(location as Location);
   for(let page=0;page<maxBatches;page++){
    let objects;try{objects=await store.temporaryObjects(cursor);}catch{break;}
    for(const object of objects.items){
     if(!/^temporary\/[0-9a-f-]{36}$/.test(object.key)||object.createdAt>=new Date(now.getTime()-storageConfig.TEMP_UPLOAD_RETENTION_HOURS*3600000))continue;
     if(await db.attachment.count({where:{locationId:location.id,key:object.key}}))continue;
     try{await store.remove(object.key);removed.temporaryOrphans++;}catch{}
    }
    // Offset-based providers can skip objects when deleting; later scheduled runs revisit the prefix safely.
    cursor=objects.cursor;if(!cursor)break;
   }
  }
  removed.objects=(await drainDeletions(batch*maxBatches)).deleted;
  invalidateUsage();return {dryRun:false,removed};
 }finally{await db.maintenanceLease.deleteMany({where:{name:'storage-maintenance',token}});}
}
