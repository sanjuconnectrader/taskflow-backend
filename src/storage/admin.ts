import {Router} from 'express';
import {z} from 'zod';
import {authenticate,membership,fail} from '../security.js';
import {db} from '../db.js';
import {id} from '../validation.js';
import {storageUsage} from './usage.js';
import {maintenance} from './maintenance.js';
export const storageAdmin=Router();storageAdmin.use(authenticate);
storageAdmin.get('/workspaces/:wid',async(req,res)=>{
 const wid=id.parse(req.params.wid);await membership(wid,res.locals.user.id,false,true);
 const usage=await storageUsage();const workspace=await db.attachment.aggregate({where:{workspaceId:wid,confirmed:true},_count:true,_sum:{size:true}});
 const {applicationTables,...publicUsage}=usage;
 res.set('Cache-Control','private, no-store').json({...publicUsage,canRunMaintenance:res.locals.user.platformAdmin,workspace:{files:workspace._count,bytes:workspace._sum.size||0},...(res.locals.user.platformAdmin?{applicationTables}: {})});
});
storageAdmin.post('/maintenance',async(req,res)=>{
 if(!res.locals.user.platformAdmin)fail(403,'Platform operator access required for project-wide cleanup.');
 const {dryRun}=z.object({dryRun:z.boolean().default(true)}).parse(req.body);
 res.json(await maintenance(dryRun));
});
