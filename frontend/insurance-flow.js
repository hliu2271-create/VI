/* The guided application owns only draft/quote/submission UI. Business data stays in /api/state. */
(function(){
 'use strict';
 const fields=['fNode','fProd','fSum','fDays','fDed'];
 let busy=false,uploadBusy=false,maintenance=false,quoted=null,quotedInput=null,issued=false,pending=null,restored=false;
 const storage='aegis.application.v3';
 const read=()=>({nodeId:$('fNode').value,product:$('fProd').value,sumInsured:+$('fSum').value,days:+$('fDays').value,deductible:+$('fDed').value});
 const signature=input=>JSON.stringify(input);
 function save(){try{sessionStorage.setItem(storage,JSON.stringify({input:read(),pending}));}catch{}}
 function status(message,error=false){$('flowStatus').textContent=message;$('flowStatus').classList.toggle('error',error);}
 function step(n){document.querySelectorAll('[data-step]').forEach(el=>{const i=+el.dataset.step;el.classList.toggle('current',i===n);el.classList.toggle('complete',i<n);if(i===n)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});}
 function controls(){
  const locked=!restored||busy||!!pending||demoRunning||maintenance;
  fields.forEach(id=>$(id).disabled=locked);
  $('quoteBtn').disabled=locked;
  // WebKit cancels a pending click if a blur/change handler replaces its text node.
  const quoteLabel=busy&&!pending?'正在核保…':'获取报价';
  if($('quoteBtn').textContent!==quoteLabel)$('quoteBtn').textContent=quoteLabel;
  $('issueBtn').disabled=busy||demoRunning||maintenance||issued||(!pending&&(!quoted||quoted.decision==='DECLINE'||signature(read())!==quotedInput));
  $('issueBtn').textContent=busy&&pending?'正在出单…':pending?'重试并核对出单结果':issued?'保单已生效':'确认条款并出单';
  $('newApplication').disabled=locked;
  $('applicationCard').setAttribute('aria-busy',String(busy));
 }
 function invalid(input){
  if(!input.nodeId)return '节点尚未加载，请稍后再试。';
  if(!$('fSum').value||!Number.isFinite(input.sumInsured)||input.sumInsured<=0)return '请填写大于 0 的保额。';
  if(!Number.isInteger(input.days)||input.days<1||input.days>3650)return '期间须为 1–3650 天的整数。';
  if(!$('fDed').value||!Number.isFinite(input.deductible)||input.deductible<0||input.deductible>=input.sumInsured)return '免赔额须大于等于 0 且小于保额。';
  return '';
 }
 function invalidate(){
  if(busy||pending)return;
  quoted=null;quotedInput=null;lastQuote=null;issued=false;$('quote').classList.remove('show');$('quoteEmpty').hidden=false;
  $('policyReceipt').hidden=true;step(1);status('信息已更新，请重新获取报价。');controls();save();
 }
 function showQuote(q,input){
  quoted=q;lastQuote=q;quotedInput=signature(input);$('quote').classList.add('show');$('quoteEmpty').hidden=true;
  $('qDec').textContent=q.decision==='DECLINE'?'暂不可承保':q.decision==='ACCEPT_WITH_LOADING'?'加费承保 · 本次保费':'标准承保 · 本次保费';
  $('qPrem').textContent=q.decision==='DECLINE'?'—':fmt(q.premium)+' BOT';
  $('qDetail').textContent=(q.reasons||[]).map(r=>r.s+'：'+r.d).join('\n\n');
  $('quoteTerms').innerHTML=`<div><span>节点 / 险种</span><b>${esc(input.nodeId)} · ${esc(S?.products?.[input.product]?.name||input.product)}</b></div><div><span>保障额度</span><b>${fmt(q.sumInsured)} BOT</b></div><div><span>保障期间</span><b>${q.days} 天</b></div><div><span>核定免赔额</span><b>${fmt(q.deductible)} BOT</b></div>`;
  step(q.decision==='DECLINE'?1:2);
 }
 async function quote(fromDemo=false){
  if(busy||pending||maintenance||(demoRunning&&!fromDemo))return;
  const input=read(),error=invalid(input);if(error){status(error,true);return;}
  busy=true;issued=false;quoted=null;quotedInput=null;lastQuote=null;$('policyReceipt').hidden=true;controls();status('正在核保，请稍候…');
  try{const q=await post('/api/quote',input);showQuote(q,input);status(q.decision==='DECLINE'?'本次报价未通过，请查看核保依据并调整信息。':'请核对保费、期间与核定免赔额，再确认出单。',q.decision==='DECLINE');return q;}
  catch(e){$('quote').classList.remove('show');$('quoteEmpty').hidden=false;status(e.status?e.message:'报价未完成，信息已保留，请重试。',true);}
  finally{busy=false;controls();save();}
 }
 function policyDetails(p){
  const product=S?.products?.[p.product]?.name||p.product;
  const time=Number.isFinite(Date.parse(p.inception))?new Date(p.inception).toLocaleString('zh-CN',{hour12:false}):p.inception||'—';
  return `<div class="policy-facts"><div><span>保单号</span><b>${esc(p.no)}</b></div><div><span>被保节点</span><b>${esc(p.nodeId)}</b></div><div><span>险种</span><b>${esc(product)}</b></div><div><span>保额</span><b>${fmt(p.sumInsured)} BOT</b></div><div><span>保费</span><b>${fmt(p.premium)} BOT</b></div><div><span>免赔额</span><b>${fmt(p.deductible)} BOT</b></div><div><span>保障期间</span><b>${p.days} 天</b></div><div><span>生效时间</span><b>${esc(time)}</b></div></div><p class="policy-conditions">${esc(p.conditions||'以核定条款为准')}</p>`;
 }
 function changed(){if(parent!==window)parent.postMessage({channel:'aegis-workbench',type:'data-updated'},location.origin);}
 async function issue(fromDemo=false){
  if(busy||issued||maintenance||(demoRunning&&!fromDemo))return;
  if(!pending){
   if(!quoted||quoted.decision==='DECLINE'||quotedInput!==signature(read())){status('请先获取与当前信息一致的报价。',true);return;}
   pending={...read(),sessionId:S?.summary?.sessionId,requestId:crypto.randomUUID(),expectedPremium:quoted.premium,expectedDeductible:quoted.deductible};save();
  }
  busy=true;controls();status('正在确认出单结果，请稍候…');
  try{
   const r=await post('/api/issue',pending);
   if(!r.ok){pending=null;quoted=null;status(r.reason||'未能出单，请重新报价。',true);return;}
   const policy=r.policy;pending=null;issued=true;step(3);status('出单完成，可查看下方保单与节点监控。');
   $('receiptDetails').innerHTML=policyDetails(policy);$('policyReceipt').hidden=false;
   $('policyReceipt').focus({preventScroll:true});$('policyReceipt').scrollIntoView({block:'nearest',behavior:'smooth'});
   changed();await pull();return policy;
  }catch(e){
   if(e.status&&e.status<500){pending=null;quoted=null;step(1);status(e.message+'。请重新获取报价。',true);}
   else status('尚未收到出单结果，信息已保留。请重试核对，同一笔申请不会重复出单。',true);
  }finally{busy=false;controls();save();}
 }
 async function uploadEvidence(){
  if(uploadBusy)return;
  if(!evFileRef)return toast('请先选择证据文件','err');
  if(!$('evClaim').value)return toast('请先选择关联赔案','err');
  if(evFileRef.size>4*1024*1024)return toast('单份证据上限 4MB，请选择较小的文件','err');
  const file=evFileRef,body={claimNo:$('evClaim').value,kind:$('evKind').value,name:file.name,submitter:$('evBy').value||'投保人'};
  uploadBusy=true;$('uploadBtn').disabled=true;$('uploadBtn').textContent='正在提交与核验…';
  try{
   const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('文件读取失败'));reader.onabort=()=>reject(Error('文件读取中断'));reader.readAsDataURL(file);});
   const r=await post('/api/evidence/upload',{...body,dataBase64:data});if(!r.ok)throw Error(r.error||'上传失败');
   toast(`证据 ${r.evidence.id}：${verdictTxt(r.evidence.verdict)}（${r.evidence.score} 分）`);
   if(r.missing?.length)toast('仍缺单证：'+r.missing.join('、'),'err');
   if(evFileRef===file){evFileRef=null;$('evName').textContent='选择或拖拽文件（≤ 4MB）';$('evFile').value='';}
   changed();await pull();
  }catch(e){toast((e.status?e.message:'提交未完成')+'，文件已保留，可重试。','err');}
  finally{uploadBusy=false;$('uploadBtn').disabled=false;$('uploadBtn').textContent='提交并核验';}
 }
 fields.forEach(id=>{const el=$(id);el.addEventListener('input',invalidate);el.addEventListener('change',invalidate);const label=el.closest('.f')?.querySelector('label');if(label)label.htmlFor=id;});
 $('newApplication').addEventListener('click',()=>{invalidate();$('fNode').focus();scrollTo({top:0,behavior:'smooth'});});
 $('pols').addEventListener('click',event=>{const button=event.target.closest('[data-policy]');if(!button)return;const p=S?.policies.find(p=>p.no===button.dataset.policy);if(!p)return;$('policyDialogBody').innerHTML=policyDetails(p);$('policyDialog').showModal();$('policyDialogClose').focus();});
 $('policyDialogClose').addEventListener('click',()=>$('policyDialog').close());
 $('policyDialog').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();$('policyDialog').close();}});
 document.querySelectorAll('.nv a[data-view]').forEach(el=>{el.setAttribute('role','button');el.tabIndex=0;el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click();}});});
 function restore(){
  if(restored||!S?.nodes?.length)return;restored=true;
  try{
   const draft=JSON.parse(sessionStorage.getItem(storage)||'null');if(!draft?.input)return;
   const d=draft.input;if(S.nodes.some(n=>n.id===d.nodeId))$('fNode').value=d.nodeId;
   for(const [id,key] of [['fProd','product'],['fSum','sumInsured'],['fDays','days'],['fDed','deductible']])if(d[key]!=null)$(id).value=d[key];
   if(draft.pending?.requestId&&draft.pending.sessionId!==S.summary?.sessionId){pending=null;status('服务会话已变化，旧出单结果无法核对。请重新报价。',true);save();}
   else if(draft.pending?.requestId){pending=draft.pending;status('上次出单结果尚未确认。请重试核对，同一申请不会重复出单。',true);}
   else status('已恢复本页投保草稿，请获取最新报价。');controls();
  }catch{}finally{controls();}
 }
 addEventListener('insurance-state',restore);restore();
 addEventListener('message',event=>{
  if(event.source!==parent||event.origin!==location.origin||event.data?.channel!=='aegis-workbench'||event.data.type!=='intent')return;
  if(event.data.intent==='apply'){goView('apply');requestAnimationFrame(()=>requestAnimationFrame(()=>{scrollTo({top:0,behavior:'instant'});$('fNode').focus({preventScroll:true});}));parent.postMessage({channel:'aegis-workbench',type:'intent-handled'},location.origin);}
 });
 window.InsuranceFlow={quote,issue,uploadEvidence,refreshControls:controls,
  canReset:()=>!busy&&!pending&&!uploadBusy&&!maintenance,
  maintenance:active=>{maintenance=active;controls();},
  clearDraft:()=>{invalidate();changed();}};controls();
})();
