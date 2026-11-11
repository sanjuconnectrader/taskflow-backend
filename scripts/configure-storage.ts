import fs from 'node:fs';
import {parse} from 'dotenv';
const values=parse(fs.readFileSync('.env.storage','utf8'));let content=fs.readFileSync('.env','utf8');
for(const key of ['SUPABASE_SECRET_KEY','STORAGE_PROVIDER','SUPABASE_STORAGE_BUCKET'])if(values[key]){const line=`${key}=${values[key]}`;const pattern=new RegExp(`^${key}=.*$`,'m');content=pattern.test(content)?content.replace(pattern,()=>line):content.trimEnd()+'\n'+line+'\n';}
fs.writeFileSync('.env',content,{mode:0o600});
const {initializeSupabaseBucket}=await import('../src/storage/provider.js');
try{const bucket=await initializeSupabaseBucket();console.log(`Verified private Supabase Storage bucket: ${bucket}`);}catch(error){console.error(error instanceof Error?error.message:'Storage initialization failed.');process.exitCode=1;}
