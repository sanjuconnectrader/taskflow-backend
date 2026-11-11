import 'dotenv/config';
import { z } from 'zod';

const positive=(fallback:number)=>z.coerce.number().int().positive().default(fallback);
const retention=(fallback=0)=>z.coerce.number().int().nonnegative().default(fallback);
export const storageConfig=z.object({
  DATABASE_LIMIT_BYTES:positive(500_000_000),
  STORAGE_LIMIT_BYTES:positive(1_000_000_000),
  STORAGE_UPLOAD_CEILING_PERCENT:z.coerce.number().min(1).max(100).default(95),
  STORAGE_STATS_CACHE_SECONDS:positive(60),
  UPLOAD_MAX_BYTES:positive(10*1024*1024),
  TEMP_UPLOAD_RETENTION_HOURS:z.coerce.number().int().min(3).default(24),
  RETENTION_EXPIRED_SESSIONS_DAYS:retention(1),
  RETENTION_EXPIRED_RESET_DAYS:retention(7),
  RETENTION_READ_NOTIFICATIONS_DAYS:retention(),
  RETENTION_ACTIVITY_DAYS:retention(),
  RETENTION_AUDIT_DAYS:retention(),
  MAINTENANCE_BATCH_SIZE:z.coerce.number().int().min(1).max(500).default(100),
  MAINTENANCE_MAX_BATCHES:z.coerce.number().int().min(1).max(20).default(5),
  IMAGE_MAX_DIMENSION:positive(2048),
  IMAGE_WEB_QUALITY:z.coerce.number().int().min(70).max(95).default(85),
  IMAGE_MAX_PIXELS:positive(40_000_000),
  IMAGE_PROCESSING_CONCURRENCY:z.coerce.number().int().min(1).max(4).default(1),
  REMINDER_MAX_OVERDUE_DAYS:positive(30),
}).parse(process.env);

export function utilization(used:number|null,limit:number){
  if(used===null)return {usedBytes:null,limitBytes:limit,percent:null,level:'unknown' as const};
  const percent=used/limit*100;
  return {usedBytes:used,limitBytes:limit,percent:Math.round(percent*100)/100,level:percent>=95?'critical':percent>=85?'warning':percent>=70?'notice':'normal'};
}
