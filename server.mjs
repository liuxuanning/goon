import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpportunityService } from "./opportunity.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(root, ".env");
try {
  const envText = await fs.readFile(envFile, "utf8");
  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key && !process.env[key]) process.env[key] = value;
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

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
CREATE TABLE IF NOT EXISTS app_analysis (app_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL, review_status TEXT NOT NULL DEFAULT 'unreviewed', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
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
      reject(new Error(error?.killed?"榜单请求超时":"榜单请求失败，检查来源可用性"));
    });
  });
}
function curlText(args, acceptPartial=false){
  return new Promise((resolve,reject)=>{
    execFile(curlBin,["-4","-fsSL","--max-time","25","-A","Mozilla/5.0 GoonTrendRadar/0.2",...args],{maxBuffer:10*1024*1024},(error,stdout)=>{
      if(!error||acceptPartial&&error.code===28&&stdout.length>1000) return resolve(stdout);
      reject(new Error(error?.killed?"数据源请求超时":"数据源请求失败（网络或来源限制）"));
    });
  });
}
function parseJsonLd(html,type){
  const blocks=[...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for(const block of blocks){
    try{
      const parsed=JSON.parse(block[1]);
      const values=Array.isArray(parsed)?parsed:Array.isArray(parsed?.["@graph"])?parsed["@graph"]:[parsed];
      const found=values.find(x=>x?.['@type']===type);
      if(found) return found;
    }catch{}
  }
  return null;
}
function summarizeEnrichmentError(error){
  const message=String(error?.message||'');
  if(/404/.test(message)) return '详情页返回 404，应用详情可能不可用';
  if(/Could not connect|Failed to connect|Could not resolve host|timed out|timeout/i.test(message)) return '详情页暂时无法连接，基础字段未补齐';
  return '详情页采集失败，需人工核验';
}
function localIsoDate(value){
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}/.test(value))return value.slice(0,10);
  const date=new Date(value);
  if(Number.isNaN(date.getTime())) return null;
  return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
}
async function enrichGooglePlayItem(item,observedAt){
  const detailsUrl='https://play.google.com/store/apps/details?id='+encodeURIComponent(item.id)+'&hl=en&gl=US';
  let html,meta,metadataSource;
  try{
    html=await curlText([detailsUrl]);
    meta=parseJsonLd(html,'SoftwareApplication');
    if(!meta) throw new Error('Google Play 详情页未找到结构化数据');
    metadataSource='Google Play 官方详情页';
  }catch(officialError){
    html=await curlText([item.url]);
    meta=parseJsonLd(html,'SoftwareApplication');
    if(!meta) throw new Error('官方详情页不可用，AppsXRay 详情页也未提供结构化数据');
    metadataSource='AppsXRay 第三方应用详情页';
  }
  const updatedMatch=html.match(/>Updated on<\/div><div[^>]*>([^<]+)<\/div>/i);
  const updatedDate=updatedMatch?localIsoDate(updatedMatch[1]):meta.dateModified?localIsoDate(meta.dateModified):null;
  return {
    ...item,
    detailsUrl,
    metadataUrl:metadataSource==='Google Play 官方详情页'?detailsUrl:item.url,
    metadataSource,
    description:meta.description||null,
    developer:meta.author?.name||null,
    developerUrl:meta.author?.url||null,
    launchDate:meta.datePublished?localIsoDate(meta.datePublished):null,
    category:meta.applicationCategory||item.category,
    rating:meta.aggregateRating?.ratingValue?Number(meta.aggregateRating.ratingValue):null,
    ratingCount:meta.aggregateRating?.ratingCount?Number(meta.aggregateRating.ratingCount):0,
    updatedDate,
    contentRating:meta.contentRating||null,
    iconUrl:meta.image||null,
    price:meta.offers?.price??null,
    priceCurrency:meta.offers?.priceCurrency||null,
    observedAt,
    fieldSources:{
      name:'AppsXRay 新品榜',
      position:'AppsXRay 新品榜（第三方榜单位置）',
      developer:metadataSource,
      description:metadataSource,
      launchDate:meta.datePublished?metadataSource+' datePublished':'未获取',
      category:metadataSource,
      rating:metadataSource,
      updatedDate:metadataSource,
      price:metadataSource
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
  const items=enriched.map((result,index)=>result.status==='fulfilled'?result.value:{...rawItems[index],observedAt,fieldSources:{name:'AppsXRay 新品榜',position:'AppsXRay 新品榜（第三方榜单位置）'},enrichmentError:summarizeEnrichmentError(result.reason)});
  const historyDays=await saveSnapshot("Google Play 新品榜",date,items);
  return { source:"Google Play 新品榜",date,items,historyDays,enrichmentFailed:items.filter(item=>item.enrichmentError).length,sourceUrl:"https://appsxray.com/charts?chart=new-free" };
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
    item.fieldSources={...item.fieldSources,description:'Apple Lookup 官方接口',rating:'Apple Lookup 官方接口',version:'Apple Lookup 官方接口',updatedDate:'Apple Lookup 官方接口',price:'Apple Lookup 官方接口',officialUrl:'Apple Lookup 官方接口'};
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
  if(await ensureDatabase()){
    const statements=sources.map(([name],index)=>{
      const outcome=settled[index],ok=outcome.status==='fulfilled',count=ok?outcome.value.items.length:0;
      const message=ok?'':String(outcome.reason?.message||'采集失败').slice(0,250);
      return 'INSERT INTO sync_runs(source,status,item_count,error) VALUES('+sqlQuote(name)+','+sqlQuote(ok?'success':'failed')+','+count+','+sqlQuote(message)+');';
    }).join('\n');
    await sqlite([databaseFile],'PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; '+statements+' COMMIT;');
  }
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
async function buildTrackedApps(windowDays=7){
  const snapshots=(await readSnapshots()).sort((a,b)=>a.date.localeCompare(b.date));
  const sources=[...new Set(snapshots.map(x=>x.source))];
  const apps=[];
  for(const source of sources){
    const sourceSnaps=snapshots.filter(x=>x.source===source);
    const latest=sourceSnaps.at(-1);
    const cutoff=new Date(latest.date+'T00:00:00Z').getTime()-windowDays*864e5;
    const window=sourceSnaps.filter(x=>new Date(x.date+'T00:00:00Z').getTime()>=cutoff);
    const trackedIds=[...new Set(window.flatMap(snapshot=>snapshot.items.map(item=>String(item.id))))];
    for(const trackedId of trackedIds){
      const appearances=window.map(snapshot=>({snapshot,item:snapshot.items.find(x=>String(x.id)===trackedId)})).filter(entry=>entry.item);
      const item=appearances.at(-1).item;
      const lastSeenDate=appearances.at(-1).snapshot.date;
      const rankHistory=appearances.map(entry=>({date:entry.snapshot.date,rank:entry.item.rank})).filter(x=>Number.isFinite(x.rank));
      const isAppStore=source==='App Store';
      const rankDelta=!isAppStore&&rankHistory.length>1?rankHistory[0].rank-rankHistory.at(-1).rank:null;
      const ratingHistory=appearances.map(entry=>{const found=entry.item;return Number.isFinite(found.ratingCount)?{date:entry.snapshot.date,rating:found.rating??null,ratingCount:found.ratingCount}:null}).filter(Boolean);
      const ratingCountDelta=ratingHistory.length>1?ratingHistory.at(-1).ratingCount-ratingHistory[0].ratingCount:null;
      const lastThree=rankHistory.slice(-3);
      const continuous=!isAppStore&&lastThree.length===3&&lastThree.every((x,i)=>i===0||(x.rank<lastThree[i-1].rank&&new Date(x.date+'T00:00:00Z').getTime()-new Date(lastThree[i-1].date+'T00:00:00Z').getTime()===864e5));
      const trend=isAppStore?(rankHistory.length>=3?'多期出现':'待积累'):continuous?'连续上升':rankHistory.length<3?'待积累':rankDelta>0?'上升':rankDelta<0?'回落':'持平';
      const classified=classifyDemand(item);
      const developerKnown=Boolean(item.developer&&item.developer!=='待核验');
      const launchKnown=Boolean(item.launchDate&&item.launchDate!=='待核验');
      const ratingKnown=Number.isFinite(Number(item.ratingCount))&&Number(item.ratingCount)>=0&&Boolean(item.fieldSources?.rating||Number(item.ratingCount)>0);
      const descriptionKnown=Boolean(item.description);
      const requiredFields=[['description',descriptionKnown],['developer',developerKnown],['launchDate',launchKnown],['rating',ratingKnown],['officialUrl',Boolean(item.detailsUrl||item.url)]];
      const knownFields=requiredFields.filter(([,known])=>known).length;
      const missingFields=requiredFields.filter(([,known])=>!known).map(([field])=>field);
      const dataStatus=missingFields.some(field=>['description','developer','launchDate'].includes(field))?'数据不足':missingFields.length?'部分缺失':'基础可用';
      const dataQuality={coveragePercent:Math.round(knownFields/requiredFields.length*100),knownFields,totalFields:requiredFields.length,missingFields,historyDays:rankHistory.length,historyMaturity:rankHistory.length<3?'历史不足':rankHistory.length<7?'观察中':'可计算趋势',sourceTrust:isAppStore?'Apple 官方 Feed + Lookup':item.metadataSource==='AppsXRay 第三方应用详情页'?'AppsXRay 第三方榜单 + 第三方详情页':'AppsXRay 第三方榜单 + Google Play 官方详情补充',sourceLimitation:isAppStore?'Feed 序号仅表示 Feed 内位置，不代表市场排名':item.metadataSource==='AppsXRay 第三方应用详情页'?'产品描述、开发者和评分来自第三方详情页，关键字段仍需官方来源交叉核验':'榜单位置来自 AppsXRay，不能视为 Google Play 官方市场排名',enrichmentStatus:item.enrichmentError?'失败':'已完成或无需补全',enrichmentError:item.enrichmentError?summarizeEnrichmentError(item.enrichmentError):null};
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
      const trendChange=isAppStore?`出现 ${rankHistory.length} 期快照`:rankDelta===null?'至少3期后计算':`${rankDelta>0?'+':''}${rankDelta}名`;
      apps.push({...item,source,id:`${source}-${item.id}`,...classified,rankDelta,rankHistory,ratingHistory,ratingCountDelta,historyDays:rankHistory.length,lastSeenDate,trend,trendChange,dataStatus,dataQuality,fieldMeta,timeline:rankHistory.map(x=>`${x.date} · ${isAppStore?'Feed位置':'榜单排名'} #${x.rank}`)});
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
  if(await ensureDatabase()){
    const output=await sqlite(['-json',databaseFile,'SELECT app_id,input_hash,model,prompt_version,result_json,review_status,updated_at FROM app_analysis;']);
    const analyses=new Map(JSON.parse(output||'[]').map(row=>[row.app_id,{...JSON.parse(row.result_json),inputHash:row.input_hash,model:row.model,promptVersion:row.prompt_version,reviewStatus:row.review_status,analyzedAt:row.updated_at}]));
    for(const app of apps){
      const analysis=analyses.get(app.id)||null;
      app.aiAnalysis=analysis?{...analysis,stale:analysis.inputHash!==inputHash(analysisInput(app))||analysis.model!==process.env.ARK_MODEL||analysis.promptVersion!==analysisPromptVersion}:null;
    }
  }
  return {updatedAt:snapshots.at(-1)?.date||null,apps};
}

const analysisPromptVersion='demand-v4';
function normalizeText(value){ return String(value||'').replace(/\s+/g,' ').trim(); }
function analysisInput(app){
  return {id:app.id,name:app.name,platform:app.platform,category:app.category,description:normalizeText(app.description).slice(0,1600)};
}
function inputHash(input){ return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
function arkChat(messages){
  const apiKey=process.env.ARK_API_KEY,baseUrl=process.env.ARK_BASE_URL,model=process.env.ARK_MODEL;
  if(!apiKey||!baseUrl||!model) throw new Error('豆包分析尚未配置服务器环境变量');
  const endpoint=new URL(`${baseUrl.replace(/\/$/,'')}/chat/completions`);
  const body=JSON.stringify({model,messages,temperature:0.1,response_format:{type:'json_object'},max_tokens:5000});
  return new Promise((resolve,reject)=>{
    const req=https.request(endpoint,{method:'POST',headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        if(res.statusCode<200||res.statusCode>=300) return reject(new Error(`豆包接口 ${res.statusCode}：${text.replaceAll(apiKey,'[REDACTED]').slice(0,300)}`));
        try{ resolve(JSON.parse(text)); }catch{ reject(new Error('豆包接口返回了无效 JSON')); }
      });
    });
    req.setTimeout(120000,()=>req.destroy(new Error('豆包分析超时')));
    req.on('error',reject);
    req.end(body);
  });
}
async function analyzePendingDemands(limit=3){
  if(!(await ensureDatabase())) throw new Error('需求分析需要 SQLite 数据库');
  const tracked=await buildTrackedApps();
  const candidates=tracked.apps.filter(app=>app.description).map(app=>({app,input:analysisInput(app)}));
  const existingOutput=await sqlite(['-json',databaseFile,'SELECT app_id,input_hash,model,prompt_version FROM app_analysis;']);
  const existing=new Map(JSON.parse(existingOutput||'[]').map(row=>[row.app_id,row]));
  const allPending=candidates.filter(x=>{const prior=existing.get(x.app.id);return !prior||prior.input_hash!==inputHash(x.input)||prior.model!==process.env.ARK_MODEL||prior.prompt_version!==analysisPromptVersion});
  const pending=allPending.slice(0,Math.max(1,Math.min(20,limit)));
  if(!pending.length) return {analyzed:0,pending:0,model:process.env.ARK_MODEL||null,promptVersion:analysisPromptVersion,evidencePassed:0};
  const system="你是移动产品需求研究员。只根据输入的产品名、类别和产品描述提取“需求假设”，不能把产品功能描述伪装成真实用户反馈。不得推测收入、团队规模、市场成功、竞品缺陷或用户付费意愿。返回严格 JSON：{\"items\":[{\"id\":\"原ID\",\"demandLabel\":\"8至16字的具体需求标签\",\"user\":\"可能的目标用户\",\"job\":\"产品帮助用户完成的任务\",\"scenario\":\"可能的触发场景\",\"painPoint\":\"只有描述明确写出用户遇到的问题时才填写；否则必须写：描述未明确说明用户痛点\",\"painHypothesis\":\"若有直接依据，可写以推断：开头的待验证痛点假设；没有则写：暂无足够依据\",\"evidence\":\"description中的一个连续原文片段\",\"confidence\":0到1,\"uncertainty\":\"缺少什么证据\"}]}。每个输入必须恰好返回一次。标签描述用户需求而不是产品类别。严禁把功能缺失、广告、订阅、价格或竞品体验作为事实，除非输入描述明确写出。evidence是机器校验字段：只能从description逐字复制一个连续片段，不能删词、改词、翻译、改标点或拼接两处文字；英文复制5至15个连续单词，其他语言复制10至40个连续字符。confidence是模型自评，不是统计概率。";
  const response=await arkChat([{role:'system',content:system},{role:'user',content:JSON.stringify({items:pending.map(x=>x.input)})}]);
  const content=response.choices?.[0]?.message?.content;
  if(!content) throw new Error('豆包未返回分析内容');
  const parsed=JSON.parse(content.replace(/^```json\s*|\s*```$/g,''));
  if(!Array.isArray(parsed.items)) throw new Error('豆包返回缺少 items 数组');
  const expectedIds=new Set(pending.map(x=>x.app.id)),seenIds=new Set();
  for(const item of parsed.items){
    if(!expectedIds.has(item.id)) throw new Error('豆包返回了未请求的应用 ID');
    if(seenIds.has(item.id)) throw new Error('豆包重复返回应用 ID');
    seenIds.add(item.id);
  }
  if(seenIds.size!==expectedIds.size) throw new Error('豆包结果不完整，缺少部分应用 ID；本批次未写入');
  const returned=new Map(parsed.items.map(item=>[item.id,item]));
  const rows=[];
  for(const {app,input} of pending){
    const raw=returned.get(app.id);
    if(!raw) throw new Error('豆包结果缺少请求中的应用 ID；本批次未写入');
    const evidence=normalizeText(raw.evidence).slice(0,100);
    const evidenceStart=evidence?input.description.indexOf(evidence):-1;
    const evidenceValid=evidenceStart>=0;
    const result={demandLabel:normalizeText(raw.demandLabel).slice(0,40),user:normalizeText(raw.user).slice(0,80),job:normalizeText(raw.job).slice(0,160),scenario:normalizeText(raw.scenario).slice(0,160),painPoint:normalizeText(raw.painPoint).slice(0,160),painHypothesis:normalizeText(raw.painHypothesis).slice(0,200),evidence,evidenceKind:'产品描述原文（非用户反馈）',evidenceSourceField:'description',evidenceStart:evidenceValid?evidenceStart:null,evidenceEnd:evidenceValid?evidenceStart+evidence.length:null,confidence:Math.max(0,Math.min(1,Number(raw.confidence)||0)),uncertainty:normalizeText(raw.uncertainty).slice(0,200),evidenceValid};
    rows.push({appId:app.id,input,hash:inputHash(input),result});
  }
  if(!rows.length) throw new Error('豆包结果未通过应用 ID 校验');
  const statements=rows.map(row=>`INSERT INTO app_analysis(app_id,input_hash,model,prompt_version,input_json,result_json) VALUES(${sqlQuote(row.appId)},${sqlQuote(row.hash)},${sqlQuote(process.env.ARK_MODEL)},${sqlQuote(analysisPromptVersion)},${sqlQuote(JSON.stringify(row.input))},${sqlQuote(JSON.stringify(row.result))}) ON CONFLICT(app_id) DO UPDATE SET input_hash=excluded.input_hash,model=excluded.model,prompt_version=excluded.prompt_version,input_json=excluded.input_json,result_json=excluded.result_json,review_status='unreviewed',updated_at=CURRENT_TIMESTAMP;`).join('\n');
  await sqlite([databaseFile],`PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; ${statements} COMMIT;`);
  return {analyzed:rows.length,pending:Math.max(0,allPending.length-rows.length),model:process.env.ARK_MODEL,promptVersion:analysisPromptVersion,evidencePassed:rows.filter(x=>x.result.evidenceValid).length};
}

const opportunities=createOpportunityService({sqlite,ensureDatabase,sqlQuote,buildTrackedApps});
async function jsonBody(req){
  let total=0; const chunks=[];
  for await(const part of req){total+=part.length;if(total>128*1024)throw Object.assign(new Error('请求内容超出上限'),{status:413});chunks.push(part);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
  catch{throw Object.assign(new Error('无效 JSON'),{status:400});}
}
const server=http.createServer(async(req,res)=>{
  try{
    const requestUrl=new URL(req.url,'http://127.0.0.1');
    if(requestUrl.pathname==='/api/candidates'){
      const actor=opportunities.trustedUser(req);
      if(!actor)return send(res,401,JSON.stringify({error:'需要审核员令牌'}));
      if(req.method==='GET')return send(res,200,JSON.stringify(await opportunities.listCandidates()));
      if(req.method==='POST')return send(res,200,JSON.stringify(await opportunities.setCandidate(actor,await jsonBody(req))));
      return send(res,405,JSON.stringify({error:'不支持此方法'}));
    }
    if(requestUrl.pathname.startsWith('/api/opportunities/')){
      const actor=opportunities.trustedUser(req);
      if(!actor)return send(res,401,JSON.stringify({error:'请使用审核员令牌；服务端需配置两位不同审核员'}));
      const appId=decodeURIComponent(requestUrl.pathname.slice('/api/opportunities/'.length));
      if(!appId||appId.length>300) return send(res,400,JSON.stringify({error:'无效应用 ID'}));
      if(req.method==='GET')return send(res,200,JSON.stringify(await opportunities.list(appId)));
      if(req.method==='POST'){
        const input=await jsonBody(req);
        const action=String(input.action||'');
        const result=action==='evidence'?await opportunities.addEvidence(appId,actor,input):
          action==='verify'?await opportunities.verifyEvidence(appId,actor,input):
          action==='review'?await opportunities.review(appId,actor,input):
          action==='appleReviews'?await (async()=>{
            if(!appId.startsWith('App Store-')||!/^\d+$/.test(appId.slice(10)))throw Object.assign(new Error('仅支持 App Store 应用'),{status:400});
            const id=appId.slice(10);
            const feed=JSON.parse(await curlText(['https://itunes.apple.com/us/rss/customerreviews/id='+id+'/sortby=mostrecent/json']));
            return opportunities.importAppStoreReviews(appId,actor,feed);
          })():
          null;
        if(!result)return send(res,400,JSON.stringify({error:'未知操作'}));
        return send(res,200,JSON.stringify(result));
      }
      return send(res,405,JSON.stringify({error:'不支持此方法'}));
    }
    if(req.method==='POST'&&!opportunities.trustedUser(req))return send(res,401,JSON.stringify({error:'执行同步或模型分析需要有效审核员令牌'}));
    if(req.url==="/api/sync/google-play"&&req.method==="POST") return send(res,200,JSON.stringify(await syncGooglePlay()));
    if(req.url==="/api/sync/app-store"&&req.method==="POST") return send(res,200,JSON.stringify(await syncAppStore()));
    if(req.url==="/api/sync/product-hunt"&&req.method==="POST") return send(res,200,JSON.stringify(await syncProductHunt()));
    if(req.url==="/api/sync/all"&&req.method==="POST") return send(res,200,JSON.stringify(await syncAll()));
    if(requestUrl.pathname==="/api/apps"){const windowDays=Number(requestUrl.searchParams.get('window'))===30?30:7;return send(res,200,JSON.stringify(await buildTrackedApps(windowDays)));}
    if(req.url==="/api/snapshots") return send(res,200,JSON.stringify(await readSnapshots()));
    if(req.url==="/api/sync-runs"){
      if(!opportunities.trustedUser(req))return send(res,401,JSON.stringify({error:'需要审核员令牌'}));
      if(!await ensureDatabase())return send(res,503,JSON.stringify({error:'需要 SQLite'}));
      const history=await sqlite(['-json',databaseFile,'SELECT id,source,status,item_count,error,created_at FROM sync_runs ORDER BY id DESC LIMIT 100;']);
      return send(res,200,JSON.stringify({runs:JSON.parse(history||'[]')}));
    }
    if(requestUrl.pathname==="/api/analyze/demands"&&req.method==="POST") return send(res,200,JSON.stringify(await analyzePendingDemands(Number(requestUrl.searchParams.get('limit')||3))));
    const clean=req.url==="/"?"index.html":req.url.split("?")[0].replace(/^\//,"");
    const file=path.resolve(publicDir,clean);
    if(!file.startsWith(path.resolve(publicDir))) return send(res,403,"Forbidden","text/plain");
    const data=await fs.readFile(file);
    return send(res,200,data,mime[path.extname(file)]||"application/octet-stream");
  }catch(error){
    if(error.code==="ENOENT") return send(res,404,"Not found","text/plain");
    return send(res,error.status||500,JSON.stringify({error:error.message}));
  }
});
if(process.argv.includes('--sync-once')){
  syncAll().then(result=>{ console.log(JSON.stringify({date:result.date,counts:Object.fromEntries(Object.entries(result.results).map(([k,v])=>[k,v.items.length])),errors:result.errors})); process.exit(0); }).catch(error=>{ console.error(error.message); process.exit(1); });
}else{
  server.listen(port,"127.0.0.1",()=>console.log(`Goon 趋势雷达：http://127.0.0.1:${port}`));
}
