// Deterministic protocol fixtures only. These tests do not establish model quality.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modelFile = path.join(__dirname, '../server/model-assist.js');
const verificationFile = path.join(__dirname, '../server/verification.js');
test('IV model and verification modules exist', () => {
  assert.ok(fs.existsSync(modelFile), 'structured model service is missing');
  assert.ok(fs.existsSync(verificationFile), 'verification service is missing');
});
if (fs.existsSync(modelFile) && fs.existsSync(verificationFile)) {
  const { createModelAssist, validateResult, ModelError } = require(modelFile);
  const { getVerification, readReport } = require(verificationFile);
  const input = '节点 A：10:00 离线，10:20 恢复。';
  const valid = () => ({summary:'资料记录一次离线。', observations:[{quote:'10:00 离线',finding:'记录了离线起点，仍需核验来源。'}],missing:['独立监控来源'],recommendation:'REQUEST_EVIDENCE',rationale:'资料尚不足以独立认定事故。'});
  const fixture = (result = valid(), overrides = {}) => async url => new Response(JSON.stringify(url.endsWith('/api/tags') ? {models:[{name:'fixture:1'}]} : {model:'fixture:1',done:true,created_at:new Date().toISOString(),message:{content:JSON.stringify(result)},...overrides}));
  const service = (fetchImpl = fixture(), extra = {}) => createModelAssist({model:'fixture:1',fetchImpl,...extra});
  test('returns model provenance and advisory-only structured result', async () => {
    let request;
    const fetchImpl = async (url, opts) => { if(opts?.body) request = JSON.parse(opts.body); return fixture()(url); };
    const result = await service(fetchImpl).analyze(input);
    assert.equal(result.model,'fixture:1'); assert.equal(result.advisoryOnly,true);
    assert.ok(Number.isFinite(result.elapsedMs)); assert.ok(Date.parse(result.createdAt));
    assert.equal(request.stream,false); assert.equal(request.think,false);
    assert.equal(request.options.num_ctx,4096,'short evidence should use a bounded small context');
    assert.equal(request.messages[1].role,'user'); assert.ok(request.format.properties.observations);
  });
  test('rejects invalid inputs before inference', async () => {
    const app = service(async () => { throw Error('must not fetch'); });
    for (const text of ['', ' ', null, {}, '字'.repeat(8001)]) await assert.rejects(app.analyze(text), e => e.code === 'INVALID_INPUT');
  });
  test('only verbatim input quotes pass and payout instructions cannot become actions', () => {
    assert.deepEqual(validateResult(valid(),input),valid());
    const cases = [ {...valid(),observations:[{quote:'invented outage',finding:'x'}]}, {...valid(),recommendation:'APPROVE_PAYOUT'}, {...valid(),payout:100}, {...valid(),observations:[]}, {...valid(),missing:[],recommendation:'REQUEST_EVIDENCE'}, {...valid(),summary:'x'.repeat(2001)} ];
    for(const result of cases) assert.throws(() => validateResult(result,input),ModelError);
    assert.throws(() => validateResult({...valid(),observations:[{quote:' ',finding:'fake'}]},input),ModelError);
  });
  test('reports unavailable or missing model without synthesized answer', async () => {
    const down = service(async () => {throw Error('secret connection details');});
    assert.equal((await down.status()).available,false);
    await assert.rejects(down.analyze(input),e=>e.code==='MODEL_UNAVAILABLE' && !e.message.includes('secret'));
    const absent = service(async()=>new Response('{"models":[]}'));
    assert.equal((await absent.status()).reason,'MODEL_NOT_FOUND');
    await assert.rejects(absent.analyze(input),e=>e.code==='MODEL_NOT_FOUND');
  });
  test('rejects malformed JSON, incomplete outputs, and a mismatched model identity', async () => {
    for(const overrides of [{done:false},{model:'other:1'},{message:{content:'not json'}}]) {
      await assert.rejects(service(fixture(valid(),overrides)).analyze(input),e=>e.code==='INVALID_MODEL_OUTPUT');
    }
  });
  test('times out inference and releases the busy slot', async () => {
    const app = service(async (url,{signal}={}) => url.endsWith('/api/tags') ? fixture()(url) : new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')))),{timeoutMs:35});
    await assert.rejects(app.analyze(input),e=>e.code==='MODEL_TIMEOUT');
    assert.equal((await app.status()).busy,false);
  });
  test('limits concurrent inference without queuing', async () => {
    let release;
    const app = service(async url => url.endsWith('/api/tags') ? fixture()(url) : new Promise(resolve=>{release=()=>resolve(fixture()(url));}));
    const pending=app.analyze(input);
    while(!release) await new Promise(resolve=>setTimeout(resolve,1));
    await assert.rejects(app.analyze(input),e=>e.code==='MODEL_BUSY'); release(); await pending;
  });
  test('limits response bytes', async () => {
    const app = service(async url=>url.endsWith('/api/tags')?fixture()(url):new Response('x'.repeat(131073)));
    await assert.rejects(app.analyze(input),e=>e.code==='INVALID_MODEL_OUTPUT');
  });
  test('rejects remote and credential-bearing Ollama URLs', () => {
    for(const baseUrl of ['https://example.com','http://user:password@localhost:11434','http://127.0.0.1:11434/path']) assert.throws(()=>service(fixture(),{baseUrl}),ModelError);
  });
  test('verification is unverified until explicit versioned reports exist; reports use fixed whitelist', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-IV-test-'));
    try {
      let result=getVerification(root);
      assert.equal(result.reports.find(x=>x.id==='contracts').status,'unverified');
      assert.equal(result.targetChainDeployed,false);
      assert.throws(()=>readReport('../package.json',root));
      fs.writeFileSync(path.join(root,'contract-verification-IV.json'),JSON.stringify({version:'IV',status:'passed',summary:{passed:8,failed:0,total:8}}));
      result=getVerification(root); assert.equal(result.reports.find(x=>x.id==='contracts').status,'passed');
      fs.writeFileSync(path.join(root,'contract-verification-IV.json'),JSON.stringify({status:'passed'}));
      assert.equal(getVerification(root).reports.find(x=>x.id==='contracts').status,'unverified');
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  });
  test('isolated HTTP integration enforces methods, origin, JSON and report whitelist', {timeout:20000}, async () => {
    const http=require('node:http');const {spawn}=require('node:child_process');
    const dummy=http.createServer((req,res)=>{
      res.setHeader('Content-Type','application/json');
      if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:'fixture:1'}]}));
      if(req.url==='/api/chat'){req.resume();return res.end(JSON.stringify({model:'fixture:1',done:true,message:{content:JSON.stringify(valid())}}));}
      res.end(JSON.stringify({status:'ok',healthy:true}));
    });
    await new Promise((resolve,reject)=>{dummy.once('error',reject);dummy.listen(21887,'127.0.0.1',resolve);});
    const child=spawn(process.execPath,['server/insurer.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:'21888',NODE_SRV:'http://127.0.0.1:21887',AEGIS_OLLAMA_URL:'http://127.0.0.1:21887',AEGIS_MODEL:'fixture:1'},stdio:'ignore',windowsHide:true});
    const base='http://127.0.0.1:21888';
    try {
      let started=false;
      for(let i=0;i<80;i++){if(child.exitCode!==null)throw Error('Isolated insurer failed to start');try{const r=await fetch(base+'/api/model/status');if(r.ok){started=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
      assert.ok(started,'isolated server startup');
      const post=(body,headers={})=>fetch(base+'/api/model/analyze',{method:'POST',headers:{'Content-Type':'application/json',...headers},body});
      assert.equal((await(await post(JSON.stringify({text:input}))).json()).model,'fixture:1');
      assert.equal((await post('{')).status,400);
      assert.equal((await post(JSON.stringify({text:input,extra:1}))).status,400);
      assert.equal((await post(JSON.stringify({text:'x'.repeat(8001)}))).status,400);
      assert.equal((await post(JSON.stringify({text:input}),{Origin:'https://untrusted.example'})).status,403);
      assert.equal((await post(JSON.stringify({text:input}),{'Content-Type':'text/plain'})).status,415);
      assert.equal((await fetch(base+'/api/model/analyze')).status,405);
      assert.equal((await post('x'.repeat(70000))).status,413);
      const verification=await(await fetch(base+'/api/verification')).json();assert.equal(verification.version,'IV');
      assert.equal((await fetch(base+'/api/reports/not-listed')).status,404);
      assert.equal((await fetch(base+'/api/reports/%2e%2e%2fpackage.json')).status,404);
      assert.equal((await fetch(base+'/api/verification',{method:'POST'})).status,405);
    } finally {
      child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
      dummy.closeAllConnections();await new Promise(resolve=>dummy.close(resolve));
    }
  });
}
