import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const snapshotFile = path.join(root, "data", "snapshots.json");
const port = Number(process.env.GOON_PORT || 4173);

const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8" };
const send = (res, status, body, type="application/json; charset=utf-8") => { res.writeHead(status,{"content-type":type,"cache-control":"no-store"}); res.end(body); };

async function readSnapshots(){ try { return JSON.parse(await fs.readFile(snapshotFile,"utf8")); } catch { return []; } }
function fetchText(url){
  return new Promise((resolve,reject)=>{
    const request=https.get(url,{headers:{"user-agent":"Mozilla/5.0 GoonTrendRadar/0.1"}},response=>{
      if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){ response.resume(); return resolve(fetchText(new URL(response.headers.location,url))); }
      let body=""; response.setEncoding("utf8"); response.on("data",chunk=>body+=chunk); response.on("end",()=>response.statusCode>=200&&response.statusCode<300?resolve(body):reject(new Error(`榜单请求失败：HTTP ${response.statusCode}`)));
    });
    request.setTimeout(20000,()=>request.destroy(new Error("榜单请求超时"))); request.on("error",reject);
  });
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
  const snapshots=await readSnapshots();
  const next=[...snapshots.filter(s=>!(s.date===date&&s.source==="Google Play 新品榜")),{date,source:"Google Play 新品榜",items}].slice(-90);
  await fs.writeFile(snapshotFile,JSON.stringify(next,null,2),"utf8");
  return { date, items, historyDays:new Set(next.map(x=>x.date)).size, sourceUrl:"https://appsxray.com/charts?chart=new-free" };
}

const server=http.createServer(async(req,res)=>{
  try{
    if(req.url==="/api/sync/google-play"&&req.method==="POST") return send(res,200,JSON.stringify(await syncGooglePlay()));
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
