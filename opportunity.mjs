// Evidence-first opportunity research. All claims and reviewer decisions are stored server-side.
const TYPES = new Set(['user_review','community','pricing','competitor','search','other']);
const VERDICTS = new Set(['approve','observe','reject']);
const SCORE_KEYS=['demand','growth','payment','competition','feasibility'];
const SCORE_WEIGHTS={demand:0.30,growth:0.25,payment:0.20,competition:0.15,feasibility:0.10};
const clean = (v,max=2000)=>String(v??'').trim().slice(0,max);
const isUrl = v=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&Boolean(u.hostname)&&!['localhost','127.0.0.1'].includes(u.hostname);}catch{return false;}};
const domainOf=v=>{try{return new URL(v).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}};
const trustedUser = req=>{
  if(process.env.GOON_REQUIRE_HTTPS==='1'&&req.headers['x-forwarded-proto']!=='https')return null;
  const auth=String(req.headers.authorization||'').match(/^Bearer (.+)$/);
  if(!auth) return null;
  const {GOON_REVIEWER_A_TOKEN:a,GOON_REVIEWER_B_TOKEN:b}=process.env;
  if(!a||!b||a===b) return null;
  // Compare digests, not plaintext, and never log authorization.
  const crypto={createHash,timingSafeEqual};
  const hashed = x=>crypto.createHash('sha256').update(x).digest();
  const supplied=hashed(auth[1]);
  if(crypto.timingSafeEqual(supplied,hashed(a))) return 'reviewer_a';
  if(crypto.timingSafeEqual(supplied,hashed(b))) return 'reviewer_b';
  return null;
};
import {createHash,timingSafeEqual} from 'node:crypto';

