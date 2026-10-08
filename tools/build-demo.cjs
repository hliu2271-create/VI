'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),target=path.join(root,'dist');
fs.mkdirSync(target,{recursive:true});fs.cpSync(path.join(root,'frontend'),target,{recursive:true});
const modules={};
function addNoble(file,id='noble-sha256'){if(modules[id])return id;const text=fs.readFileSync(file,'utf8'),dependencies={};modules[id]={text,dependencies};for(const match of text.matchAll(/require\(["']([^"']+)["']\)/g)){const spec=match[1];if(spec==='node:crypto'){dependencies[spec]='noble-crypto';continue;}const resolved=require.resolve(spec,{paths:[path.dirname(file)]}),child='noble-'+path.basename(resolved,'.js');dependencies[spec]=addNoble(resolved,child);}return id;}
addNoble(require.resolve('@noble/hashes/sha256'));
modules.pricing={text:fs.readFileSync(path.join(root,'server/pricing.js'),'utf8'),dependencies:{fs:'fs',path:'path'}};
modules.engine={text:fs.readFileSync(path.join(root,'server/insurer.js'),'utf8').replaceAll('压测流量注入被保节点','节点故障情景模拟').replaceAll('AI Agent 集群接管全流程','规则流程演示就绪'),dependencies:{http:'http',fs:'fs',path:'path',crypto:'crypto','node:crypto':'crypto','./model-assist':'model','./verification':'verification','./pricing.js':'pricing','./static-files':'static'}};
fs.mkdirSync(path.join(target,'reports'),{recursive:true});
const reports={};for(const [id,file,title] of [['contracts','contract-verification-IV.json','IV 本地合约执行记录'],['model','model-evaluation-IV.json','IV 本地模型历史样例'],['target-chain','target-chain-IV.json','目标链部署状态']]){const raw=fs.readFileSync(path.join(root,'reports',file));fs.writeFileSync(path.join(target,'reports',file),raw);reports[id]={title,url:'/reports/'+file,raw:raw.toString('utf8'),report:JSON.parse(raw),sha256:crypto.createHash('sha256').update(raw).digest('hex')};}
let runtime=fs.readFileSync(path.join(root,'frontend/demo/runtime.js'),'utf8');
const factories=Object.entries(modules).map(([id,m])=>JSON.stringify(id)+':{dependencies:'+JSON.stringify(m.dependencies)+',run:function(module,exports,require,context){const {process,Buffer,__dirname}=context;\n'+m.text+'\n}}').join(',\n');
runtime=runtime.replace('const nativeFetch=window.fetch.bind(window),nativeCrypto=window.crypto;','const nativeFetch=window.fetch.bind(window),nativeCrypto=window.crypto;\nconst REPORTS='+JSON.stringify(reports)+';\nconst CALIBRATION='+fs.readFileSync(path.join(root,'reports/severity-calibration.json'),'utf8')+';\nconst MODULES={'+factories+'};');
fs.writeFileSync(path.join(target,'demo/bridge.js'),runtime);
const visit=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?visit(path.join(p,e.name)):[path.join(p,e.name)]);
for(const file of visit(target)){if(file.includes(path.sep+'vendor'+path.sep)||!['.html','.js'].includes(path.extname(file))||file.endsWith('bridge.js')||file.endsWith('runtime.js'))continue;let text=fs.readFileSync(file,'utf8');if(file.endsWith('.html'))text=text.replace(/<head>/i,'<head>\n<script src="/demo/bridge.js"></script>');text=text.replaceAll('本地演示','浏览器演示').replaceAll('真实算力节点','演示算力节点').replaceAll('真实节点','模拟节点').replaceAll('已上链','已完成（模拟结算）').replaceAll('AI 裁决','规则裁决');if(['chain.js','protocol-chain.js'].includes(path.basename(file)))text+='\nCHAIN.contracts=async function(){throw new Error("公开 Demo 仅展示流程，不提交真实资金交易；请使用源码本地配置。");};\n';fs.writeFileSync(file,text);}
console.log(JSON.stringify({status:'BUILT',directory:'dist',modules:Object.keys(modules),mode:'isolated-browser-demo',videoBytes:fs.statSync(path.join(target,'assets/aegis-demo.mp4')).size}));
