import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const snapshotFile = path.join(root, "data", "snapshots.json");
const port = Number(process.env.GOON_PORT || 4173);
const curlBin = process.platform === "win32" ? "curl.exe" : "/usr/bin/curl";

const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8" };
const send = (res, status, body, type="application/json; charset=utf-8") => { res.writeHead(status,{"content-type":type,"cache-control":"no-store"}); res.end(body); };

async function readSnapshots(){ try { return JSON.parse(await fs.readFile(snapshotFile,"utf8")); } catch { return []; } }
function fetchText(url){
  return new Promise((resolve,reject)=>{
    execFile(curlBin,["-4","-fsSL","--max-time","20","-A","Mozilla/5.0 GoonTrendRadar/0.1",url],{maxBuffer:10*1024*1024},(error,stdout)=>{
      if(!error||error.code===28&&stdout.includes('itemListElement')) return resolve(stdout);
      reject(new Error(error.killed?"榜单请求超时":`榜单请求失败：${error.message}`));
    });
  });
}
function curlText(args, acceptPartial=false){
  return new Promise((resolve,reject)=>{
    execFile(curlBin,["-4","-fsSL","--max-time","25","-A","Mozilla/5.0 GoonTrendRadar/0.2",...args],{maxBuffer:10*1024*1024},(error,stdout)=>{
      if(!error||acceptPartial&&error.code===28&&stdout.length>1000) return resolve(stdout);
      reject(new Error(error?.killed?"数据源请求超时":`数据源请求失败：${error?.message||"未知错误"}`));
    });
  });
}
async function saveSnapshot(source,date,items){
  const snapshots=await readSnapshots();
  const next=[...snapshots.filter(s=>!(s.date===date&&s.source===source)),{date,source,items}].slice(-180);
  await fs.writeFile(snapshotFile,JSON.stringify(next,null,2),"utf8");
  return new Set(next.filter(x=>x.source===source).map(x=>x.date)).size;
}
async function syncGooglePlay(){
  const html = await fetchText("https://appsxray.com/charts?chart=new-free");
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  let list;
  for(const block of blocks){
    try { const parsed=JSON.parse(block); const graph=parsed["@graph"]||[parsed]; list=graph.find(x=>x["@type"]==="ItemList"); if(list) break; } catch {}
  }
  if(!list?.itemListElement?.length) throw new Error("页面可访问，但没有识别到新品榜数据；数据源页面结构可能已变化。");
  const date = new Date().toISOString().slice(0,10);
  const items = list.itemListElement.map(x=>({ id:x.url?.split("/").pop()||x.name, name:x.name, rank:x.position, source:"Google Play 新品榜", url:x.url, country:"美国", platform:"Android", category:"待聚类" }));
  const historyDays=await saveSnapshot("Google Play 新品榜",date,items);
  return { source:"Google Play 新品榜",date,items,historyDays,sourceUrl:"https://appsxray.com/charts?chart=new-free" };
}
async function syncAppStore(){
  const sourceUrl="https://itunes.apple.com/us/rss/newapplications/limit=100/json";
  const data=JSON.parse(await curlText([sourceUrl]));
  if(!data?.feed?.entry?.length) throw new Error("Apple RSS 返回成功，但没有应用数据。");
  const date=new Date().toISOString().slice(0,10);
  const tomorrow=Date.now()+864e5;
  const entries=data.feed.entry.filter(x=>new Date(x['im:releaseDate']?.label||0).getTime()<=tomorrow).slice(0,100);
  const items=entries.map((x,index)=>({id:x.id?.attributes?.['im:id']||x.id?.label,name:x['im:name']?.label,rank:index+1,source:"App Store",url:x.link?.attributes?.href||x.id?.label,country:"美国",platform:"iOS",category:x.category?.attributes?.label||"待聚类",developer:x['im:artist']?.label||"待核验",launchDate:x['im:releaseDate']?.label?.slice(0,10)||"待核验"}));
  const historyDays=await saveSnapshot("App Store",date,items);
  return {source:"App Store",date,items,historyDays,sourceUrl};
}
async function syncProductHunt(){
  const token=process.env.PRODUCT_HUNT_TOKEN;
  if(!token) throw new Error("未配置 Product Hunt Token");
  const query=JSON.stringify({query:"{ posts(first: 30, order: NEWEST) { edges { node { id name tagline url createdAt votesCount website } } } }"});
  const data=JSON.parse(await curlText(["-H",`Authorization: Bearer ${token}`,"-H","Content-Type: application/json","--data-binary",query,"https://api.producthunt.com/v2/api/graphql"]));
  if(data.errors?.length) throw new Error(data.errors[0].message);
  const nodes=data?.data?.posts?.edges?.map(x=>x.node)||[];
  const date=new Date().toISOString().slice(0,10);
  const items=nodes.map((x,index)=>({id:x.id,name:x.name,rank:index+1,source:"Product Hunt",url:x.url,country:"全球",platform:"跨平台",category:"待聚类",developer:"待核验",launchDate:x.createdAt?.slice(0,10)||"待核验",subtitle:x.tagline,votesCount:x.votesCount}));
  const historyDays=await saveSnapshot("Product Hunt",date,items);
  return {source:"Product Hunt",date,items,historyDays,sourceUrl:"https://www.producthunt.com/"};
}
async function syncAll(){
  const sources=[['googlePlay',syncGooglePlay],['appStore',syncAppStore],['productHunt',syncProductHunt]];
  const settled=await Promise.allSettled(sources.map(x=>x[1]()));
  const results={},errors={};
  settled.forEach((result,index)=>result.status==='fulfilled'?results[sources[index][0]]=result.value:errors[sources[index][0]]=result.reason.message);
  if(!Object.keys(results).length) throw new Error(Object.values(errors).join('；'));
  return {date:new Date().toISOString().slice(0,10),results,errors};
}

const server=http.createServer(async(req,res)=>{
  try{
    if(req.url==="/api/sync/google-play"&&req.method==="POST") return send(res,200,JSON.stringify(await syncGooglePlay()));
    if(req.url==="/api/sync/app-store"&&req.method==="POST") return send(res,200,JSON.stringify(await syncAppStore()));
    if(req.url==="/api/sync/product-hunt"&&req.method==="POST") return send(res,200,JSON.stringify(await syncProductHunt()));
    if(req.url==="/api/sync/all"&&req.method==="POST") return send(res,200,JSON.stringify(await syncAll()));
    if(req.url==="/api/snapshots") return send(res,200,JSON.stringify(await readSnapshots()));
    const clean=req.url==="/"?"index.html":req.url.split("?")[0].replace(/^\//,"");
    const file=path.resolve(publicDir,clean);
    if(!file.startsWith(path.resolve(publicDir))) return send(res,403,"Forbidden","text/plain");
    const data=await fs.readFile(file);
    return send(res,200,data,mime[path.extname(file)]||"application/octet-stream");
  }catch(error){
    if(error.code==="ENOENT") return send(res,404,"Not found","text/plain");
    return send(res,500,JSON.stringify({error:error.message}));
  }
});
server.listen(port,"127.0.0.1",()=>console.log(`Goon 趋势雷达：http://127.0.0.1:${port}`));