export function createOpportunityService({sqlite,ensureDatabase,sqlQuote,buildTrackedApps}){
  let schemaReady;
  async function ready(){
    if(!schemaReady) schemaReady=(async()=>{
    if(!await ensureDatabase()) throw Object.assign(new Error('协作功能需要 SQLite'),{status:503});
    await sqlite(['-batch',process.env.GOON_DB_FILE],`PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS opportunity_evidence (
 id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, type TEXT NOT NULL,
 source_url TEXT NOT NULL, source_domain TEXT NOT NULL, quote TEXT NOT NULL,
 context TEXT NOT NULL, collector TEXT NOT NULL, captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 status TEXT NOT NULL DEFAULT 'pending', verified_by TEXT, verified_at TEXT,
 CHECK(type IN ('user_review','community','pricing','competitor','search','other'))
);
CREATE TABLE IF NOT EXISTS opportunity_review (
 app_id TEXT NOT NULL, reviewer TEXT NOT NULL, verdict TEXT NOT NULL, note TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(app_id,reviewer)
);
CREATE TABLE IF NOT EXISTS opportunity_assessment (app_id TEXT NOT NULL, reviewer TEXT NOT NULL, ratings_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(app_id,reviewer));
CREATE TABLE IF NOT EXISTS candidate_workflow (app_id TEXT PRIMARY KEY, status TEXT NOT NULL, assigned_to TEXT, note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS opportunity_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
 app_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
); `);
    })().catch(error=>{schemaReady=null;throw error;});
    return schemaReady;
  }
  async function readRows(query){
    await ready();
    const data=await sqlite(['-json',process.env.GOON_DB_FILE,query]);
    return JSON.parse(data||'[]');
  }
  async function execute(sql){await ready();return sqlite([process.env.GOON_DB_FILE],`PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; ${sql} COMMIT;`);}
  const quoted = obj=>sqlQuote(JSON.stringify(obj));
  const knownApp = async appId=>(await buildTrackedApps(30)).apps.some(a=>a.id===appId);
  async function list(appId){
    if(!await knownApp(appId)) throw Object.assign(new Error('未知应用'),{status:404});
    // On Windows, concurrent short-lived SQLite CLI readers can contend with WAL initialization.
    // Sequential reads preserve deterministic audit snapshots and avoid intermittent SQLITE_BUSY.
    const evidence=await readRows(`SELECT * FROM opportunity_evidence WHERE app_id=${sqlQuote(appId)} ORDER BY id DESC;`);
    const reviews=await readRows(`SELECT reviewer,verdict,note,updated_at FROM opportunity_review WHERE app_id=${sqlQuote(appId)} ORDER BY reviewer;`);
    const audit=await readRows(`SELECT actor,action,payload,created_at FROM opportunity_audit WHERE app_id=${sqlQuote(appId)} ORDER BY id DESC LIMIT 40;`);
    const assessments=await readRows(`SELECT reviewer,ratings_json,created_at FROM opportunity_assessment WHERE app_id=${sqlQuote(appId)} ORDER BY reviewer;`);    const accepted=evidence.filter(e=>e.status==='verified');
    const domains=new Set(accepted.map(x=>x.source_domain));
    const types=new Set(accepted.map(x=>x.type));
    const app=(await buildTrackedApps(30)).apps.find(a=>a.id===appId);
    const assessmentData=assessments.map(x=>({reviewer:x.reviewer,ratings:JSON.parse(x.ratings_json),createdAt:x.created_at}));
    const hasEvidenceForEachKey=(types.has('user_review')||types.has('community'))&&types.has('pricing')&&types.has('competitor')&&app.historyDays>=7;
    const completeRatings=assessmentData.length===2&&assessmentData.every(a=>SCORE_KEYS.every(k=>Number.isInteger(a.ratings[k])&&a.ratings[k]>=0&&a.ratings[k]<=5));
    const canScore=hasEvidenceForEachKey&&completeRatings&&domains.size>=3&&reviews.length===2;
    const score=canScore?Math.round(SCORE_KEYS.reduce((n,key)=>n+(assessmentData[0].ratings[key]+assessmentData[1].ratings[key])/2/5*100*SCORE_WEIGHTS[key],0)):null;
    const missingScoreConditions=[
      ...(!(types.has('user_review')||types.has('community'))?['经核验的真实用户反馈']:[]),
      ...(!types.has('pricing')?['经核验的公开价格']:[]),
      ...(!types.has('competitor')?['经核验的竞品对比']:[]),
      ...(app.historyDays<7?['至少7期历史快照']:[]),
      ...(domains.size<3?['至少3个独立来源域名']:[]),
      ...(!completeRatings?['两名审核员完成五维0–5分独立评价']:[])
    ];
    const opportunity={
      sourceCoverage:{verifiedEvidence:accepted.length,independentDomains:domains.size,types:[...types],unverifiedEvidence:evidence.length-accepted.length},
      dimensions:{
        demand:types.has('user_review')||types.has('community')?'有用户反馈证据':'待验证',
        growth:app.historyDays>=7?'有7期及以上快照，仍需确认排名可比性':'历史快照不足',
        willingnessToPay:types.has('pricing')?'存在价格/付费信息，尚不能等同真实付费意愿':'缺乏付费证据',
        competition:types.has('competitor')?'存在竞品证据，竞争强度仍需分析':'缺乏竞品证据',
        feasibility:'需人工技术/运营成本核验'
      },
      score,
      scoreType:score===null?null:'两名审核员的主观加权评分（非预测成功概率）',
      assessmentData,
      scoreWeights:SCORE_WEIGHTS,
      missingScoreConditions,
      scoringStatus:canScore?'满足证据门槛，人工评价分仅供机会比较':'证据不足，不输出虚假综合分',
      decision:reviews.length<2?'待双人独立复核':reviews.some(r=>r.verdict==='reject')?'否决':reviews.every(r=>r.verdict==='approve')&&canScore?'通过（需业务验证）':'观察'
    };
    return {appId,evidence,reviews,audit,opportunity};
  }
  async function addEvidence(appId,actor,input){
    if(!await knownApp(appId)) throw Object.assign(new Error('未知应用'),{status:404});
    const type=clean(input.type,25),url=clean(input.sourceUrl,1500),quote=clean(input.quote,1200),context=clean(input.context,1000);
    if(!TYPES.has(type)||!isUrl(url)||quote.length<10||context.length<8)
      throw Object.assign(new Error('证据需类型、公开 URL、至少10字原文和至少8字上下文'),{status:400});
    // Submitted excerpts are user-supplied: pending until a different reviewer confirms the actual source.
    const payload={type,url,quote,context};
    await execute(`INSERT INTO opportunity_evidence(app_id,type,source_url,source_domain,quote,context,collector)
VALUES(${sqlQuote(appId)},${sqlQuote(type)},${sqlQuote(url)},${sqlQuote(domainOf(url))},${sqlQuote(quote)},${sqlQuote(context)},${sqlQuote(actor)});
INSERT INTO opportunity_audit(actor,action,app_id,payload) VALUES(${sqlQuote(actor)},'evidence_submitted',${sqlQuote(appId)},${quoted(payload)});`);
    return list(appId);
  }
  async function verifyEvidence(appId,actor,input){
    const id=Number(input.evidenceId),status=input.status;
    if(!Number.isSafeInteger(id)||id<1||!['verified','rejected'].includes(status)) throw Object.assign(new Error('审核参数不合法'),{status:400});
    const rows=await readRows(`SELECT id,collector,status FROM opportunity_evidence WHERE id=${id} AND app_id=${sqlQuote(appId)};`);
    const row=rows[0];
    if(!row)throw Object.assign(new Error('证据不存在'),{status:404});
    if(row.collector===actor)throw Object.assign(new Error('不能审核自己提交的证据'),{status:403});
    if(row.status!=='pending')throw Object.assign(new Error('证据已处理，不能覆盖既有审计'),{status:409});
    await execute(`UPDATE opportunity_evidence SET status=${sqlQuote(status)},verified_by=${sqlQuote(actor)},verified_at=CURRENT_TIMESTAMP WHERE id=${id} AND status='pending';
INSERT INTO opportunity_audit(actor,action,app_id,payload) VALUES(${sqlQuote(actor)},'evidence_reviewed',${sqlQuote(appId)},${quoted({id,status})});`);
    return list(appId);
  }
  async function review(appId,actor,input){
    if(!await knownApp(appId))throw Object.assign(new Error('未知应用'),{status:404});
    const verdict=clean(input.verdict,12),note=clean(input.note,1000),ratings=input.ratings;
    if(!VERDICTS.has(verdict)||note.length<8)throw Object.assign(new Error('需要有效复核结论和至少8字理由'),{status:400});
    if(!ratings||SCORE_KEYS.some(k=>!Number.isInteger(ratings[k])||ratings[k]<0||ratings[k]>5))throw Object.assign(new Error('请完整填写五维0–5分人工评价'),{status:400});
    const existing=await readRows(`SELECT 1 AS present FROM opportunity_review WHERE app_id=${sqlQuote(appId)} AND reviewer=${sqlQuote(actor)};`);
    if(existing.length)throw Object.assign(new Error('复核已提交，不允许覆盖；请通过追加记录修订流程处理'),{status:409});
    await execute(`INSERT INTO opportunity_review(app_id,reviewer,verdict,note) VALUES(${sqlQuote(appId)},${sqlQuote(actor)},${sqlQuote(verdict)},${sqlQuote(note)});
INSERT INTO opportunity_assessment(app_id,reviewer,ratings_json) VALUES(${sqlQuote(appId)},${sqlQuote(actor)},${quoted(Object.fromEntries(SCORE_KEYS.map(k=>[k,ratings[k]])))});
INSERT INTO opportunity_audit(actor,action,app_id,payload) VALUES(${sqlQuote(actor)},'independent_review',${sqlQuote(appId)},${quoted({verdict,note,ratings})});`);
    return list(appId);
  }
  async function importAppStoreReviews(appId,actor,feed){
    const app=(await buildTrackedApps(30)).apps.find(x=>x.id===appId);
    if(!app||app.source!=='App Store')throw Object.assign(new Error('仅支持 App Store 已收录应用'),{status:400});
    if(!Array.isArray(feed?.feed?.entry))return {imported:0,reason:'Apple RSS 暂无公开评论',details:await list(appId)};
    const existing=await readRows(`SELECT source_url FROM opportunity_evidence WHERE app_id=${sqlQuote(appId)};`);
    const known=new Set(existing.map(x=>x.source_url)),seen=new Set();
    const appStoreId=appId.slice('App Store-'.length);
    const sourceBase='https://itunes.apple.com/us/rss/customerreviews/id='+appStoreId+'/sortby=mostrecent/json';
    const rows=[];
    for(const entry of feed.feed.entry){
      const reviewId=clean(entry?.id?.label,40),quote=clean(entry?.content?.label,900);
      if(!/^\d+$/.test(reviewId)||quote.length<10)continue;
      const url=sourceBase+'#review-'+reviewId;
      if(known.has(url)||seen.has(url))continue;
      seen.add(url);
      const rating=clean(entry?.['im:rating']?.label,8),published=clean(entry?.updated?.label,40);
      const context='Apple App Store 用户公开评价；评分 '+(rating||'未知')+'/5；发布时间 '+(published||'未知')+'；尚未经人工逐字核验';
      rows.push({url,quote,context});
      if(rows.length>=10)break;
    }
    if(!rows.length)return {imported:0,reason:'无新增合规评论',details:await list(appId)};
    const inserts=rows.map(row=>`INSERT INTO opportunity_evidence(app_id,type,source_url,source_domain,quote,context,collector) VALUES(${sqlQuote(appId)},'user_review',${sqlQuote(row.url)},'itunes.apple.com',${sqlQuote(row.quote)},${sqlQuote(row.context)},'system:apple_rss');`).join('\n');
    await execute(inserts+`\nINSERT INTO opportunity_audit(actor,action,app_id,payload) VALUES(${sqlQuote(actor)},'apple_reviews_imported',${sqlQuote(appId)},${quoted({count:rows.length,source:sourceBase})});`);
    return {imported:rows.length,details:await list(appId)};
  }
  async function listCandidates(){
    const items=await readRows('SELECT app_id,status,assigned_to,note,updated_at FROM candidate_workflow ORDER BY updated_at DESC;');
    return {items};
  }
  async function setCandidate(actor,input){
    const appId=clean(input.appId,300),status=clean(input.status,20),assignedTo=clean(input.assignedTo,30),note=clean(input.note,700);
    if(!await knownApp(appId))throw Object.assign(new Error('未知应用'),{status:404});
    if(!['candidate','assigned','researching','observing','approved','rejected','archived'].includes(status))throw Object.assign(new Error('无效任务状态'),{status:400});
    if(assignedTo&&!['reviewer_a','reviewer_b'].includes(assignedTo))throw Object.assign(new Error('无效任务负责人'),{status:400});
    const assignee=assignedTo?sqlQuote(assignedTo):'NULL';
    await execute(`INSERT INTO candidate_workflow(app_id,status,assigned_to,note) VALUES(${sqlQuote(appId)},${sqlQuote(status)},${assignee},${sqlQuote(note)}) ON CONFLICT(app_id) DO UPDATE SET status=excluded.status,assigned_to=excluded.assigned_to,note=excluded.note,updated_at=CURRENT_TIMESTAMP;
INSERT INTO opportunity_audit(actor,action,app_id,payload) VALUES(${sqlQuote(actor)},'candidate_updated',${sqlQuote(appId)},${quoted({status,assignedTo,note})});`);
    return listCandidates();
  }
  return {trustedUser,list,addEvidence,verifyEvidence,review,importAppStoreReviews,listCandidates,setCandidate};
}
