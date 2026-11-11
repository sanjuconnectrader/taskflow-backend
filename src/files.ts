import {Router} from 'express';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import {db} from './db.js';
import {authenticate,fail,membership,projectScoped,taskAccess} from './security.js';
import {id} from './validation.js';
import {storageConfig} from './config/storage.js';
import {currentLocation,objectStore,type Location} from './storage/provider.js';
import {reserveUpload,invalidateUsage} from './storage/usage.js';
import {prepareUpload} from './storage/images.js';
import {enqueueDeletion,drainDeletions} from './storage/deletions.js';
export const files=Router();files.use(authenticate);
const metadata={id:true,name:true,mime:true,size:true,createdAt:true,taskId:true} as const;
function locationOf(file:{location:Location|null}):Location {if(file.location)return file.location;if(process.env.LEGACY_STORAGE_PROVIDER==='s3'&&process.env.OBJECT_STORAGE_BUCKET)return {provider:'S3',bucket:process.env.OBJECT_STORAGE_BUCKET};return fail(503,'This legacy file needs an operator to map its original storage bucket. The file has not been deleted.');}
files.get('/:wid',async(req,res)=>{
 const wid=id.parse(req.params.wid);const member=await membership(wid,res.locals.user.id);
 const q=z.object({cursor:id.optional(),limit:z.coerce.number().int().min(1).max(100).default(50),search:z.string().max(200).optional(),projectId:id.optional()}).parse(req.query);
 const marker=q.cursor?await db.attachment.findFirst({where:{id:q.cursor,workspaceId:wid,confirmed:true},select:{id:true,createdAt:true}}):null;if(q.cursor&&!marker)fail(404,'File cursor not found.');
 const rows=await db.attachment.findMany({where:{workspaceId:wid,confirmed:true,...(marker?{OR:[{createdAt:{lt:marker.createdAt}},{createdAt:marker.createdAt,id:{lt:marker.id}}]}:{}),...(q.search?{name:{contains:q.search,mode:'insensitive'}}:{}),...((q.projectId||projectScoped(member))?{task:{...(q.projectId?{projectId:q.projectId}:{}),...taskAccess(member,res.locals.user.id)}}:{})},select:metadata,orderBy:[{createdAt:'desc'},{id:'desc'}],take:q.limit+1});
 const more=rows.length>q.limit;const items=rows.slice(0,q.limit);res.json({enabled:!!currentLocation(),items,nextCursor:more?items[items.length-1].id:null});
});
files.post('/:wid/upload',rateLimit({windowMs:60000,limit:20,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res)=>{
 const wid=id.parse(req.params.wid);const member=await membership(wid,res.locals.user.id,true);const location=currentLocation();if(!location)fail(503,'Private file storage has not been configured.');
 const data=z.object({taskId:id,name:z.string().min(1).max(200).regex(/^[^\/\\]+\.(pdf|png|jpg|jpeg|txt)$/i),mime:z.enum(['application/pdf','image/png','image/jpeg','text/plain']),size:z.number().int().positive().max(storageConfig.UPLOAD_MAX_BYTES),optimizeImage:z.boolean().default(false)}).parse(req.body);
 const types:Record<string,string>={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',txt:'text/plain'};
 if(types[data.name.split('.').pop()!.toLowerCase()]!==data.mime)fail(400,'File extension does not match its content type.');
 if(!await db.task.findFirst({where:{id:data.taskId,workspaceId:wid,...taskAccess(member,res.locals.user.id)},select:{id:true}}))fail(404,'Task not found.');
 const file=await reserveUpload({...data,workspaceId:wid,uploaderId:res.locals.user.id},location!);
 try {const url=await objectStore(location!).signedUpload(file.key,file.mime,file.size);invalidateUsage();res.status(201).json({id:file.id,url});}
 catch(error){await db.attachment.deleteMany({where:{id:file.id,confirmed:false}});throw error;}
});
files.post('/:wid/:fid/confirm',async(req,res)=>{
 const wid=id.parse(req.params.wid);const fid=id.parse(req.params.fid);const member=await membership(wid,res.locals.user.id,true);
 const file=await db.attachment.findFirst({where:{id:fid,workspaceId:wid,uploaderId:res.locals.user.id,...(projectScoped(member)?{task:taskAccess(member,res.locals.user.id)}:{})},include:{location:true}});if(!file)fail(404,'File not found.');if(file!.confirmed){res.json({ok:true});return;}
 if(file!.expiresAt<new Date())fail(410,'Upload reservation expired. Please select the file again.');
 const token=crypto.randomUUID();const claimed=await db.attachment.updateMany({where:{id:fid,confirmed:false,OR:[{processingExpiresAt:null},{processingExpiresAt:{lt:new Date()}}]},data:{processingToken:token,processingExpiresAt:new Date(Date.now()+180000)}});if(!claimed.count)fail(409,'This file is already being processed. Retry shortly.');
 const store=objectStore(locationOf(file!));let publishedKey:string|undefined;let saved=false;
 try{
  const info=await store.info(file!.key);if(!Number.isFinite(info.size)||info.size!==file!.size||info.mime.split(';')[0]!==file!.mime)fail(400,'Uploaded file metadata mismatch.');
  const bytes=await store.download(file!.key,storageConfig.UPLOAD_MAX_BYTES,info.etag);if(bytes.length!==file!.size)fail(400,'Uploaded file size mismatch.');
  const prepared=await prepareUpload(bytes,file!.mime,file!.optimizeImage);
  publishedKey=`${wid}/confirmed/${crypto.randomUUID()}`;await store.put(publishedKey,prepared.bytes,prepared.mime);
  const updated=await db.attachment.updateMany({where:{id:fid,confirmed:false,processingToken:token},data:{confirmed:true,key:publishedKey,mime:prepared.mime,size:prepared.bytes.length,processingToken:null,processingExpiresAt:null}});
  if(!updated.count)fail(409,'The upload changed while it was being processed.');saved=true;
  if(file!.locationId)await enqueueDeletion(file!.locationId,file!.key);
  invalidateUsage();res.json({ok:true,size:prepared.bytes.length,optimization:prepared.mode});
 }finally{
  if(publishedKey&&!saved&&file!.locationId)await enqueueDeletion(file!.locationId,publishedKey);
  await db.attachment.updateMany({where:{id:fid,processingToken:token},data:{processingToken:null,processingExpiresAt:null}});
  // Best effort only; durable outbox retries storage outages without losing metadata.
  if(saved)await drainDeletions(5).catch(()=>{});
 }
});
files.get('/:wid/:fid/download',async(req,res)=>{
 const wid=id.parse(req.params.wid);const member=await membership(wid,res.locals.user.id);const file=await db.attachment.findFirst({where:{id:id.parse(req.params.fid),workspaceId:wid,confirmed:true,...(projectScoped(member)?{task:taskAccess(member,res.locals.user.id)}:{})},select:{name:true,key:true,location:{select:{provider:true,bucket:true}}}});if(!file)fail(404,'File not found.');res.json({url:await objectStore(locationOf(file!)).signedDownload(file!.key,file!.name)});
});
files.delete('/:wid/:fid',async(req,res)=>{
 const wid=id.parse(req.params.wid);const member=await membership(wid,res.locals.user.id,true);const file=await db.attachment.findFirst({where:{id:id.parse(req.params.fid),workspaceId:wid,...(projectScoped(member)?{task:taskAccess(member,res.locals.user.id)}:{})},select:{id:true,uploaderId:true}});if(!file)fail(404,'File not found.');
 if(file!.uploaderId!==res.locals.user.id&&!['OWNER','ADMIN'].includes(member.role))fail(403,'File deletion denied.');
 await db.attachment.delete({where:{id:file!.id}});invalidateUsage();await drainDeletions(5).catch(()=>{});res.json({ok:true});
});
