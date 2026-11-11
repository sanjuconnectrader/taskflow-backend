import {db} from '../db.js';
import {objectStore,type Location} from './provider.js';
export async function enqueueDeletion(locationId:number,key:string){
 await db.storageDeletion.upsert({where:{locationId_key:{locationId,key}},create:{locationId,key},update:{}});
}
export async function drainDeletions(limit=100){
 const rows=await db.storageDeletion.findMany({where:{nextAttemptAt:{lte:new Date()},locationId:{not:null}},include:{location:true},take:limit,orderBy:[{nextAttemptAt:'asc'},{id:'asc'}]});let deleted=0;
 for(const row of rows){
  // Never remove a key that is still referenced by a live attachment.
  if(await db.attachment.count({where:{locationId:row.locationId,key:row.key}}))continue;
  try{await objectStore(row.location as Location).remove(row.key);await db.storageDeletion.deleteMany({where:{id:row.id}});deleted++;}
  catch{await db.storageDeletion.updateMany({where:{id:row.id},data:{attempts:{increment:1},lastError:'OBJECT_DELETE_FAILED',nextAttemptAt:new Date(Date.now()+Math.min(86400000,60000*2**Math.min(row.attempts,10)))}});}
 }return {deleted,remaining:await db.storageDeletion.count()};
}
