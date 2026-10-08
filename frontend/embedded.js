(function(){
 'use strict';
 if(!document.documentElement.classList.contains('workbench-embedded'))return;
 const targetOrigin=location.origin==='null'?'*':location.origin;
 function post(data){parent.postMessage({channel:'aegis-workbench',...data},targetOrigin);}
 let savedScroll=0,active=true;
 const status=document.querySelector('#demoBar');if(status){status.classList.add('folded');const toggle=document.querySelector('#nowFold');if(toggle)toggle.textContent='+';}
 document.addEventListener('click',event=>{
  const anchor=event.target.closest('a[href]');if(!anchor)return;
  if(anchor.getAttribute('href').startsWith('#'))return;
  let url;try{url=new URL(anchor.href,location.href)}catch{return}
  if(url.origin!==location.origin)return;
  if(!/\/(insurer|protocol|lab|market|plan|evidence)\.html$/.test(url.pathname)&&!url.pathname.includes('/lab/'))return;
  event.preventDefault();post({type:'navigate',url:url.href,title:anchor.textContent.trim()});
 },true);
 addEventListener('scroll',()=>{if(active)savedScroll=scrollY;},{passive:true});
 addEventListener('message',event=>{
  if(event.source!==parent||event.origin!==location.origin||event.data?.channel!=='aegis-workbench')return;
  if(event.data.type==='activate'){
   if(Number.isFinite(event.data.scrollY))savedScroll=event.data.scrollY;
   else if(!event.data.active&&active)savedScroll=scrollY;
   active=!!event.data.active;
   if(active){requestAnimationFrame(()=>{dispatchEvent(new Event('resize'));scrollTo({top:savedScroll,behavior:'instant'});});}
  }
 });
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented)post({type:'escape'});});
 post({type:'ready'});
})();
