'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const REPORT_ROOT=path.join(__dirname,'../reports');
const REPORTS=Object.freeze({
  contracts:{file:'contract-verification-IV.json',title:'IV 合约及本地 EVM 验证'},
  model:{file:'model-evaluation-IV.json',title:'IV 真实本地模型小样本评估'},
  'target-chain':{file:'target-chain-IV.json',title:'目标链连通性与部署状态'},
  'historical-local-transactions':{file:'real-tx-local.json',title:'历史版本本地交易',history:true},
  'historical-monte-carlo':{file:'feasibility-mc.json',title:'历史条件性蒙特卡洛模拟',history:true},
  'historical-calibration':{file:'severity-calibration.json',title:'历史参数校准记录',history:true}
});
function readReport(id,root=REPORT_ROOT) {
  if(!Object.hasOwn(REPORTS,id)) {const e=new Error('报告不存在。');e.status=404;throw e;}
  const file=path.join(root,REPORTS[id].file);
  let stat;try {stat=fs.lstatSync(file);}catch {const e=new Error('报告尚未生成。');e.status=404;throw e;}
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>4*1024*1024) {const e=new Error('报告不可读取。');e.status=422;throw e;}
  try {const raw=fs.readFileSync(file);const report=JSON.parse(raw.toString('utf8'));if(!report || Array.isArray(report) || typeof report!=='object') throw Error();return {report,sha256:crypto.createHash('sha256').update(raw).digest('hex')};}
  catch {const e=new Error('报告格式无效。');e.status=422;throw e;}
}
function getVerification(root=REPORT_ROOT) {
  const reports=Object.entries(REPORTS).map(([id,meta])=>{
    const entry={id,title:meta.title,status:'unverified',available:false,history:!!meta.history,url:'/api/reports/'+id,createdAt:null,summary:null,sha256:null};
    try {
      const {report,sha256}=readReport(id,root);entry.available=true;entry.sha256=sha256;entry.createdAt=report.createdAt || report.at || report.ts || null;entry.summary=report.summary || null;
      if(meta.history)entry.status='historical';
      else if(report.version==='IV' && ['passed','failed','partial','not-deployed','deployed'].includes(report.status))entry.status=report.status;
    } catch(error) {if(error.status!==404)entry.status='invalid';}
    return entry;
  });
  return {ok:true,version:'IV',mode:'local-demo',generatedAt:new Date().toISOString(),targetChainDeployed:reports.some(x=>x.id==='target-chain'&&x.status==='deployed'),reports,boundaries:['模型仅作资料辅助研判，不能出单、裁决或转账。','本地 EVM 交易不代表已部署到 BOT Chain。','证据上报与争议裁决为权限型原型，未实现去中心化预言机。','历史模拟依赖假设与输入样本，不证明真实经营盈利或零风险。','报告是可复现检查的记录，不是独立审计或真实性保证。']};
}
module.exports={REPORTS,readReport,getVerification};
