(function(){
 'use strict';
 const $=id=>document.getElementById(id),labels={passed:'验证通过',failed:'存在失败',partial:'部分完成',unverified:'尚未验证','not-deployed':'尚未部署',deployed:'已有部署记录',historical:'历史记录',invalid:'报告格式无效'};
 const recommendationLabels={REVIEW:'建议人工复核',REQUEST_EVIDENCE:'建议补充证据',NO_INCIDENT:'未识别明确事故'};
 let busy=false;
 function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node;}
 function status(id,text,type){$(id).textContent=text;$(id).className='status'+(type?' is-'+type:'');}
 async function getJSON(url,options={},timeout=12000){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);try{const response=await fetch(url,{...options,signal:controller.signal});const body=await response.json();if(!response.ok||body.ok===false)throw new Error(body.error?.message||'请求未完成（HTTP '+response.status+'），请稍后重试。');return body;}finally{clearTimeout(timer);}}
 function formatDate(value){const date=new Date(value);return value&&!Number.isNaN(date.valueOf())?date.toLocaleString('zh-CN',{hour12:false}):'时间未记录';}
 async function loadVerification(){
  $('refreshVerification').disabled=true;status('verificationStatus','正在读取随版本交付的验证记录…');
  try{const data=await getJSON('/api/verification');if(!Array.isArray(data.reports))throw new Error('验证接口未返回有效报告列表。');$('verificationReports').replaceChildren();
   for(const report of data.reports){const card=el('article',undefined,'report-card');card.dataset.report=report.id;const state=report.id==='model'&&report.status==='passed'?'结构与引用检查通过':labels[report.status]||'尚未验证';card.append(el('h3',report.title||report.id),el('span',state,'report-state'),el('p',report.history?'历史参考 · 不作为 IV 的执行证明':'IV 当前记录 · '+formatDate(report.createdAt)));
    if(report.summary&&Number.isFinite(report.summary.total)&&Number.isFinite(report.summary.passed)){card.append(el('p',report.summary.passed+' / '+report.summary.total+' 项记录通过'+(report.id==='model'?' · 合成样例结构检查':' · 本地指定用例')));}
    if(report.id==='model'&&report.available){card.append(el('p','存在解释偏差，注入文本仍会牵引缺失项；通过项不代表准确率或完全抗注入。','report-limitation'));}
    if(report.summary){const details=el('details'),summary=el('summary','查看记录摘要');details.append(summary,el('pre',JSON.stringify(report.summary,null,2)));card.append(details);}
    if(report.available&&typeof report.url==='string'&&/^(?:\/api\/reports\/[a-z0-9-]+|\/reports\/[a-zA-Z0-9-]+\.json)$/.test(report.url)){const link=el('a','打开原始 JSON 报告 ↗');link.href=report.url;link.target='_blank';link.rel='noopener';card.append(link);if(report.sha256)card.append(el('p','SHA-256 · '+report.sha256));}
    else card.append(el('p','报告尚不可用，不能据此判定通过。'));
    $('verificationReports').append(card);
   }
   status('verificationStatus','记录读取时间：'+formatDate(data.generatedAt)+' · '+(data.targetChainDeployed?'检测到目标链部署报告，请核对网络及地址。':'目标链部署：尚未完成。'),'ok');
  }catch(error){status('verificationStatus','验证记录读取失败。'+(error.name==='AbortError'?'请求超时，请重试。':error.message),'error');}
  finally{$('refreshVerification').disabled=false;}
 }
 async function modelStatus(){try{const data=await getJSON('/api/model/status');status('modelAvailability',(data.available?'本机模型可用':'本机模型不可用')+' · '+(data.model||'模型未配置')+(data.busy?' · 正在处理其他请求':'')+(data.reason?' · '+data.reason:''),data.available?'ok':'error');}catch(error){status('modelAvailability','无法检查本机模型。保留原文后可重新尝试。','error');}}
 function renderResult(data){const r=data.result;if(!r||!Array.isArray(r.observations)||!Array.isArray(r.missing)||!recommendationLabels[r.recommendation])throw new Error('模型返回结构不完整，请重试。');
  $('recommendation').textContent=recommendationLabels[r.recommendation];$('analysisMeta').textContent='调用模型：'+data.model+' · '+formatDate(data.createdAt)+' · 耗时 '+(Number(data.elapsedMs)/1000).toFixed(1)+' 秒';$('analysisSummary').textContent=r.summary;$('analysisRationale').textContent=r.rationale;
  $('observations').replaceChildren();for(const observation of r.observations){const item=el('div',undefined,'observation');item.append(el('blockquote',observation.quote),el('p',observation.finding));$('observations').append(item);}if(!r.observations.length)$('observations').append(el('p','没有提取到可引用的相关观测。'));
  $('missingEvidence').replaceChildren();for(const missing of r.missing)$('missingEvidence').append(el('li',missing));if(!r.missing.length)$('missingEvidence').append(el('li','模型未列出缺失项；仍需人工核对原始资料。'));
  $('analysisResult').hidden=false;
 }
 $('incidentText').addEventListener('input',()=>{$('inputCount').textContent=$('incidentText').value.length+' / 8000 字';});
 $('modelForm').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;const text=$('incidentText').value;if(!text.trim()){status('analysisStatus','请先填写事故资料。','error');return;}busy=true;$('analyzeButton').disabled=true;$('analyzeButton').textContent='模型研判中…';$('analysisResult').hidden=true;status('analysisStatus','正在调用本机模型。原文会保留，推理可能需要数分钟。');
  try{const data=await getJSON('/api/model/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})},200000);renderResult(data);status('analysisStatus','研判已完成，仅供复核参考。原文已保留。','ok');}
  catch(error){status('analysisStatus',(error.name==='AbortError'?'模型请求超时，请稍后重试。':error.message)+' 原文已保留。','error');}
  finally{busy=false;$('analyzeButton').disabled=false;$('analyzeButton').textContent='重新研判 ↗';modelStatus();}
 });
 $('refreshVerification').addEventListener('click',()=>{loadVerification();modelStatus();});loadVerification();modelStatus();
})();
