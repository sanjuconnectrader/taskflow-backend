import sharp from 'sharp';
import {storageConfig} from '../config/storage.js';
import {fail} from '../security.js';
sharp.cache({memory:16,files:0,items:32});sharp.concurrency(1);
let active=0;
export async function prepareUpload(bytes:Buffer,mime:string,optimize=false):Promise<{bytes:Buffer;mime:string;mode:string}>{
 if(mime==='application/pdf'){if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))fail(400,'File content does not match PDF.');return {bytes,mime,mode:'original'};}
 if(mime==='text/plain'){try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail(400,'Text files must contain valid UTF-8.');}if(bytes.includes(0))fail(400,'Text files cannot contain binary null bytes.');return {bytes,mime,mode:'original'};}
 if(!['image/png','image/jpeg'].includes(mime))fail(400,'Unsupported content type.');
 if(active>=storageConfig.IMAGE_PROCESSING_CONCURRENCY)fail(429,'Image processing is busy. Retry confirmation shortly.');active++;
 try {
  const image=sharp(bytes,{limitInputPixels:storageConfig.IMAGE_MAX_PIXELS,failOn:'error'});
  const info=await image.metadata();
  if((mime==='image/png'&&info.format!=='png')||(mime==='image/jpeg'&&info.format!=='jpeg'))fail(400,'Image content does not match its file type.');
  // Animation and high-bit-depth/profiled images stay byte-for-byte original by default.
  if((info.pages||1)>1)return {bytes,mime,mode:'original'};
  if(!optimize){
   if(mime!=='image/png'||info.depth!=='uchar'||info.hasProfile||(info.width||0)*(info.height||0)>8_000_000)return {bytes,mime,mode:'original'};
   const candidate=await image.clone().keepMetadata().png({compressionLevel:9,palette:false,adaptiveFiltering:true}).toBuffer();
   if(candidate.length>=bytes.length)return {bytes,mime,mode:'original'};
   const [a,b]=await Promise.all([sharp(bytes).raw().toBuffer({resolveWithObject:true}),sharp(candidate).raw().toBuffer({resolveWithObject:true})]);
   if(a.info.width!==b.info.width||a.info.height!==b.info.height||a.info.channels!==b.info.channels||!a.data.equals(b.data))return {bytes,mime,mode:'original'};
   return {bytes:candidate,mime,mode:'lossless'};
  }
  // Dimension/quality changes require explicit per-upload user consent.
  let pipeline=image.clone().rotate().resize({width:storageConfig.IMAGE_MAX_DIMENSION,height:storageConfig.IMAGE_MAX_DIMENSION,fit:'inside',withoutEnlargement:true}).keepMetadata();
  pipeline=mime==='image/png'?pipeline.png({compressionLevel:9,palette:false}):pipeline.jpeg({quality:storageConfig.IMAGE_WEB_QUALITY,mozjpeg:true});
  const candidate=await pipeline.toBuffer();return candidate.length<bytes.length?{bytes:candidate,mime,mode:'optimized-with-consent'}:{bytes,mime,mode:'original'};
 } catch(error){if((error as any).status)throw error;return fail(400,'The image is invalid or exceeds the safe pixel limit.');}
 finally{active--;}
}
