import 'dotenv/config';
import {spawnSync} from 'node:child_process';
const url=new URL(process.env.TEST_DATABASE_URL||process.env.DATABASE_URL!);if(!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('Set a local TEST_DATABASE_URL before test migrations.');url.pathname='/taskflow_test';
const result=spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{env:{...process.env,DATABASE_URL:url.toString(),DIRECT_URL:url.toString(),DIRECT_DATABASE_URL:url.toString()},stdio:'inherit'});if(result.error)throw result.error;process.exit(result.status??1);
