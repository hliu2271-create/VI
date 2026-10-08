(function(){
 'use strict';
 let busy=false,last=null;
 const number=value=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2});
 async function refresh(){
  if(busy)return;busy=true;
  try{
   const response=await fetch('/api/summary',{cache:'no-store',signal:AbortSignal.timeout(8000)});
   if(!response.ok)throw Error('Unavailable');const s=await response.json();
   if(!Number.isFinite(s.activePolicies)||!Number.isFinite(s.capital))throw Error('Invalid summary');
   const fields={kPool:s.capital,kNodes:s.nodes,kPolicies:s.activePolicies,kPaid:s.grossPaid,kOpenClaims:s.openClaims};
   for(const [id,value] of Object.entries(fields)){const el=document.getElementById(id);if(el)el.textContent=number(value);}
   for(const [id,value] of Object.entries({hPool:s.capital,hPolicies:s.activePolicies,hPaid:s.grossPaid}))document.getElementById(id).textContent=number(value);
   last=new Date(s.asOf).toLocaleTimeString('zh-CN',{hour12:false});
   document.getElementById('dataFreshness').textContent='已同步 '+last;
   document.getElementById('dataFreshness').classList.remove('is-stale');
  }catch{
   const label=document.getElementById('dataFreshness');label.textContent=last?'连接中断 · 保留 '+last+' 的数据':'服务未连接 · 数据暂不可用';label.classList.add('is-stale');
  }finally{busy=false;}
 }
 refresh();setInterval(()=>{if(!document.hidden)refresh();},4000);
 addEventListener('aegis-data-updated',refresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
})();
