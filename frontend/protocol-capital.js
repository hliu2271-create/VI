/* IV operations stay read-only until wallet, chain and contract bindings are verified. */
(()=>{
 const nativeHost=document.querySelector('#wb-panel-protocol .view[data-view="0"]');
 if(document.body.dataset.suite!=='protocol'&&!nativeHost)return;
 const panel=document.createElement('section');panel.className='capital-panel';panel.id='capitalPanel';
 panel.innerHTML=`<div class="capital-top"><div><h2>承保资金与事故处理</h2><p>读取已校验合约的实际状态。默认本地演示不提交交易。</p></div><button id="capitalRefresh">刷新状态</button></div>
 <div class="capital-stats"><div class="capital-stat"><small>可用承保资金</small><strong id="capitalFree">—</strong></div><div class="capital-stat"><small>保单预留</small><strong id="capitalReserved">—</strong></div><div class="capital-stat"><small>待赚保费</small><strong id="capitalPending">—</strong></div><div class="capital-stat"><small>我的 LP 份额</small><strong id="capitalShares">—</strong></div></div>
 <label for="capitalUnits">赎回份额（不是 BOT 金额）</label><input id="capitalUnits" inputmode="decimal" placeholder="输入份额数量"><div class="capital-actions"><button id="capitalAll">填入全部份额</button><button class="primary" id="capitalWithdraw">赎回到当前钱包</button><button id="capitalRefund">领取待退保费</button></div><div class="capital-refund" id="capitalRefundValue">待退保费：—</div>
 <details><summary>事故请求、证据与裁决</summary><p>投保方提出请求；指定上报者确认证据后进入挑战期；争议由独立裁决者处理。证据摘要须来自真实资料。模型建议不会触发这些操作。</p>
 <div class="capital-fields"><label>保单编号<input id="capitalPolicy" type="number" min="1" step="1" placeholder="链上保单 ID"></label><label>观测中断时长（秒）<input id="capitalSeconds" type="number" min="1" step="1" placeholder="实际观测时长"></label><label>证据 / 裁决摘要（bytes32）<input id="capitalDigest" placeholder="0x + 64 位十六进制"></label><label>裁决结果<select id="capitalDecision"><option value="false">驳回争议赔付</option><option value="true">核准争议赔付</option></select></label></div>
 <div class="capital-actions"><button data-capital="status">查询保单</button><button data-capital="request">提出事故请求</button><button data-capital="confirm">确认事故证据</button><button data-capital="adjudicate">提交裁决</button><button data-capital="resolve">结算保单</button><button data-capital="expire">关闭无事故到期保单</button><button data-capital="timeout">关闭逾期未裁决案件</button></div></details>
 <div class="capital-status" id="capitalStatus" role="status" aria-live="polite">本地演示 · 连接钱包并校验 IV 合约后可操作。</div>`;
 const footer=document.querySelector('.wrap footer')||document.querySelector('footer');if(nativeHost)nativeHost.append(panel);else if(footer)footer.before(panel);else document.body.append(panel);
 const q=id=>panel.querySelector('#'+id);let busy=false,last=null;
 const show=(message,error=false)=>{q('capitalStatus').textContent=message;q('capitalStatus').dataset.error=String(error);};
 const requireChain=()=>{if(CHAIN.mode!=='chain')throw Error('尚未校验 IV 合约。请先完成钱包和四个合约地址配置。');};
 const amount=n=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:6})+' '+CHAIN.netCfg().symbol;
 async function refresh(){requireChain();const s=await CHAIN.readState();last=s;for(const [id,value]of [['capitalFree',amount(s.free)],['capitalReserved',amount(s.reserved)],['capitalPending',amount(s.pending)],['capitalShares',s.shares]])q(id).textContent=value;q('capitalRefundValue').textContent='待退保费：'+s.refund+' '+CHAIN.netCfg().symbol;}
 async function run(action){if(busy)return;busy=true;panel.querySelectorAll('button').forEach(b=>b.disabled=true);show('正在处理，请在钱包中核对操作…');try{requireChain();const result=await action();const message=typeof result==='string'?result:result?.hash?'交易已确认\n'+result.hash:'已读取合约状态。';show(message);try{await refresh();}catch(error){show(message+'\n状态刷新失败：'+(error.shortMessage||error.message),true);}}catch(e){show(e.shortMessage||e.message,true);}finally{busy=false;panel.querySelectorAll('button').forEach(b=>b.disabled=false);}}
 q('capitalRefresh').onclick=()=>run(refresh);
 q('capitalAll').onclick=()=>{if(last)q('capitalUnits').value=last.shares;else show('请先刷新已校验合约状态。',true);};
 q('capitalWithdraw').onclick=()=>run(()=>{const value=q('capitalUnits').value.trim();if(!/^\d+(\.\d{1,27})?$/.test(value)||!/[1-9]/.test(value))throw Error('请输入有效的正份额数量，最多 27 位小数。');return CHAIN.withdraw(value);});
 q('capitalRefund').onclick=()=>run(()=>CHAIN.withdrawRefund());
 panel.querySelectorAll('[data-capital]').forEach(button=>button.onclick=()=>run(async()=>{
  const id=Number(q('capitalPolicy').value);if(!Number.isSafeInteger(id)||id<1)throw Error('请输入有效的链上保单编号。');
  const action=button.dataset.capital;
  if(action==='status'){const state=await CHAIN.policyState(id);return '保单 '+id+'：'+state.status+'\n挑战截止：'+(state.deadline?new Date(state.deadline*1000).toLocaleString('zh-CN'):'尚未触发');}
  if(action==='resolve')return CHAIN.resolve(id);if(action==='expire')return CHAIN.expirePolicy(id);if(action==='timeout')return CHAIN.closeUnresolved(id);
  const digest=q('capitalDigest').value.trim();if(action==='confirm'||action==='adjudicate'){if(!/^0x[\da-fA-F]{64}$/.test(digest)||/^0x0{64}$/.test(digest))throw Error('请输入非零 bytes32 证据 / 裁决摘要。');}
  if(action==='adjudicate')return CHAIN.adjudicate(id,q('capitalDecision').value==='true',digest);
  const seconds=Number(q('capitalSeconds').value);if(!Number.isSafeInteger(seconds)||seconds<=0||seconds>4294967295)throw Error('请输入有效的观测秒数。');
  return action==='request'?CHAIN.reportViolation(id,seconds):CHAIN.confirmViolation(id,seconds,digest);
 }));
 CHAIN.listeners.push(()=>{last=null;['capitalFree','capitalReserved','capitalPending','capitalShares'].forEach(id=>q(id).textContent='—');q('capitalRefundValue').textContent='待退保费：—';if(!busy)show(CHAIN.mode==='chain'?'IV 合约已校验，请刷新实际状态。':'本地演示 · 尚未校验链上合约。');});
})();
