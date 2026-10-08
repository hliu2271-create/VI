/* Mobile browser input, keyboard and wallet guidance. */
(()=>{
 function init(){
  const coarse=matchMedia('(pointer:coarse)');
  let guide;
  function showGuide(){if(!guide){guide=document.createElement('dialog');guide.id='mobileWalletGuide';const heading=document.createElement('h2');heading.textContent='在钱包浏览器中连接';const text=document.createElement('p');text.textContent='普通手机浏览器通常没有钱包接口。请在你使用的钱包 App 内置浏览器中打开此网页，再点击连接钱包。演示流程可直接体验，无需连接。';const actions=document.createElement('div');actions.className='wallet-guide-actions';const copy=document.createElement('button');copy.type='button';copy.textContent='复制网页地址';const close=document.createElement('button');close.type='button';close.textContent='返回演示';close.dataset.walletClose='';const feedback=document.createElement('p');feedback.setAttribute('role','status');copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(parent!==window?parent.location.href:location.href);feedback.textContent='地址已复制，请在钱包 App 中打开。';}catch{feedback.textContent='请通过浏览器分享菜单复制本页地址。';}});close.addEventListener('click',()=>guide.close());actions.append(copy,close);guide.append(heading,text,actions,feedback);document.body.append(guide);}guide.showModal();}
  document.addEventListener('click',event=>{const target=event.target.closest('[onclick*="connectWallet"]');if(!target||window.ethereum||(!coarse.matches&&innerWidth>860))return;event.preventDefault();event.stopImmediatePropagation();showGuide();},true);
  let focus=false,normalHeight=visualViewport?.height||innerHeight;
  function keyboard(){const v=visualViewport,height=v?.height||innerHeight;normalHeight=Math.max(normalHeight,height);const editing=focus&&(document.activeElement?.matches('input,textarea,select')||document.activeElement?.tagName==='IFRAME');const open=editing&&(!v||normalHeight-height>120);document.documentElement.classList.toggle('mobile-keyboard-open',!!open);if(parent!==window)parent.postMessage({type:'aegis-mobile-keyboard',open:!!open},location.origin);}
  document.addEventListener('focusin',()=>{focus=true;keyboard();});document.addEventListener('focusout',()=>queueMicrotask(()=>{focus=!!document.activeElement?.matches('input,textarea,select,iframe');keyboard();}));visualViewport?.addEventListener('resize',keyboard);addEventListener('orientationchange',()=>{normalHeight=visualViewport?.height||innerHeight;keyboard();});
  addEventListener('message',event=>{if(event.origin!==location.origin||event.data?.type!=='aegis-mobile-keyboard')return;const frame=[...document.querySelectorAll('iframe')].find(f=>f.contentWindow===event.source);if(frame)document.documentElement.classList.toggle('mobile-keyboard-open',!!event.data.open);});
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
