/* A local active-tab indicator. Existing navigation owns state and focus. */
(()=>{
 const tabs=document.querySelector('#workbench .wb-tabs');if(!tabs)return;
 const line=document.createElement('span');line.className='wb-active-line';line.setAttribute('aria-hidden','true');tabs.append(line);let frame;
 function render(){cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const selected=tabs.querySelector('[role="tab"][aria-selected="true"]');if(!selected)return;const tabRect=selected.getBoundingClientRect(),strip=tabs.getBoundingClientRect();line.style.width=Math.max(0,tabRect.width-28)+'px';line.style.transform='translateX('+(tabRect.left-strip.left+tabs.scrollLeft+14)+'px)';});}
 const observer=new MutationObserver(render);observer.observe(tabs,{subtree:true,attributes:true,attributeFilter:['aria-selected']});const resize=new ResizeObserver(render);resize.observe(tabs);tabs.addEventListener('scroll',render,{passive:true});document.fonts.ready.then(render);render();
})();
