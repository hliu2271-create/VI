/* Public Demo adapter: same insurance rules, browser-owned memory, no host service. */
(()=>{
 const local=/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
 let inherited;try{inherited=parent!==window&&parent.AegisDemo;}catch{}
 if(local&&!new URLSearchParams(location.search).has('demo')&&!inherited)return;
 const nativeFetch=window.fetch.bind(window),nativeCrypto=window.crypto;
 const encoder=new TextEncoder(),decoder=new TextDecoder();
 class DemoBuffer extends Uint8Array {
  static from(value,encoding){if(value instanceof Uint8Array)return new DemoBuffer(value);if(encoding==='base64'){const raw=atob(String(value));return new DemoBuffer(Array.from(raw,c=>c.charCodeAt(0)));}return new DemoBuffer(encoder.encode(String(value)));}
  static byteLength(value){return encoder.encode(String(value)).length;}
  toString(encoding){if(encoding==='hex')return Array.from(this,x=>x.toString(16).padStart(2,'0')).join('');return decoder.decode(this);}
 }
 function createEngine(){
  const files=new Map([['demo-memory/../reports/severity-calibration.json',DemoBuffer.from(JSON.stringify(CALIBRATION))]]),directories=new Set(),cache={},started=Date.now();let handler,downUntil=0;
  const nodeHistory=[];
  function nodeResponse(input){
   const u=new URL(input,location.origin),now=Date.now();
   if(u.pathname==='/api/state')return {ok:true,simulation:true};
   if(u.pathname.endsWith('/info'))return {};
   if(u.pathname.endsWith('/history')){const from=Number(u.searchParams.get('from'))||0,samples=nodeHistory.filter(h=>h.ts>=from),down=samples.filter(h=>!h.ok).length;return {simulation:true,window:{from,to:now},samples:samples.slice(-40),downSamples:down,provenDownSeconds:samples.reduce((seconds,b,i)=>{const a=samples[i-1],delta=a?b.ts-a.ts:0;return seconds+(a&&!a.ok&&!b.ok&&delta>0&&delta<=3500?delta/1000:0);},0),hasData:samples.length>0};}
   if(u.pathname.endsWith('/admin/revive')){downUntil=0;return {ok:true,simulation:true};}
   if(u.pathname.endsWith('/admin/kill')){downUntil=Infinity;return {ok:true,simulation:true};}
   if(u.pathname.endsWith('/work')){downUntil=now+15000;return {ok:true,simulation:true};}
   const ok=now>=downUntil;nodeHistory.push({ts:now,ok,src:'browser-simulation'});if(nodeHistory.length>400)nodeHistory.shift();return {status:ok?'ok':'down',simulation:true,node:'aegis-demo-node',uptime:Math.floor((now-started)/1000),heartbeats:nodeHistory.length,avgLatency:ok?12:0,latency:ok?12:0,risk:ok?12:85,underAttack:!ok,reqs:nodeHistory.length,ts:now};
  }
  const fs={existsSync:p=>files.has(p)||directories.has(p),mkdirSync:p=>directories.add(p),writeFileSync:(p,v)=>files.set(p,DemoBuffer.from(v)),readFileSync:(p,e)=>{if(!files.has(p))throw Error('File not found');return e?files.get(p).toString():files.get(p);}};
  const path={join:(...a)=>a.join('/').replace(/\/+/g,'/'),basename:p=>String(p).split('/').pop(),extname:p=>{const n=path.basename(p),i=n.lastIndexOf('.');return i<0?'':n.slice(i);}};
  const http={createServer:fn=>{handler=fn;return {listen:(_port,_host,fn)=>fn&&fn()};},get:(url,_options,callback)=>{const events={};queueMicrotask(()=>{const data=nodeResponse(url),response={on:(event,fn)=>{events[event]=fn;return response;}};callback(response);queueMicrotask(()=>{events.data?.(JSON.stringify(data));events.end?.();});});return {on(){return this;},destroy(){}};}};
  const crypto={randomUUID:()=>nativeCrypto.randomUUID?nativeCrypto.randomUUID():Array.from(nativeCrypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join(''),createHash:()=>{const parts=[];return {update(value){parts.push(DemoBuffer.from(value));return this;},digest(format){const merged=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){merged.set(p,offset);offset+=p.length;}const result=new DemoBuffer(load('noble-sha256').sha256(merged));return format==='hex'?result.toString('hex'):result;}};}};
  const verification={getVerification:()=>({ok:true,version:'IV',mode:'browser-demo',generatedAt:new Date().toISOString(),targetChainDeployed:false,reports:Object.entries(REPORTS).map(([id,item])=>({id,title:item.title,status:item.report.status,available:true,history:false,url:item.url,createdAt:item.report.createdAt,summary:item.report.summary||null,sha256:item.sha256})),boundaries:['公开网页运行独立的浏览器规则演示，不连接真实被保节点。','历史本地执行记录保留原日期；在线演示不代表新的链上部署。','真实模型仅可在本地配置后使用，公开版未接入模型服务。']}),readReport:id=>{if(!Object.hasOwn(REPORTS,id)){const e=Error('报告不存在');e.status=404;throw e;}return REPORTS[id];}};
  const model={createModelRoutes:()=>((req,res,p)=>{if(!p.startsWith('/api/model/'))return false;res.writeHead(p.endsWith('/status')?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify(p.endsWith('/status')?{available:false,model:null,busy:false,reason:'公开 Demo 未接入模型。源码本地运行可配置 Ollama。'}:{ok:false,error:{message:'公开 Demo 不上传事故资料，也未连接模型服务。请使用源码本地运行。'}}));return true;})};
  const builtins={http,fs,path,crypto,'node:crypto':crypto,'noble-crypto':{crypto:nativeCrypto},model,verification,static:()=>false};
  const process={env:{PORT:'8788',NODE_SRV:'/demo-node'},on(){}};const Buffer=DemoBuffer,__dirname='demo-memory';
  function load(id){if(Object.hasOwn(builtins,id))return builtins[id];if(cache[id])return cache[id].exports;const entry=MODULES[id];if(!entry)throw Error('Unknown demo module: '+id);const module={exports:{}};cache[id]=module;entry.run(module,module.exports,key=>load(entry.dependencies[key]||key),{process,Buffer,__dirname});return module.exports;}
  load('engine');
  async function request(input,options={}){const u=new URL(input instanceof URL?input.href:typeof input==='string'?input:input.url,location.origin);if(input instanceof Request){options={method:input.method,headers:Object.fromEntries(input.headers),...(input.method!=='GET'&&input.method!=='HEAD'?{body:await input.clone().text()}:{}),...options};}if(u.pathname.startsWith('/api/reports/')){const item=REPORTS[u.pathname.split('/').pop()];return new Response(item?item.raw:JSON.stringify({error:'报告不存在'}),{status:item?200:404,headers:{'Content-Type':'application/json',...(item?{'X-Report-SHA256':item.sha256}:{})}});}if(u.pathname.startsWith('/demo-node/')){const result=nodeResponse(u.href);return new Response(JSON.stringify(result),{status:result.status==='down'?503:200,headers:{'Content-Type':'application/json'}});}return new Promise((resolve,reject)=>{const listeners={},headers={};let status=200,ended=false;const res={writeHead(code,h){status=code;Object.assign(headers,h);},setHeader(k,v){headers[k]=v;},end(body){if(ended)return;ended=true;resolve(new Response(body??null,{status,headers}));}};const req={url:u.pathname+u.search,method:options.method||input.method||'GET',headers:options.headers||{},on(event,fn){listeners[event]=fn;return this;}};try{handler(req,res);queueMicrotask(()=>{try{if(options.body)listeners.data?.(options.body);listeners.end?.();}catch(e){reject(e);}});}catch(e){reject(e);}});}
  return {request,nodeResponse,mode:'browser-demo'};
 }
 const engine=inherited||createEngine();window.AegisDemo=engine;
 window.fetch=async(input,options={})=>{const u=new URL(input instanceof URL?input.href:typeof input==='string'?input:input.url,location.origin);if(u.origin===location.origin&&(/^(\/api\/|\/uploads\/|\/demo-node\/)/.test(u.pathname)))return engine.request(input,options);if(/^(localhost|127\.0\.0\.1)$/.test(u.hostname)&&u.port==='8787')return engine.request('/demo-node'+u.pathname+u.search,options);return nativeFetch(input,options);};
 document.addEventListener('click',async event=>{
  const link=event.target.closest('a[href]');if(!link)return;const url=new URL(link.href,location.origin);if(url.origin!==location.origin||!url.pathname.startsWith('/uploads/'))return;
  event.preventDefault();try{const response=await engine.request(url.href);if(!response.ok)throw Error('资料不存在');const blob=await response.blob(),objectUrl=URL.createObjectURL(blob),a=document.createElement('a');a.href=objectUrl;a.download=url.pathname.split('/').pop();document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),60000);}catch{alert('本次浏览器会话中无法读取此资料。');}
 },true);
 document.addEventListener('DOMContentLoaded',()=>{
  document.documentElement.dataset.demo='public';
  for(const e of document.querySelectorAll('.wb-session,.session-label'))e.textContent='浏览器演示';
  const dataSource=document.querySelector('.metrics-source');if(dataSource&&dataSource.firstChild)dataSource.childNodes.forEach(n=>{if(n.nodeType===3)n.textContent=n.textContent.replace('本地演示数据','浏览器模拟数据');});
  const notes=document.querySelector('#data .data-note');if(notes)notes.textContent='访客独立的浏览器规则模拟；刷新页面开始新会话，不代表真实经营或目标链运行。';
  const serverUrl=document.getElementById('srvUrl');if(serverUrl){serverUrl.value='/demo-node';serverUrl.readOnly=true;serverUrl.setAttribute('aria-label','浏览器演示节点');}
  const availability=document.getElementById('modelAvailability');if(availability)availability.textContent='公开 Demo 未接入模型。事故文本不上传，可使用源码本地配置。';
  const modelForm=document.getElementById('modelForm');if(modelForm){const submit=modelForm.querySelector('[type=submit]');if(submit){submit.disabled=true;submit.textContent='在线模型未接入';}}
 });
})();
