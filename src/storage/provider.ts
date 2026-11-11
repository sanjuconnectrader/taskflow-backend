import {createClient} from '@supabase/supabase-js';
import {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,DeleteObjectCommand,ListObjectsV2Command} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {storageConfig} from '../config/storage.js';
export type ProviderName='SUPABASE'|'S3';
export type Location={provider:ProviderName;bucket:string};
export interface ObjectStore {
 signedUpload(key:string,mime:string,size:number):Promise<string>;
 info(key:string):Promise<{size:number;mime:string;etag?:string}>;
 download(key:string,maxBytes:number,etag?:string):Promise<Buffer>;
 put(key:string,bytes:Buffer,mime:string):Promise<void>;
 signedDownload(key:string,name:string):Promise<string>;
 remove(key:string):Promise<void>;
 temporaryObjects(cursor?:string):Promise<{items:{key:string;createdAt:Date}[];cursor?:string}>;
}
export function currentLocation():Location|null {
 const provider=(process.env.STORAGE_PROVIDER|| (process.env.SUPABASE_URL?'supabase':'s3')).toUpperCase();
 if(provider==='SUPABASE')return process.env.SUPABASE_URL&&process.env.SUPABASE_SECRET_KEY?{provider:'SUPABASE',bucket:process.env.SUPABASE_STORAGE_BUCKET||'taskflow-files'}:null;
 if(provider==='S3')return process.env.OBJECT_STORAGE_BUCKET&&process.env.OBJECT_STORAGE_ACCESS_KEY&&process.env.OBJECT_STORAGE_SECRET_KEY?{provider:'S3',bucket:process.env.OBJECT_STORAGE_BUCKET}:null;
 throw new Error('STORAGE_PROVIDER must be supabase or s3.');
}
export function supabaseClient(){
 if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SECRET_KEY)throw new Error('Supabase Storage server credentials are not configured.');
 return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)})}});
}
const checked=<T>(result:{data:T;error:any}):NonNullable<T>=>{if(result.error)throw new Error('Object storage request failed.',{cause:result.error});if(result.data===null)throw new Error('Object storage returned no data.');return result.data!;};
export function objectStore(location:Location):ObjectStore {
 if(location.provider==='SUPABASE'){
  const bucket=supabaseClient().storage.from(location.bucket);
  return {
   async signedUpload(key){return checked(await bucket.createSignedUploadUrl(key,{upsert:false})).signedUrl;},
   async info(key){const file=checked(await bucket.info(key));return {size:Number(file.size||0),mime:file.contentType||'application/octet-stream',etag:file.etag};},
   async download(key,maxBytes){const blob=checked(await bucket.download(key));if(blob.size>maxBytes)throw new Error('Object exceeds the upload size limit.');return Buffer.from(await blob.arrayBuffer());},
   async put(key,bytes,mime){checked(await bucket.upload(key,bytes,{contentType:mime,upsert:false,cacheControl:'0'}));},
   async signedDownload(key,name){return checked(await bucket.createSignedUrl(key,60,{download:name})).signedUrl;},
   async remove(key){checked(await bucket.remove([key]));},
   async temporaryObjects(cursor){const offset=Number(cursor||0);const files=checked(await bucket.list('temporary',{limit:100,offset,sortBy:{column:'name',order:'asc'}}));return {items:files.filter(f=>f.id&&f.created_at).map(f=>({key:`temporary/${f.name}`,createdAt:new Date(f.created_at!)})),cursor:files.length===100?String(offset+100):undefined};},
  };
 }
 const client=new S3Client({endpoint:process.env.OBJECT_STORAGE_ENDPOINT||undefined,region:process.env.OBJECT_STORAGE_REGION||'us-east-1',forcePathStyle:true,credentials:{accessKeyId:process.env.OBJECT_STORAGE_ACCESS_KEY||'',secretAccessKey:process.env.OBJECT_STORAGE_SECRET_KEY||''}});
 const Bucket=location.bucket;
 return {
  signedUpload:(Key,ContentType,ContentLength)=>getSignedUrl(client,new PutObjectCommand({Bucket,Key,ContentType,ContentLength}),{expiresIn:120}),
  async info(Key){const h=await client.send(new HeadObjectCommand({Bucket,Key}));return {size:h.ContentLength||0,mime:h.ContentType||'application/octet-stream',etag:h.ETag};},
  async download(Key,maxBytes,IfMatch){const data=await client.send(new GetObjectCommand({Bucket,Key,IfMatch}));let total=0;const parts:Buffer[]=[];for await(const part of data.Body as AsyncIterable<Uint8Array>){total+=part.length;if(total>maxBytes)throw new Error('Object exceeds the upload size limit.');parts.push(Buffer.from(part));}return Buffer.concat(parts);},
  async put(Key,Body,ContentType){await client.send(new PutObjectCommand({Bucket,Key,Body,ContentType,IfNoneMatch:'*'}));},
  signedDownload:(Key,name)=>getSignedUrl(client,new GetObjectCommand({Bucket,Key,ResponseContentDisposition:`attachment; filename*=UTF-8''${encodeURIComponent(name)}`}),{expiresIn:60}),
  async remove(Key){await client.send(new DeleteObjectCommand({Bucket,Key}));},
  async temporaryObjects(ContinuationToken){const page=await client.send(new ListObjectsV2Command({Bucket,Prefix:'temporary/',ContinuationToken,MaxKeys:100}));return {items:(page.Contents||[]).filter(f=>f.Key&&f.LastModified).map(f=>({key:f.Key!,createdAt:f.LastModified!})),cursor:page.NextContinuationToken};},
 };
}
export async function initializeSupabaseBucket(){
 const client=supabaseClient();const bucket=process.env.SUPABASE_STORAGE_BUCKET||'taskflow-files';const found=await client.storage.getBucket(bucket);
 if(found.data){if(found.data.public)throw new Error('The TaskFlow bucket must be private.');if(!found.data.file_size_limit||Number(found.data.file_size_limit)>storageConfig.UPLOAD_MAX_BYTES)throw new Error('Set the TaskFlow bucket file size limit to UPLOAD_MAX_BYTES before enabling uploads.');return bucket;}
 if(found.error&&!['404','400'].includes(String((found.error as any).statusCode)))throw new Error('Could not inspect the private Supabase bucket.');
 checked(await client.storage.createBucket(bucket,{public:false,fileSizeLimit:storageConfig.UPLOAD_MAX_BYTES,allowedMimeTypes:['application/pdf','image/png','image/jpeg','text/plain']}));return bucket;
}
