import 'dotenv/config';
const url = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL!);
url.pathname = '/taskflow_test';
if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('Local test database required');
process.env.DATABASE_URL = url.toString();
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:4173,http://localhost:3000';
process.env.PORT = '4000';
await import('../src/server.js');
