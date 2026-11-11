import http from "node:http";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const snapshotFile = path.join(root, "data", "snapshots.json");
const port = Number(process.env.GOON_PORT || 4173);
const curlBin = process.platform === "win32" ? "curl.exe" : "/usr/bin/curl";
const sqliteBin = process.env.GOON_SQLITE_BIN;
const databaseFile = process.env.GOON_DB_FILE;
let databaseReady;

const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8" };
const send = (res, status, body, type="application/json; charset=utf-8") => { res.writeHead(status,{"content-type":type,"cache-control":"no-store"}); res.end(body); };

const sqlQuote=value=>`'${String(value).replace(/'/g,"''")}'`;
function sqlite(args,input){
  if(input===undefined) return new Promise((resolve,reject)=>execFile(sqliteBin,args,{maxBuffer:20*1024*1024},(error,stdout,stderr)=>error?reject(new Error(stderr||error.message)):resolve(stdout)));
  return new Promise((resolve,reject)=>{
    const child=spawn(sqliteBin,args,{stdio:['pipe','pipe','pipe']});
    const stdout=[],stderr=[];
    child.stdout.on('data',chunk=>stdout.push(chunk));
    child.stderr.on('data',chunk=>stderr.push(chunk));
    child.on('error',reject);
    child.on('close',code=>code===0?resolve(Buffer.concat(stdout).toString('utf8')):reject(new Error(Buffer.concat(stderr).toString('utf8')||`SQLite 退出码 ${code}`)));
    child.stdin.end(input,'utf8');
  });
}
async function ensureDatabase(){
  if(!sqliteBin||!databaseFile) return false;
  if(!databaseReady) databaseReady=(async()=>{
    await fs.mkdir(path.dirname(databaseFile),{recursive:true});
    const schema=`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS snapshots (date TEXT NOT NULL, source TEXT NOT NULL, items_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(date,source));
CREATE TABLE IF NOT EXISTS candidates (app_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'candidate', note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS labels (app_id TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(app_id,label));
CREATE TABLE IF NOT EXISTS activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, app_id TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, status TEXT NOT NULL, item_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`;
    await sqlite([databaseFile],schema);
    const count=Number((await sqlite(['-noheader',databaseFile,'SELECT count(*) FROM snapshots;'])).trim()||0);
    if(count===0){
      try{
        const legacy=JSON.parse(await fs.readFile(snapshotFile,'utf8'));
        if(legacy.length){
          const inserts=legacy.map(s=>`INSERT OR REPLACE INTO snapshots(date,source,items_json) VALUES(${sqlQuote(s.date)},${sqlQuote(s.source)},${sqlQuote(JSON.stringify(s.items))});`).join('\n');
          await sqlite([databaseFile],`PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; ${inserts} COMMIT;`);
        }
      }catch{}
    }
  })();
  await databaseReady;
  return true;
}
async function readSnapshots(){
  if(await ensureDatabase()){
    const output=await sqlite(['-json',databaseFile,'SELECT date,source,items_json FROM snapshots ORDER BY date,source;']);
    return JSON.parse(output||'[]').map(row=>({date:row.date,source:row.source,items:JSON.parse(row.items_json)}));
  }
  try { return JSON.parse(await fs.readFile(snapshotFile,"utf8")); } catch { return []; }
}
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
function parseJsonLd(html,type){
  const blocks=[...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for(const block of blocks){
    try{
      const parsed=JSON.parse(block[1]);
      const values=Array.isArray(parsed)?parsed:[parsed];
      const found=values.find(x=>x?.['@type']===type);
      if(found) return found;
    }catch{}
  }
  return null;
}
async function enrichGooglePlayItem(item,observedAt){
  const detailsUrl=`https://play.google.com/store/apps/details?id=${encodeURIComponent(item.id)}&hl=en&gl=US`;
  const html=await curlText([detailsUrl]);
  const meta=parseJsonLd(html,'SoftwareApplication');
  if(!meta) throw new Error(`Google Play 详情页未找到结构化数据：${item.id}`);
  const updatedMatch=html.match(/>Updated on<\/div><div[^>]*>([^<]+)<\/div>/i);
  const updatedTime=updatedMatch?new Date(updatedMatch[1]):null;
  return {
    ...item,
    detailsUrl,
    description:meta.description||null,
    developer:meta.author?.name||null,
    developerUrl:meta.author?.url||null,
    category:meta.applicationCategory||item.category,
    rating:meta.aggregateRating?.ratingValue?Number(meta.aggregateRating.ratingValue):null,
    ratingCount:meta.aggregateRating?.ratingCount?Number(meta.aggregateRating.ratingCount):0,
    updatedDate:updatedTime&&!Number.isNaN(updatedTime.getTime())?updatedTime.toISOString().slice(0,10):null,
    contentRating:meta.contentRating||null,
    iconUrl:meta.image||null,
    observedAt,
    fieldSources:{
      name:'AppsXRay 新品榜',position:'AppsXRay 新品榜',developer:'Google Play 官方详情页',description:'Google Play 官方详情页',category:'Google Play 官方详情页',rating:'Google Play 官方详情页',updatedDate:'Google Play 官方详情页'
    }
  };
}
async function saveSnapshot(source,date,items){
  if(await ensureDatabase()){
    const sql=`PRAGMA busy_timeout=5000; INSERT INTO snapshots(date,source,items_json) VALUES(${sqlQuote(date)},${sqlQuote(source)},${sqlQuote(JSON.stringify(items))}) ON CONFLICT(date,source) DO UPDATE SET items_json=excluded.items_json,created_at=CURRENT_TIMESTAMP;`;
    await sqlite([databaseFile],sql);
    return Number((await sqlite(['-noheader',databaseFile,`SELECT count(DISTINCT date) FROM snapshots WHERE source=${sqlQuote(source)};`])).trim()||0);
  }
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
  const rawItems = list.itemListElement.map(x=>({ id:x.url?.split("/").pop()||x.name, name:x.name, rank:x.position, source:"Google Play 新品榜", url:x.url, country:"美国", platform:"Android", category:"待聚类" }));
  const observedAt=new Date().toISOString();
  const enriched=await Promise.allSettled(rawItems.map(item=>enrichGooglePlayItem(item,observedAt)));
  const items=enriched.map((result,index)=>result.status==='fulfilled'?result.value:{...rawItems[index],observedAt,fieldSources:{name:'AppsXRay 新品榜',position:'AppsXRay 新品榜'},enrichmentError:result.reason.message});
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
  const observedAt=new Date().toISOString();
  const items=entries.map((x,index)=>({id:x.id?.attributes?.['im:id']||x.id?.label,name:x['im:name']?.label,rank:index+1,source:"App Store",url:x.link?.attributes?.href||x.id?.label,country:"美国",platform:"iOS",category:x.category?.attributes?.label||"待聚类",developer:x['im:artist']?.label||"待核验",launchDate:x['im:releaseDate']?.label?.slice(0,10)||"待核验",observedAt,fieldSources:{name:'Apple 新应用 Feed',position:'Apple 新应用 Feed（非市场排名）',developer:'Apple 新应用 Feed',launchDate:'Apple 新应用 Feed',category:'Apple 新应用 Feed'}}));
  const lookupBatches=[];
  for(let i=0;i<items.length;i+=50) lookupBatches.push(items.slice(i,i+50));
  const lookups=await Promise.allSettled(lookupBatches.map(batch=>curlText([`https://itunes.apple.com/lookup?id=${batch.map(x=>x.id).join(',')}&country=us&entity=software`])));
  const metadata=new Map();
  for(const result of lookups){
    if(result.status!=='fulfilled') continue;
    for(const app of JSON.parse(result.value).results||[]) metadata.set(String(app.trackId),app);
  }
  for(const item of items){
    const meta=metadata.get(String(item.id));
    if(!meta) continue;
    item.rating=meta.averageUserRating??null;
    item.ratingCount=meta.userRatingCount??0;
    item.version=meta.version||null;
    item.category=meta.primaryGenreName||item.category;
    item.description=meta.description||null;
    item.updatedDate=meta.currentVersionReleaseDate?.slice(0,10)||null;
    item.developerUrl=meta.sellerUrl||meta.artistViewUrl||null;
    item.contentRating=meta.trackContentRating||null;
    item.price=meta.formattedPrice||null;
    item.iconUrl=meta.artworkUrl100||null;
    item.fieldSources={...item.fieldSources,description:'Apple Lookup 官方接口',rating:'Apple Lookup 官方接口',version:'Apple Lookup 官方接口',updatedDate:'Apple Lookup 官方接口'};
  }
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
const clusterRules=[
  ['AI照片视频',/(ai photo|ai video|photo.*ai|video maker|portrait|image generator)/i],
  ['短剧观看',/(short drama|short film|reelshort|netshort|drama)/i],
  ['手机清理',/(clean|storage|battery|phone fix|file cleaner)/i],
  ['文件传输',/(file share|transfer|sharekaro|send files)/i],
  ['虚拟通话',/(prank call|video call|fake call|idol call)/i],
  ['购物优惠',/(coupon|deal|promo|shopping|marketplace|wishlist|shop|buy|sell)/i],
  ['AI助手',/(chatgpt|claude|gemini|grok|ai assistant|copilot)/i],
  ['社交通讯',/(messenger|telegram|whatsapp|instagram|threads|discord|social)/i],
  ['音乐创作',/(music maker|draw music|sound maker|audio editor)/i],
  ['音乐流媒体',/(spotify|music streaming|podcast player)/i],
  ['财务交易',/(finance|bank|capital one|paypal|stock trade|wallet)/i],
  ['求职招聘',/(job|career|indeed|resume|hire)/i],
  ['家庭安全',/(family|safety|gps|location tracker)/i],
  ['宗教阅读',/(bible|devotional|prayer|quran)/i],
  ['效率工具',/(productivity|authenticator|calendar|note|focus|email)/i]
];
function classifyDemand(item){
  const text=[item.name,item.subtitle,item.category].filter(Boolean).join(' ');
  const match=clusterRules.find(([,pattern])=>pattern.test(text));
  if(match) return {cluster:match[0],clusterMethod:'规则匹配'};
  return {cluster:item.category&&item.category!=='待聚类'?`类别：${item.category}`:'待聚类',clusterMethod:'类别回退'};
}
async function buildTrackedApps(){
  const snapshots=(await readSnapshots()).sort((a,b)=>a.date.localeCompare(b.date));
  const sources=[...new Set(snapshots.map(x=>x.source))];
  const apps=[];
  for(const source of sources){
    const sourceSnaps=snapshots.filter(x=>x.source===source);
    const latest=sourceSnaps.at(-1);
    const cutoff=new Date(`${latest.date}T00:00:00Z`).getTime()-7*864e5;
    const window=sourceSnaps.filter(x=>new Date(`${x.date}T00:00:00Z`).getTime()>=cutoff);
    for(const item of latest.items){
      const rankHistory=window.map(s=>({date:s.date,rank:s.items.find(x=>String(x.id)===String(item.id))?.rank})).filter(x=>Number.isFinite(x.rank));
      const isAppStore=source==='App Store';
      const rankDelta=!isAppStore&&rankHistory.length>1?rankHistory[0].rank-rankHistory.at(-1).rank:null;
      const ratingHistory=window.map(s=>{const found=s.items.find(x=>String(x.id)===String(item.id));return found&&Number.isFinite(found.ratingCount)?{date:s.date,rating:found.rating??null,ratingCount:found.ratingCount}:null}).filter(Boolean);
      const ratingCountDelta=ratingHistory.length>1?ratingHistory.at(-1).ratingCount-ratingHistory[0].ratingCount:null;
      const lastThree=rankHistory.slice(-3);
      const continuous=!isAppStore&&lastThree.length===3&&lastThree.every((x,i)=>i===0||x.rank<lastThree[i-1].rank);
      const trend=isAppStore?(rankHistory.length>=3?'持续出现':'待积累'):continuous?'连续上升':rankHistory.length<3?'待积累':rankDelta>0?'上升':rankDelta<0?'回落':'持平';
      const classified=classifyDemand(item);
      const developerKnown=Boolean(item.developer&&item.developer!=='待核验');
      const launchKnown=Boolean(item.launchDate&&item.launchDate!=='待核验');
      const ratingKnown=Number(item.ratingCount)>0;
      const descriptionKnown=Boolean(item.description);
      const dataStatus=!developerKnown||!descriptionKnown?'数据不足':rankHistory.length<3?'待积累':'基础可用';
      const fieldMeta={
        name:item.fieldSources?.name||'原始数据',
        position:item.fieldSources?.position||(isAppStore?'原始数据 · Feed位置（非市场排名）':'第三方榜单排名'),
        developer:developerKnown?(item.fieldSources?.developer||'原始数据'):'未获取',
        launchDate:launchKnown?(item.fieldSources?.launchDate||'原始数据'):'未获取',
        description:descriptionKnown?(item.fieldSources?.description||'原始数据'):'未获取',
        rating:ratingKnown?(item.fieldSources?.rating||'原始数据'):'暂无有效数据',
        updatedDate:item.updatedDate?(item.fieldSources?.updatedDate||'原始数据'):'未获取',
        cluster:classified.clusterMethod==='规则匹配'?'系统推断 · 关键词规则':'类别映射 · 非需求结论'
      };
      const trendChange=isAppStore?`连续出现 ${rankHistory.length} 天`:rankDelta===null?'至少3天后计算':`${rankDelta>0?'+':''}${rankDelta}名`;
      apps.push({...item,source,id:`${source}-${item.id}`,...classified,rankDelta,rankHistory,ratingHistory,ratingCountDelta,historyDays:rankHistory.length,trend,trendChange,dataStatus,fieldMeta,timeline:rankHistory.map(x=>`${x.date} · ${isAppStore?'Feed位置':'榜单排名'} #${x.rank}`)});
    }
  }
  const clusterPlatforms=new Map();
  for(const app of apps){
    if(app.cluster==='待聚类'||app.clusterMethod!=='规则匹配') continue;
    if(!clusterPlatforms.has(app.cluster)) clusterPlatforms.set(app.cluster,new Set());
    clusterPlatforms.get(app.cluster).add(app.platform);
  }
  for(const app of apps){
    const platforms=[...(clusterPlatforms.get(app.cluster)||[])];
    app.crossPlatform=platforms.includes('Android')&&platforms.includes('iOS');
    app.crossPlatforms=platforms;
    if(app.crossPlatform&&app.trend!=='连续上升') app.trend='跨平台信号';
  }
  return {updatedAt:snapshots.at(-1)?.date||null,apps};
}

const server=http.createServer(async(req,res)=>{
  try{
    if(req.url==="/api/sync/google-play"&&req.method==="POST") return send(res,200,JSON.stringify(await syncGooglePlay()));
    if(req.url==="/api/sync/app-store"&&req.method==="POST") return send(res,200,JSON.stringify(await syncAppStore()));
    if(req.url==="/api/sync/product-hunt"&&req.method==="POST") return send(res,200,JSON.stringify(await syncProductHunt()));
    if(req.url==="/api/sync/all"&&req.method==="POST") return send(res,200,JSON.stringify(await syncAll()));
    if(req.url==="/api/apps") return send(res,200,JSON.stringify(await buildTrackedApps()));
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
if(process.argv.includes('--sync-once')){
  syncAll().then(result=>{ console.log(JSON.stringify(result)); process.exit(0); }).catch(error=>{ console.error(error.message); process.exit(1); });
}else{
  server.listen(port,"127.0.0.1",()=>console.log(`Goon 趋势雷达：http://127.0.0.1:${port}`));
}
