import {currentLocation,objectStore} from '../src/storage/provider.js';
import {fileUsage} from '../src/storage/usage.js';
import {db} from '../src/db.js';
const location=currentLocation();if(!location)throw new Error('Private storage is not configured.');
const store=objectStore(location);const key=`temporary/${crypto.randomUUID()}`;const data=Buffer.from('TaskFlow storage verification — UTF-8 exact round trip 🔐\n');
try{
 const before=await fileUsage();const url=await store.signedUpload(key,'text/plain',data.length);
 const upload=await fetch(url,{method:'PUT',headers:{'Content-Type':'text/plain'},body:data});if(!upload.ok)throw new Error(`Signed upload failed (${upload.status}).`);
 const info=await store.info(key);if(info.size!==data.length)throw new Error('Stored file size mismatch.');
 const downloaded=await store.download(key,data.length,info.etag);if(!downloaded.equals(data))throw new Error('Stored bytes changed.');
 const signed=await store.signedDownload(key,'verification.txt');const response=await fetch(signed);if(!response.ok||!Buffer.from(await response.arrayBuffer()).equals(data))throw new Error('Private signed download failed.');
 const during=await fileUsage();if(before.used!==null&&during.used!==null&&during.used<before.used+data.length)throw new Error('Storage usage accounting did not include the probe.');
 console.log(JSON.stringify({signedUpload:true,privateSignedDownload:true,exactBytes:true,size:data.length,usageAccounted:true}));
}finally{await store.remove(key);await db.$disconnect();console.log('Temporary storage verification object removed.');}
