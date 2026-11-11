import { Router } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { authenticate, fail } from './security.js';

type Asset = { id:number; name:string; size:number };
type Release = { tag_name:string; draft:boolean; prerelease:boolean; assets:Asset[] };
const repos = {desktop:'sanjuconnectrader/taskflow-desktop',mobile:'sanjuconnectrader/taskflow-mobile'} as const;
type Platform = keyof typeof repos;
const tickets = new Map<string,{asset:Asset; expires:number}>();
const cache = new Map<Platform,{expires:number;value:{release:Release;artifact:Asset}}>();
const pending = new Map<Platform,Promise<{release:Release;artifact:Asset}>>();
async function github(path:string, accept='application/vnd.github+json') {
  const response = await fetch(`https://api.github.com${path}`, {headers:{...(process.env.GITHUB_RELEASE_READ_TOKEN ? {Authorization:`Bearer ${process.env.GITHUB_RELEASE_READ_TOKEN}`} : {}), Accept:accept, 'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'TaskFlow-Update-Service'}, signal:AbortSignal.timeout(accept==='application/octet-stream' ? 900_000 : 15000)});
  if (!response.ok) fail(503, 'The update service is temporarily unavailable.');
  return response;
}
async function latest(platform:Platform) {
  const cached=cache.get(platform);if(cached && cached.expires>Date.now())return cached.value;
  const running=pending.get(platform);if(running)return running;
  const operation=loadLatest(platform);pending.set(platform,operation);
  try {const value=await operation;cache.set(platform,{value,expires:Date.now()+60_000});return value;} finally {pending.delete(platform);}
}
async function loadLatest(platform:Platform) {
  const release = await (await github(`/repos/${repos[platform]}/releases/latest`)).json() as Release;
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) fail(503,'No production release is available.');
  const artifact = release.assets.find(a => platform === 'mobile' ? a.name === 'app-release.apk' : a.name === `TaskFlow-${release.tag_name.slice(1)}-Setup.exe`);
  if (!artifact || (platform === 'desktop' && !release.assets.some(a=>a.name==='latest.yml'))) fail(503,'Release artifacts are not ready.');
  return {release, artifact:artifact!};
}
async function streamAsset(platform:Platform, asset:Asset, res:any) {
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 500_000_000) fail(503,'Release artifact is invalid.');
  const response = await github(`/repos/${repos[platform]}/releases/assets/${asset.id}`, 'application/octet-stream');
  if (!response.body || response.headers.get('content-type')?.includes('application/json')) fail(503,'Release artifact is unavailable.');
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Content-Type','application/octet-stream');
  res.setHeader('Content-Disposition',`attachment; filename="${asset.name}"`);
  res.setHeader('Content-Length',String(asset.size));
  await pipeline(Readable.fromWeb(response.body as any),res);
}
export const updates = Router();
// The short-lived, single-use download capability allows Android's system browser
// to hand the APK to the package installer without exposing the GitHub credential.
updates.get('/mobile/download',async (req,res)=>{
  const key=typeof req.query.ticket==='string'?req.query.ticket:'';
  const item=tickets.get(key); tickets.delete(key);
  if(!item || item.expires<Date.now()) fail(404,'Download link expired. Check for updates again.');
  await streamAsset('mobile',item!.asset,res);
});
updates.use(authenticate);
updates.get('/:platform',async(req,res)=>{
  const platform=req.params.platform as Platform;
  if(!Object.hasOwn(repos,platform)) fail(404,'Platform not supported.');
  const {release,artifact}=await latest(platform);
  res.setHeader('Cache-Control','no-store');
  res.json({version:release.tag_name.slice(1), artifact:artifact.name});
});
updates.post('/mobile/ticket',async(_req,res)=>{
  const {artifact}=await latest('mobile');
  for(const [key,item] of tickets) if(item.expires<Date.now()) tickets.delete(key);
  if(tickets.size>=1000) fail(503,'Try again later.');
  const key=randomBytes(32).toString('base64url');
  tickets.set(key,{asset:artifact,expires:Date.now()+120_000});
  res.setHeader('Cache-Control','no-store');
  res.json({path:`/api/v1/updates/mobile/download?ticket=${key}`});
});
updates.get('/desktop/assets/:name',async(req,res)=>{
  const {release}=await latest('desktop');
  const name=req.params.name;
  if(!/^(latest\.yml|TaskFlow-\d+\.\d+\.\d+-Setup\.exe(?:\.blockmap)?)$/.test(name)) fail(404,'Artifact not found.');
  const asset=release.assets.find(a=>a.name===name);
  if(!asset) fail(404,'Artifact not found.');
  await streamAsset('desktop',asset!,res);
});
