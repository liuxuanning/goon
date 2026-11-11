// Optional workflow UI; API responses are displayed as text, never as untrusted HTML.
const el=(tag,attrs={},txt='')=>{
  const n=document.createElement(tag);for(const [k,v] of Object.entries(attrs)){if(k==='className')n.className=v;else n.setAttribute(k,v);}
  if(txt)n.textContent=txt;return n;
};
const field=(parent,title,node)=>{const label=el('label');label.append(el('span',{},title),node);parent.append(label);return node;};
const select=(values)=>{const s=el('select');for(const [value,title] of values)s.append(el('option',{value},title));return s;};
let generation=0;
export function showOpportunityWorkflow(app){
 const parent=document.querySelector('#inspector');if(!parent||!app)return;
 if(location.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(location.hostname)){
   const warning=el('section',{className:'inspect-card'},'当前站点使用明文 HTTP。为避免审核员令牌泄露，请先启用 HTTPS，再使用证据协作功能。');parent.append(warning);return;
 }
 const serial=++generation;
 const panel=el('section',{className:'inspect-card'});
 panel.append(el('div',{className:'inspect-title'},'机会证据与双人复核（独立审计）'));
 const intro=el('p',{className:'sub'},'仅经另一位审核员核实的原始来源才计入证据。产品介绍、模型推断不等于真实用户反馈。');
 panel.append(intro);
 const tokenInput=el('input',{type:'password',autocomplete:'off',placeholder:'输入审核员令牌（仅当前会话）'});
 tokenInput.value=sessionStorage.getItem('goonReviewerToken')||'';
 const tokenLine=el('div',{className:'inspect-actions'});
 const login=el('button',{className:'secondary',type:'button'},'读取证据');
 tokenLine.append(tokenInput,login);panel.append(tokenLine);
 const content=el('div');panel.append(content);parent.append(panel);
 const api=()=>'/api/opportunities/'+encodeURIComponent(app.id);
 const token=()=>tokenInput.value.trim();
 const note=message=>{content.replaceChildren(el('p',{className:'sub'},message));};
 const request=async(body)=>{
  const headers={'Authorization':'Bearer '+token()};
  if(body)headers['Content-Type']='application/json';
  const r=await fetch(api(),{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>({error:'服务端返回无效数据'}));
  if(!r.ok)throw new Error(d.error||'请求失败');
  return d;
 };
 const submit=async(action,button)=>{
  button.disabled=true;
  try{await request(action);await refresh();}catch(error){note(error.message);}finally{button.disabled=false;}
 };
 const textRow=(area,label,value)=>{
  const p=el('p',{className:'sub'});p.append(el('strong',{},label+': '),document.createTextNode(String(value??'—')));area.append(p);
 };
 async function refresh(){
  if(serial!==generation||!parent.contains(panel))return;
  if(!token()){note('输入审核员令牌才能读取或提交证据。');return;}
  sessionStorage.setItem('goonReviewerToken',token());
  try{
   const data=await request();if(serial!==generation||!parent.contains(panel))return;
   content.replaceChildren();
   const {opportunity,evidence,reviews,audit}=data;
   const cRes=await fetch('/api/candidates',{headers:{Authorization:'Bearer '+token()}});
   if(cRes.ok){
     const cData=await cRes.json();
     const current=cData.items.find(x=>x.app_id===app.id);
     content.append(el('div',{className:'inspect-title'},'两人共享候选任务'));
     const taskForm=el('form',{className:'goon-evidence-form'});
     const taskStatus=field(taskForm,'任务状态',select([['candidate','待评估'],['assigned','已指派'],['researching','研究中'],['observing','持续观察'],['approved','准备验证'],['rejected','已否决'],['archived','归档']]));
     taskStatus.value=current?.status||'candidate';
     const owner=field(taskForm,'负责人',select([['','未分配'],['reviewer_a','审核员A'],['reviewer_b','审核员B']]));
     owner.value=current?.assigned_to||'';
     const taskNote=field(taskForm,'协作备注',el('textarea',{rows:'2'}));
     taskNote.value=current?.note||'';
     const saveTask=el('button',{type:'submit',className:'secondary'},'保存共享任务');
     taskForm.append(saveTask);
     taskForm.onsubmit=async e=>{
       e.preventDefault();saveTask.disabled=true;
       try{
         const resp=await fetch('/api/candidates',{method:'POST',headers:{Authorization:'Bearer '+token(),'Content-Type':'application/json'},body:JSON.stringify({appId:app.id,status:taskStatus.value,assignedTo:owner.value,note:taskNote.value})});
         const result=await resp.json();
         if(!resp.ok)throw new Error(result.error||'保存失败');
         window.dispatchEvent(new Event('goonCandidatesUpdated'));
         await refresh();
       }catch(error){note(error.message);}finally{saveTask.disabled=false;}
     };
     content.append(taskForm);
   }
   textRow(content,'机会结论',opportunity.decision);
   textRow(content,'综合机会分',opportunity.score===null?'暂不评分（缺少完整可复核证据）':opportunity.score+' / 100（人工主观评分）');
   textRow(content,'评分尚缺条件',(opportunity.missingScoreConditions||[]).join('；')||'条件齐全');
   textRow(content,'已核验证据',opportunity.sourceCoverage.verifiedEvidence+' 条 / '+opportunity.sourceCoverage.independentDomains+' 个独立域名');
   for(const [key,title] of [['demand','需求强度'],['growth','增长'],['willingnessToPay','付费'],['competition','竞争'],['feasibility','实施可行性']])textRow(content,title,opportunity.dimensions[key]);
   if(app.source==='App Store'){
     const importButton=el('button',{type:'button',className:'secondary'},'从 Apple 官方 RSS 收集最多10条真实评论');
     importButton.onclick=()=>submit({action:'appleReviews'},importButton);
     content.append(importButton);
     content.append(el('p',{className:'sub'},'自动收集的评论仍为待核验状态，需审核员核实原文及来源；无评论则不会生成记录。'));
   }
   const head=el('div',{className:'inspect-title'},'提交公开证据');content.append(head);
   const form=el('form',{className:'goon-evidence-form'});
   const type=field(form,'证据类型',select([['user_review','真实评论'],['community','社区讨论'],['pricing','公开价格'],['competitor','竞品比较'],['search','搜索/趋势'],['other','其他']]));
   const url=field(form,'公开来源 URL',el('input',{type:'url',required:'',placeholder:'https://...'}));
   const quote=field(form,'原文片段（≥10字）',el('textarea',{required:'',rows:'2'}));
   const context=field(form,'采集背景（≥8字）',el('textarea',{required:'',rows:'2'}));
   const add=el('button',{type:'submit',className:'secondary'},'提交待核验证据');
   form.append(add);form.onsubmit=e=>{e.preventDefault();submit({action:'evidence',type:type.value,sourceUrl:url.value,quote:quote.value,context:context.value},add);};
   content.append(form);
   content.append(el('div',{className:'inspect-title'},'证据列表'));
   if(!evidence.length)content.append(el('p',{className:'sub'},'暂无外部证据。'));
   for(const item of evidence){
    const box=el('div',{className:'goon-evidence-entry'});
    textRow(box,'类型 / 状态',item.type+' / '+item.status);
    const link=el('a',{href:item.source_url,target:'_blank',rel:'noopener noreferrer'},item.source_domain);
    box.append(link);
    textRow(box,'引用原文',item.quote);
    textRow(box,'上下文',item.context);
    textRow(box,'采集者',item.collector);
    if(item.status==='pending'){
      const actions=el('div',{className:'inspect-actions'});
      for(const [status,title] of [['verified','交叉核验通过'],['rejected','证据不成立']]){
       const b=el('button',{className:'secondary',type:'button'},title);
       b.onclick=()=>submit({action:'verify',evidenceId:item.id,status},b);actions.append(b);
      }box.append(actions);
    }content.append(box);
   }
   content.append(el('div',{className:'inspect-title'},'独立复核'));
   const reviewers=el('p',{className:'sub'},reviews.map(r=>r.reviewer+': '+r.verdict+' ('+r.note+')').join('；')||'尚无正式结论');
   content.append(reviewers);
   const reviewForm=el('form',{className:'goon-evidence-form'});
   const verdict=field(reviewForm,'结论',select([['observe','继续观察'],['approve','支持进入机会验证'],['reject','否决']]));
   const reason=field(reviewForm,'理由（≥8字）',el('textarea',{required:'',rows:'2'}));
   const ratingInputs={};
   for(const [key,title] of [['demand','需求强度 30%'],['growth','增长证据 25%'],['payment','付费可能性 20%'],['competition','竞争可切入性 15%'],['feasibility','OPC 实施可行性 10%']]){
     ratingInputs[key]=field(reviewForm,title+' · 0–5分（主观评估）',select(Array.from({length:6},(_,i)=>[String(i),String(i)])));
   }
   const btn=el('button',{type:'submit',className:'primary'},'提交一次独立复核');
   reviewForm.append(btn);reviewForm.onsubmit=e=>{e.preventDefault();submit({action:'review',verdict:verdict.value,note:reason.value,ratings:Object.fromEntries(Object.entries(ratingInputs).map(([k,v])=>[k,Number(v.value)]))},btn);};
   content.append(reviewForm);
   textRow(content,'审计日志',audit.length+' 条，保留操作人、时间及变更内容');
  }catch(error){note(error.message);}
 }
 login.onclick=()=>{refresh();window.dispatchEvent(new Event('goonCandidatesUpdated'));};
 if(token())refresh();else note('请先输入审核员令牌。两位审核员需要不同的令牌。');
}
