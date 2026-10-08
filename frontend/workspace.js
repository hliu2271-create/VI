(function(){
 'use strict';
 const workbench=document.getElementById('workbench');if(!workbench)return;
 const section=workbench.closest('section'),tabs=[...workbench.querySelectorAll('[role=tab]')];
 const frames=new Map([...workbench.querySelectorAll('iframe[data-workspace-frame]')].map(f=>[f.dataset.workspaceFrame,f]));
 const description=document.getElementById('wbDescription'),expand=document.getElementById('wbExpand');
 const descriptions={insurance:'承保、核保、赔案与证据，在同一处处理。',lab:'选择场景和证据，查看完整理赔过程。',market:'查看节点信用、保单行情与风险指标。',protocol:'配置合约，管理节点与协议演示。',plan:'了解项目机制、实施路径与验证依据。',evidence:'核查本地验证结果、模型研判与适用边界。'};
 const routes={'insurer.html':'insurance','lab.html':'lab','market.html':'market','protocol.html':'protocol','plan.html':'plan','evidence.html':'evidence'};
 const origin=location.origin,postOrigin=origin==='null'?'*':origin;
 const drawer=document.getElementById('workspaceDrawer'),drawerFrames=new Map();
 let active='insurance',expanded=false,previousScroll=0,drawerTrigger=null;
 const intents=new Map();
 function sendIntent(key){const intent=intents.get(key),frame=frames.get(key);if(intent&&frame){send(frame,{type:'intent',intent});}}
 const inertChanges=[];
 function send(frame,data){if(frame.contentWindow)frame.contentWindow.postMessage({channel:'aegis-workbench',...data},postOrigin);}
 function mount(key){const frame=frames.get(key);if(!frame||frame.hasAttribute('src'))return;frame.src=frame.dataset.src;}
 function revealActiveTab(){const tab=tabs.find(t=>t.dataset.workspace===active);if(!tab)return;const strip=tab.parentElement,a=tab.getBoundingClientRect(),b=strip.getBoundingClientRect();if(a.left<b.left)strip.scrollLeft+=a.left-b.left;else if(a.right>b.right)strip.scrollLeft+=a.right-b.right;}
 window.addEventListener('resize',revealActiveTab,{passive:true});
 frames.forEach((frame,key)=>{
  frame.addEventListener('load',()=>{const loading=workbench.querySelector(`[data-loading="${key}"]`);if(loading)loading.hidden=true;send(frame,{type:'activate',active:active===key});sendIntent(key);});
 });
 function select(key,{scroll=false,nativeTab,intent}={}){
  if(!descriptions[key])return;
  frames.forEach(frame=>{if(!frame.closest('.wb-panel').hidden&&frame.hasAttribute('src')){try{frame.dataset.savedScroll=String(frame.contentWindow.scrollY);}catch{}}});
  active=key;
  if(intent)intents.set(key,intent);
  tabs.forEach(tab=>{const selected=tab.dataset.workspace===key;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;document.getElementById(tab.getAttribute('aria-controls')).hidden=!selected;});
  description.textContent=descriptions[key];mount(key);revealActiveTab();
  frames.forEach((frame,k)=>send(frame,{type:'activate',active:k===key,scrollY:Number(frame.dataset.savedScroll||0)}));
  sendIntent(key);
  if(key==='protocol'){
   if(nativeTab!=null)workbench.querySelector(`.side-item[data-tab="${nativeTab}"]`)?.click();
   window.dispatchEvent(new Event('resize'));
  }
  if(scroll&&!expanded)section.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'});
  // A tab switch is an in-page action and must not create a new document/history entry.
 }
 function setInert(el){if(!el)return;inertChanges.push([el,el.inert]);el.inert=true;}
 function toggleExpanded(next){
  if(next===expanded)return;
  expanded=next;
  if(next){
   previousScroll=scrollY;section.style.minHeight=section.getBoundingClientRect().height+'px';
   [...document.body.children].forEach(el=>{if(el!==section&&el!==drawer&&!el.matches('.hero,#flash,#deck,#toast,script,style'))setInert(el);});
   [...section.children].forEach(el=>{if(el!==workbench)setInert(el);});
   document.querySelectorAll('.hero-in > :not(.hero-film-slot)').forEach(setInert);
  }else{
   inertChanges.splice(0).forEach(([el,value])=>{el.inert=value;});section.style.minHeight='';
  }
  workbench.classList.toggle('is-expanded',next);document.body.classList.toggle('workbench-expanded',next);
  expand.setAttribute('aria-expanded',String(next));expand.querySelector('span').textContent=next?'收起工作台':'展开工作台';
  if(!next)scrollTo({top:previousScroll,behavior:'instant'});
  expand.focus({preventScroll:true});window.dispatchEvent(new Event('resize'));
 }
 expand.addEventListener('click',()=>toggleExpanded(!expanded));
 document.addEventListener('click',event=>{
  const entry=event.target.closest('[data-workspace]');if(!entry)return;
  if(!descriptions[entry.dataset.workspace])return;
  event.preventDefault();select(entry.dataset.workspace,{scroll:!entry.closest('.wb-tabs'),nativeTab:entry.dataset.nativeTab,intent:entry.dataset.intent});
 });
 document.addEventListener('click',event=>{if(expanded&&event.target.closest('[data-film-return]'))toggleExpanded(false);},true);
 workbench.querySelector('.wb-tabs').addEventListener('keydown',event=>{
  const current=tabs.indexOf(event.target);if(current<0)return;
  let index;if(event.key==='ArrowRight')index=(current+1)%tabs.length;else if(event.key==='ArrowLeft')index=(current+tabs.length-1)%tabs.length;else if(event.key==='Home')index=0;else if(event.key==='End')index=tabs.length-1;else return;
  event.preventDefault();tabs[index].focus();select(tabs[index].dataset.workspace);tabs[index].scrollIntoView({block:'nearest',inline:'nearest'});
 });
 function showDrawer(url,title){
  const normalized=new URL(url,location.href);if(normalized.origin!==origin)return;
  if(!/\/lab\/(cyber-claims-demo|midflow-A-orchestration|midflow-B-decision-engine)\.html$/.test(normalized.pathname))return;
  const key=normalized.pathname;let frame=drawerFrames.get(key);
  if(!frame){frame=document.createElement('iframe');normalized.searchParams.set('embed','1');frame.src=normalized.href;frame.title=title||'流程演练详情';drawerFrames.set(key,frame);document.getElementById('drawerContent').append(frame);}
  drawerFrames.forEach((f,k)=>{f.hidden=k!==key;});document.getElementById('drawerTitle').textContent=title||'流程演练';
  if(!drawer.open){drawerTrigger=document.activeElement;drawer.showModal();}document.getElementById('drawerClose').focus();
 }
 function closeDrawer(){if(drawer.open)drawer.close();}
 function closeBusinessOverlay(){
  const flash=document.getElementById('flash');
  if(flash?.classList.contains('on')){window.hideFlash();return true;}
  const deck=document.getElementById('deck');
  if(deck?.getAttribute('aria-hidden')==='false'){document.getElementById('deckClose')?.click();return true;}
  return false;
 }
 const flash=document.getElementById('flash');let flashFocus=null;
 if(flash){
  let flashOpen=flash.classList.contains('on');
  new MutationObserver(()=>{
   const next=flash.classList.contains('on');if(next===flashOpen)return;flashOpen=next;
   if(next){flashFocus=document.activeElement;flash.querySelector('.flash-close')?.focus({preventScroll:true});}
   else if(flashFocus?.isConnected){flashFocus.focus({preventScroll:true});flashFocus=null;}
  }).observe(flash,{attributes:true,attributeFilter:['class']});
 }
 document.getElementById('drawerClose').addEventListener('click',closeDrawer);
 drawer.addEventListener('click',event=>{if(event.target===drawer){const rect=drawer.getBoundingClientRect();if(event.clientX<rect.left)closeDrawer();}});
 drawer.addEventListener('close',()=>{if(drawerTrigger?.isConnected)drawerTrigger.focus({preventScroll:true});});
 window.addEventListener('message',event=>{
  if(event.origin!==origin||event.data?.channel!=='aegis-workbench')return;
  const known=[...frames.values(),...drawerFrames.values()].some(f=>f.contentWindow===event.source);if(!known)return;
  const data=event.data;
  if(data.type==='intent-handled'){intents.delete('insurance');
  }else if(data.type==='data-updated'){window.dispatchEvent(new Event('aegis-data-updated'));
  }else if(data.type==='navigate'){
   let url;try{url=new URL(data.url,location.href);}catch{return;}if(url.origin!==origin)return;
   const file=url.pathname.split('/').pop();
   if(url.pathname.includes('/lab/')){showDrawer(url.href,data.title);return;}
   if(routes[file]){closeDrawer();select(routes[file]);}
  }else if(data.type==='escape'){
   if(drawer.open)closeDrawer();else if(!closeBusinessOverlay()&&expanded)toggleExpanded(false);
  }else if(data.type==='ready'){
   frames.forEach((frame,key)=>{if(frame.contentWindow===event.source){send(frame,{type:'activate',active:key===active});sendIntent(key);}});
  }
 });
 document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||drawer.open)return;
  if(closeBusinessOverlay()){event.preventDefault();event.stopImmediatePropagation();return;}
  if(expanded){event.preventDefault();toggleExpanded(false);}
 },true);
 const near=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){mount(active);near.disconnect();}},{rootMargin:'350px'});near.observe(workbench);
 window.AegisWorkspace={select:key=>select(key,{scroll:true})};
})();
