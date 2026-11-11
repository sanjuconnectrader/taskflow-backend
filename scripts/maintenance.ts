import {maintenance} from '../src/storage/maintenance.js';
import {db} from '../src/db.js';
try{console.log(JSON.stringify(await maintenance(!process.argv.includes('--apply'))));}
finally{await db.$disconnect();}
