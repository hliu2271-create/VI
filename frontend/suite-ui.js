(function(){
 'use strict';
 const page=document.body.dataset.suite;
 if(page==='insurer' && matchMedia('(max-width:760px)').matches){
  const panel=document.querySelector('#demoBar');if(panel){panel.classList.add('folded');const button=document.querySelector('#nowFold');if(button)button.textContent='+';}
 }
 if(page!=='home' && !location.pathname.includes('/lab/')){
  const nav=document.createElement('nav');nav.className='suite-switch';nav.setAttribute('aria-label','业务工作区');
  const links=[['index.html','品牌首页','home'],['insurer.html','保险核心','insurer'],['protocol.html','协议工作台','protocol'],['lab.html','理赔实验室','lab'],['market.html','行情终端','market'],['plan.html','项目计划书','plan'],['evidence.html','项目验证','evidence']];
  for(const [url,label,key] of links){const a=document.createElement('a');a.href=url;a.textContent=label;if(page===key)a.setAttribute('aria-current','page');nav.append(a);}
  const header=document.querySelector('header');if(header)header.after(nav);else document.body.prepend(nav);
 }
 const query=matchMedia('(hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference)');
 const cards=document.querySelectorAll('.suite-card');
 const reset=()=>cards.forEach(c=>{c.style.transform='';});
 cards.forEach(card=>{
  card.addEventListener('pointermove',e=>{if(!query.matches)return;const b=card.getBoundingClientRect(),x=(e.clientX-b.left)/b.width-.5,y=(e.clientY-b.top)/b.height-.5;card.style.transform=`perspective(1000px) rotateX(${-y*5}deg) rotateY(${x*5}deg)`;});
  card.addEventListener('pointerleave',()=>{card.style.transform='';});
 });
 query.addEventListener('change',reset);addEventListener('scroll',reset,{passive:true});addEventListener('blur',reset);addEventListener('resize',reset);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});
})();
