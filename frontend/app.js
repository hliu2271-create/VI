/* ============================================================
   Aegis 神盾 · ComputeShield 协议演示前端
   全业务闭环模拟：节点质押 → AI定价投保 → 宕机触发 →
   24h乐观挑战窗口 → AI裁决 → 自动Slashing赔付
   ============================================================ */

const S = {
  block: 10234400,
  pool: 0, paid: 0, slashed: 0,
  nodes: [], policies: [],
  nextPolicy: 1,
  WINDOW: 24,          // 演示环境：24h 挑战窗口压缩为 24s
  step: 1,
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const addr = () => '0x' + hex(6) + '…' + hex(4);
const txHash = () => '0x' + hex(40);

/* ---------- HUD 状态环 ---------- */
const STEPS = [
  ['💓', '心跳模拟', '节点持续上报心跳'],
  ['🩺', '风控评估', 'Agent 实时评估风险分'],
  ['💰', 'AI 定价', '动态报价 · 生成保单'],
  ['⚠️', '违约触发', '监控到宕机，进入窗口'],
  ['⏳', '挑战窗口', '24h 内可提出争议'],
  ['⚡', '自动赔付', 'AI 裁决 · Slashing 赔付'],
];
function lightStep(i) {
  S.step = i;
  document.querySelectorAll('.ps').forEach(p => {
    const k = +p.dataset.s;
    p.classList.toggle('lit', k === i);
    p.classList.toggle('done', k < i);
  });
  const el = $('stepNow');
  if (el) el.textContent = `当前：${STEPS[i][1]} · ${STEPS[i][2]}`;
}

/* ---------- 日志 / toast ---------- */
function logAI(who, text, cls) {
  const d = $('aiLog');
  d.insertAdjacentHTML('beforeend',
    `<div class="ln"><span class="tm">${now()}</span><span class="who ${cls || ''}">${who}</span><span>${text}</span></div>`);
  d.scrollTop = d.scrollHeight;
}
function logEV(text, cls) {
  const d = $('evLog');
  d.insertAdjacentHTML('beforeend',
    `<div class="ln"><span class="tm">${now()}</span><span class="who ${cls || ''}">◆</span><span>${text}</span></div>`);
  d.scrollTop = d.scrollHeight;
}
function tx(label) {
  logEV(`<span style="color:#98989d">[模拟] ${label}</span> <span style="color:#e8e8ed">${txHash()}</span>`, 'info');
}
function toast(msg, type) {
  $('toast').insertAdjacentHTML('beforeend', `<div class="toast ${type || ''}">${msg}</div>`);
  setTimeout(() => { const t = $('toast').firstChild; if (t) t.remove(); }, 4200);
}
function busy(i, ms) {
  const el = $('ag' + i);
  el.classList.add('busy');
  setTimeout(() => el.classList.remove('busy'), ms || 2200);
}

/* ---------- KPI 数字动画 ---------- */
function setNum(id, val) {
  const el = $(id), to = Math.round(val), from = parseInt((el.textContent || '0').replace(/,/g, '')) || 0;
  if (from === to) return;
  const t0 = performance.now(), dur = 600;
  function tick(t) {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
function renderKPI() {
  setNum('pPool', S.pool); setNum('pNodes', S.nodes.length);
  setNum('pPolicies', S.policies.filter(p => p.status === 'Active' || p.status === 'Triggered' || p.status === 'Challenged').length);
  setNum('pPaid', S.paid); setNum('pSlash', S.slashed);
}

/* ============================================================
   链上接入：BOT Chain（chain.js）
   链上模式 = 钱包已连接 + 合约地址已配置 + 链 ID 正确
   否则保持演示模式，全链路模拟不受影响
   ============================================================ */
const onChain = () => CHAIN.mode === 'chain';

function txLink(label, hash) {
  const url = CHAIN.explorerTx(hash);
  const h = hash ? hash.slice(0, 12) + '…' : '';
  logEV(`<span style="color:#98989d">${label}</span> ` +
    (url ? `<a href="${url}" target="_blank" style="color:#0071e3;text-decoration:none">${h} ↗</a>`
         : `<span style="color:#e8e8ed">${h}</span>`), 'info');
}
async function guardChain(what) {
  if (!onChain()) return false;
  if (!CHAIN.account) { toast('请先连接钱包', 'warn'); return false; }
  return true;
}
function failChain(e, what) {
  const m = (e && (e.shortMessage || e.reason || e.message)) || String(e);
  toast(`${what}失败：${m.slice(0, 120)}`, 'err');
  logAI('⛓️ 链上', `<span style="color:#ff3b30">${what}失败</span> · ${m.slice(0, 160)}`, 'err');
}

/* ---------- 链上配置面板 ---------- */
function renderChainBar() {
  const net = CHAIN.netCfg(), cfgd = CHAIN.configured();
  $('cNet').value = CHAIN.net;
  $('cCore').value = CHAIN.addr.core; $('cPool').value = CHAIN.addr.pool;
  $('cReg').value = CHAIN.addr.registry; $('cAi').value = CHAIN.addr.ai;
  $('netName').textContent = onChain() ? net.name : (CHAIN.account ? '钱包已连接 · 合约未验证' : '本地演示');
  const pill = $('modePill'), btn = $('walletBtn');
  $('registerNodeBtn').textContent = onChain() ? '质押并注册节点（1,000 BOT 起）' : '注册模拟节点（1,000 BOT 起）';
  if (onChain()) {
    pill.className = 'pill on';
    pill.textContent = '链上模式 · ' + CHAIN.short(CHAIN.account);
    btn.textContent = CHAIN.short(CHAIN.account);
  } else {
    pill.className = 'pill off';
    pill.textContent = '本地演示' + (CHAIN.account ? (cfgd ? ' · 合约待验证' : ' · 合约未配置') : '');
    btn.textContent = CHAIN.account ? CHAIN.short(CHAIN.account) : '连接钱包';
  }
  const bits = [`<b>${net.name}</b> · ChainID ${net.id} · RPC ${net.rpc}`];
  if (CHAIN.account) bits.push(`账户 <b>${CHAIN.short(CHAIN.account)}</b>${CHAIN.chainId ? ` · 当前链 ${CHAIN.chainId}` : ''}`);
  if (!cfgd) bits.push('<span style="color:#ff9500">合约地址未配置；链上模式还需连接钱包并匹配网络</span>');
  else bits.push('地址已填写（需字节码与绑定验证） · <a href="' + CHAIN.explorerAddr(CHAIN.addr.core) + '" target="_blank" style="color:#0071e3">在 ' + (net.scan ? '浏览器' : '本地') + '查看 Core ↗</a>');
  $('chainHint').innerHTML = bits.join('　|　') +
    '<br>演示模式不发送链上交易；链上写入操作需钱包签名，交易结果可通过哈希查看。';
}
function saveChainCfg() {
  CHAIN.save($('cNet').value, { core: $('cCore').value, pool: $('cPool').value, registry: $('cReg').value, ai: $('cAi').value });
  renderChainBar();
  toast(CHAIN.configured() ? '合约地址已保存' + (onChain() ? '，已切换到链上模式' : '，连接钱包并匹配网络后生效') : '地址未填全，仍在演示模式', CHAIN.configured() ? 'ok' : 'warn');
  logEV('链上配置已保存 · ' + CHAIN.netCfg().name + ' · Core ' + (CHAIN.addr.core || '—'), 'info');
}
function clearChainCfg() {
  CHAIN.save(CHAIN.net, { core: '', pool: '', registry: '', ai: '' });
  renderChainBar(); toast('已清空合约地址，回到演示模式', 'warn');
}
async function connectWallet() {
  try {
    const a = await CHAIN.connect();
    const b = await CHAIN.balance();
    toast(`钱包已连接 ${CHAIN.short(a)} · 余额 ${(b || 0).toFixed(4)} ${CHAIN.netCfg().symbol}`, 'ok');
    logAI('⛓️ 钱包', `已连接 <b style="color:#0a84ff">${CHAIN.short(a)}</b> · 链 <b>${CHAIN.chainId}</b> · 余额 <b>${(b || 0).toFixed(4)} ${CHAIN.netCfg().symbol}</b>`, 'ok');
    logEV('wallet connected · chainId ' + CHAIN.chainId, 'ok');
  } catch (e) {
    toast(e.message || '连接失败', 'err');
    logAI('⛓️ 钱包', `<span style="color:#ff3b30">${e.message || '连接失败'}</span>`, 'err');
  }
  renderChainBar();
}
async function readChainState() {
  if (!onChain()) return toast('需先连接钱包并配置合约地址', 'warn');
  try {
    const s = await CHAIN.readState();
    S.pool = s.deposits;
    renderKPI();
    logAI('⛓️ 链上读取', `RiskPool 存款 <b>${fmt(s.deposits)}</b> BOT · 累计保费 <b>${fmt(s.premium)}</b> · 累计赔付 <b>${fmt(s.payout)}</b> · 挑战窗口 <b>${s.window}s</b> · 保单 <b>${s.policies}</b> 张`, 'info');
    if (s.window) S.WINDOW = s.window;
    toast('链上状态已同步', 'ok');
  } catch (e) { failChain(e, '读取链上状态'); }
}
CHAIN.onChange(renderChainBar);

/* ---------- 节点（被保方） ---------- */
async function registerNode(stake) {
  stake = stake || 1000;
  if (onChain()) {
    if (!(await guardChain())) return;
    try {
      if (stake < 1000) stake = 1000;               // NodeRegistry.MIN_STAKE
      const r = await CHAIN.register(stake);
      const n = { id: CHAIN.short(CHAIN.account), addr: CHAIN.account, stake, peak: stake, uptime: 0, downtime: 0, online: true, risk: 8, chain: true };
      S.nodes.push(n);
      busy(0, 2600); txLink(`NodeRegistry.register{value:${fmt(stake)} BOT}`, r.hash);
      logAI('🩺 风控Agent', `节点 <b style="color:#0a84ff">${n.id}</b> 已质押注册上链（真实地址），等待风险评分`, 'info');
      const rk = await CHAIN.riskOf(CHAIN.account).catch(() => null);
      if (rk != null) { n.risk = rk; logAI('🩺 风控Agent', `链上风险分读取完成 → <b style="color:#ff9500">${rk}/100</b>`, 'info'); }
      lightStep(0); toast('节点质押注册已上链', 'ok');
      renderNodes(); renderKPI(); refreshQuote();
      return;
    } catch (e) { failChain(e, '节点注册'); return; }
  }
  const n = { id: addr(), stake, peak: stake, uptime: 0, downtime: 0, online: true, risk: Math.floor(Math.random() * 22 + 6) };
  S.nodes.push(n);
  busy(0, 2600);
  tx(`NodeRegistry.register{value:${fmt(stake)} BOT}`);
  logAI('风控 Agent', `模拟节点 <b style="color:#0a84ff">${n.id}</b> 已注册，随机生成示例风险分 <b style="color:#ff9500">${n.risk}/100</b>；本地记录不写入 AIReporter 合约`, 'info');
  lightStep(0);
  toast('模拟节点已注册，初始风险分为演示示例', 'ok');
  renderNodes(); renderKPI(); refreshQuote();
}
function renderNodes() {
  $('nodeList').innerHTML = S.nodes.map((n, i) => `
    <div class="node ${n.online ? '' : 'off'}">
      <div class="node-hd">
        <span class="addr">${n.id}</span>
        <span class="pill ${n.online ? 'on' : 'off'}">${n.online ? '<span class="hb"></span>心跳正常' : '⛔ 宕机中'}</span>
      </div>
      <div class="node-meta">
        <span>质押 <b>${fmt(n.stake)}</b> BOT</span>
        <span>风险分 <b style="color:#ff9500">${n.risk}</b></span>
        ${n.real ? `<span>延迟 <b>${n.latency}ms</b></span>` : ''}
        <span>在线 ${n.uptime} · 离线 ${n.downtime}</span>
        ${n.real ? '<span style="color:#34c759">● 真实节点</span>' : ''}
      </div>
      <div class="bar"><i style="width:${Math.min(100, n.stake / n.peak * 100)}%"></i></div>
      <div class="row-btns" style="margin-top:10px">
        ${n.real
          ? '<span class="hint">由 HTTP 探测更新状态；可通过上方负载测试演示服务异常</span>'
          : `<button class="btn sm dan" ${n.online ? '' : 'disabled'} onclick="simulateDown(${i})">模拟宕机</button>
             <button class="btn sm" ${n.online ? 'disabled' : ''} onclick="reviveNode(${i})">恢复上线</button>`}
      </div>
    </div>`).join('') || '<div class="hint">暂无节点，请先质押注册 →</div>';

  const sel = $('fNode');
  sel.innerHTML = S.nodes.map((n, i) =>
    `<option value="${i}">${n.id} · 风险分 ${n.risk}${n.online ? '' : '（宕机）'}</option>`).join('');
  if (S.nodes.length) sel.value = String(S.nodes.length - 1);
}
function simulateDown(i) {
  if (onChain()) return toast('链上事故须提交真实观测证据，请使用下方 IV 证据操作。', 'warn');
  const n = S.nodes[i];
  n.online = false; n.downtime++;
  busy(0, 3000); lightStep(3);
  logAI('🩺 风控Agent', `节点 <b style="color:#ff3b30">${n.id}</b> 连续 3 次心跳丢失 → 判定宕机，扫描受影响保单…`, 'err');
  renderNodes();
  setTimeout(() => triggerPolicies(n), 2000);
}
function reviveNode(i) {
  const n = S.nodes[i];
  n.online = true; n.risk = Math.max(5, n.risk - 6);
  logAI('🩺 风控Agent', `节点 ${n.id} 心跳恢复，风险分下调至 <b style="color:#34c759">${n.risk}</b>`, 'ok');
  renderNodes(); refreshQuote();
}

/* ---------- 风险池 / 投保 ---------- */
async function lpDeposit(amt) {
  amt = amt || 10000;
  if (onChain()) {
    if (!(await guardChain())) return;
    try {
      const r = await CHAIN.deposit(amt);
      const s = await CHAIN.readState().catch(() => null);
      if (s) S.pool = s.deposits; else S.pool += amt;
      txLink(`RiskPool.deposit{value:${fmt(amt)} BOT}`, r.hash);
      logAI('🏦 承保方', `LP 存入 ${fmt(amt)} BOT 已上链，风险池规模 <b>${fmt(S.pool)}</b> BOT`, 'ok');
      toast(`LP 存入 ${fmt(amt)} BOT 已确认`, 'ok');
      renderKPI(); refreshQuote();
      return;
    } catch (e) { failChain(e, 'LP 存入'); return; }
  }
  S.pool += amt;
  tx(`RiskPool.deposit{value:${fmt(amt)} BOT}`);
  logAI('🏦 承保方', `LP 存入 ${fmt(amt)} BOT，可承保上限提升至 <b>${fmt(S.pool)}</b> BOT`, 'ok');
  toast(`LP 存入 ${fmt(amt)} BOT`, 'ok');
  renderKPI(); refreshQuote();
}
function refreshQuote() {
  const cov = +$('fCov').value;
  $('fCovL').textContent = fmt(cov) + ' BOT';
  const i = +$('fNode').value;
  const box = $('quoteBox');
  if (!S.nodes.length || !S.nodes[i]) { box.classList.remove('on'); return; }
  const n = S.nodes[i];
  const rate = 0.05 + n.risk * 0.002;
  box.classList.add('on');
  $('qPremium').textContent = fmt(cov * rate) + ' BOT';
  $('qDetail').innerHTML =
    `风险分 ${n.risk}/100 → 费率 ${(rate * 100).toFixed(1)}%　|　保额 ${fmt(cov)} BOT<br>` +
    `历史心跳 在线 ${n.uptime} · 离线 ${n.downtime}` +
    (S.pool < cov ? '<br><span style="color:#ff3b30">⚠ 风险池承保能力不足，请先由 LP 存入</span>' : '');
}
async function buyPolicy() {
  const i = +$('fNode').value;
  if (!S.nodes.length || !S.nodes[i]) return toast('请先注册节点', 'warn');
  const n = S.nodes[i];
  const cov = +$('fCov').value, dur = +$('fDur').value, sla = +$('fSla').value;

  if (onChain()) {
    if (!(await guardChain())) return;
    if (!n.addr) return toast('该节点为模拟节点，链上投保请先注册真实节点', 'warn');
    try {
      let premium = await CHAIN.quote(cov, n.risk).catch(() => null);
      const rate = 0.05 + n.risk * 0.002;
      if (premium == null) premium = cov * rate;
      const r = await CHAIN.buyPolicy(n.addr, cov, dur, sla, premium * 1.05);   // 多付部分合约自动退还
      const cid = CHAIN.policyIdFromReceipt(r.receipt);
      const p = {
        id: cid || S.nextPolicy++, node: n, coverage: cov, premium,
        dur, sla, status: 'Active', deadline: 0, chainId: cid,
      };
      S.policies.push(p);
      busy(1, 2600); lightStep(2);
      txLink(`ComputeShieldCore.buyPolicy → 保额 ${fmt(cov)} / 保费 ${fmt(premium)} BOT`, r.hash);
      logAI('💰 定价Agent', `保单 <b>#${p.id}</b> 链上定价完成：费率 <b style="color:#ff9500">${(premium / cov * 100).toFixed(1)}%</b>，保费 <b>${fmt(premium)}</b> BOT（风险分 ${n.risk}）`, 'info');
      logAI('⚖️ 理赔Agent', `保单 #${p.id} SLA 规则已登记：允许宕机 ≤ ${sla}s，违约触发后进入挑战与裁决流程`, 'ok');
      toast(`保单 #${p.id} 已上链生效`, 'ok');
      renderPolicies(); renderKPI();
      return;
    } catch (e) { failChain(e, '投保'); return; }
  }

  if (S.pool < cov) return toast('风险池承保能力不足，请先由 LP 存入资金', 'err');
  const rate = 0.05 + n.risk * 0.002;
  const p = {
    id: S.nextPolicy++, node: n, coverage: cov, premium: cov * rate,
    dur, sla, status: 'Active', deadline: 0,
  };
  S.policies.push(p);
  S.pool += p.premium;
  busy(1, 2600); lightStep(2);
  tx(`ComputeShieldCore.buyPolicy → 保额 ${fmt(cov)} / 保费 ${fmt(p.premium)} BOT`);
  logAI('💰 定价Agent', `保单 #${p.id} 定价完成：费率 <b style="color:#ff9500">${(rate * 100).toFixed(1)}%</b>，保费 <b>${fmt(p.premium)}</b> BOT（风险分 ${n.risk}）`, 'info');
  logAI('⚖️ 理赔Agent', `保单 #${p.id} SLA 规则已登记：允许宕机 ≤ ${sla}s，违约触发后进入挑战与裁决流程`, 'ok');
  toast(`保单 #${p.id} 已生效，保费 ${fmt(p.premium)} BOT 进入风险池`, 'ok');
  renderPolicies(); renderKPI();
}

/* ---------- 触发 / 挑战 / 赔付 ---------- */
async function triggerPolicies(n) {
  if (onChain()) return toast('探测仅提示异常；请手动提交真实观测资料，授权报告者确认后生效。', 'warn');
  let hit = 0;
  for (const p of S.policies) {
    if (p.node !== n || p.status !== 'Active') continue;
    if (onChain() && p.chainId != null) {
      try {
        // 合约要求 downtimeSeconds 超过 SLA 容忍值；用 SLA+60s 作为真实上报值
        const r = await CHAIN.reportViolation(p.chainId, Math.max(1, p.sla + 60));
        p.status = 'Triggered'; p.deadline = S.WINDOW; hit++;
        txLink(`Core.reportViolation(#${p.chainId}, ${p.sla + 60}s)`, r.hash);
        logAI('⚠️ 风控Agent', `保单 <b>#${p.id}</b> 违约已上链 → 进入 <b style="color:#ff9500">挑战窗口 ${S.WINDOW}s</b>`, 'warn');
      } catch (e) { failChain(e, `保单 #${p.id} 违约上报`); }
    } else {
      p.status = 'Triggered'; p.deadline = S.WINDOW; hit++;
      logAI('⚠️ 风控Agent',
        `保单 <b>#${p.id}</b> 违约触发 → 进入 <b style="color:#ff9500">24h 乐观挑战窗口</b>（演示压缩 ${S.WINDOW}s）`, 'warn');
    }
  }
  if (hit) {
    if (!onChain()) tx('reportViolation → ComputeShieldCore（本地模拟上报）');
    lightStep(4);
    toast(`${hit} 张保单已触发，等待挑战窗口`, 'warn');
  }
  renderPolicies(); renderKPI();
}
async function challenge(id) {
  const p = S.policies.find(x => x.id === id);
  if (!p || p.status !== 'Triggered') return;
  if (onChain() && p.chainId != null) {
    try {
      const r = await CHAIN.challenge(p.chainId, 'planned maintenance');
      p.status = 'Challenged';
      txLink(`Core.challenge(#${p.chainId}, "planned maintenance")`, r.hash);
      logAI('⚖️ 理赔Agent', `保单 #${p.id} 已被链上挑战：「属计划内维护」→ 窗口结束后依证据链裁决`, 'err');
      toast('挑战已上链', 'warn');
      renderPolicies();
      return;
    } catch (e) { failChain(e, '发起挑战'); return; }
  }
  p.status = 'Challenged';
  tx(`challenge(#${p.id}, "planned maintenance")`);
  logAI('理赔 Agent', `演示保单 #${p.id} 已发起挑战：「属计划内维护」；窗口结束后展示预设裁决结果`, 'warn');
  toast('演示挑战已记录，等待预设裁决结果', 'warn');
  renderPolicies();
}
async function resolvePolicy(p) {
  busy(2, 3000); lightStep(5);
  const reason = p.status === 'Challenged'
    ? '演示预设结果：挑战驳回，批准赔付'
    : '演示预设结果：窗口结束且无人挑战，批准赔付';

  if (onChain() && p.chainId != null) {
    try {
      const r = await CHAIN.resolve(p.chainId);
      logAI('⚖️ 理赔Agent', `保单 <b>#${p.id}</b> 链上裁决：<span style="color:#34c759">合约裁决交易已确认</span>`, 'ok');
      const confirmed=await CHAIN.policyState(p.chainId);p.status=confirmed.status;
      txLink('Core.resolve(#'+p.chainId+') · '+p.status,r.hash);
      if(p.status==='Paid'){const slash=Math.min(p.node.stake,p.coverage*.1);p.node.stake-=slash;S.paid+=p.coverage;S.slashed+=slash;showFlash(p,slash,r.hash);}
      renderPolicies(); renderKPI(); renderNodes();
      return;
    } catch (e) { failChain(e, '裁决赔付'); return; }
  }

  logAI('⚖️ 理赔Agent', `保单 <b>#${p.id}</b> 裁决：<span style="color:#34c759">${reason}</span>`, 'ok');

  p.status = 'Paid';
  const slash = Math.min(p.node.stake, p.coverage * 0.10);
  p.node.stake -= slash;
  p.node.risk = Math.min(100, p.node.risk + 20);
  S.paid += p.coverage; S.slashed += slash;

  tx(`RiskPool.pay(#${p.id} → 投保方, ${fmt(p.coverage)} BOT)`);
  tx(`NodeRegistry.slash(${p.node.id}, ${fmt(slash)} BOT, "SLA violation")`);
  showFlash(p, slash);
  renderPolicies(); renderKPI(); renderNodes();
}
function showFlash(p, slash, hash) {
  $('flTitle').textContent = hash ? '赔付交易已确认' : '演示赔付已完成';
  $('flAmt').textContent = '+' + fmt(p.coverage) + ' BOT';
  $('flTo').textContent = `→ 投保方钱包　·　保额 ${fmt(p.coverage)} BOT 全额到账`;
  const url = hash ? CHAIN.explorerTx(hash) : '';
  $('flHash').innerHTML = hash
    ? `tx: <a href="${url}" target="_blank" style="color:#0071e3">${hash.slice(0, 16)}… ↗</a>`
    : '模拟交易: ' + txHash();
  const steps = [
    ['⚖️ AI 理赔裁决', '裁决完成 · 批准赔付'],
    ['💸 RiskPool.pay', `向投保方打款 ${fmt(p.coverage)} BOT`],
    ['⚖️ NodeRegistry.slash', `违约节点罚没 ${fmt(slash)} BOT`],
  ];
  $('flSteps').innerHTML = steps.map((s, i) =>
    `<div class="stepx" style="animation-delay:${.15 + i * .18}s">${s[0]} <b>${s[1]}</b></div>`).join('');
  $('flash').classList.add('on');
  logAI('⚡ 协议', `保单 #${p.id} 自动赔付完成：投保方到账 <b style="color:#34c759">${fmt(p.coverage)}</b> BOT，节点罚没 <b style="color:#ff3b30">${fmt(slash)}</b> BOT`, 'ok');
  setTimeout(() => { if ($('flash').classList.contains('on')) hideFlash(); }, 9000);
}
function hideFlash() { $('flash').classList.remove('on'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideFlash(); });

/* ============================================================
   真实算力节点接入：HTTP 探测 + 攻击打挂 → 触发赔付
   ============================================================ */
S.srv = { url: 'http://127.0.0.1:8787', on: false, node: null, latency: 0, risk: 8, fails: 0, attacking: false, up: 0 };

async function jget(path, timeout) {
  timeout = timeout || 2500;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(S.srv.url + path, { cache: 'no-store', signal: c.signal, mode: 'cors' });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch (e) { clearTimeout(t); return null; }
}
function renderSrv() {
  const p = $('srvPill'), n = S.srv.node;
  if (!S.srv.on) { p.className = 'pill off'; p.textContent = '未连接'; return; }
  const online = n && n.online;
  p.className = 'pill ' + (online ? 'on' : 'off');
  p.innerHTML = online
    ? '<span class="hb"></span>在线 · ' + S.srv.latency + 'ms'
    : '⛔ 不可达' + (S.srv.attacking ? ' · 攻击中' : '');
  $('srvMeta').innerHTML =
    `风险分 <b style="color:#ff9500">${S.srv.risk}</b>　·　延迟 <b>${S.srv.latency}ms</b>　·　uptime <b>${S.srv.up}s</b>　·　连续失败 <b style="color:#ff3b30">${S.srv.fails}</b>`;
}
function connectServer() {
  S.srv.url = ($('srvUrl').value || '').trim().replace(/\/+$/, '');
  let n = S.nodes.find(x => x.real);
  if (!n) {
    n = { id: 'aegis-node-01', stake: 2000, peak: 2000, uptime: 0, downtime: 0, online: true, risk: 8, latency: 0, real: true };
    S.nodes.push(n);
    tx(`NodeRegistry.register{value:2000 BOT} ← 真实节点 ${S.srv.url}`);
    logAI('🩺 风控Agent', `真实算力节点 <b style="color:#0a84ff">${S.srv.url}</b> 已接入，开始周期性 HTTP 心跳探测`, 'info');
    toast('已接入真实节点，开始 3s 一次心跳探测', 'ok');
  }
  S.srv.node = n; S.srv.on = true; S.srv.fails = 0;
  if (!S.srv.timer) S.srv.timer = setInterval(probe, 3000);
  lightStep(0); renderSrv(); renderNodes(); renderKPI(); refreshQuote(); probe();
}
async function probe() {
  if (!S.srv.on || !S.srv.node) return;
  const n = S.srv.node;
  const d = await jget('/health', 2500);
  if (d && d.status === 'ok') {
    if (!n.online) {
      n.online = true;
      logAI('🩺 风控Agent', `节点恢复响应，心跳重新上报（延迟 ${d.avgLatency}ms）`, 'ok');
    }
    n.uptime++; n.risk = d.risk; n.latency = d.avgLatency;
    S.srv.latency = d.avgLatency; S.srv.risk = d.risk; S.srv.up = d.uptime; S.srv.fails = 0;
    if (d.underAttack && d.risk > 40) {
      logAI('🩺 风控Agent', `检测到算力饱和：延迟 ${d.avgLatency}ms → 风险分上调至 <b style="color:#ff9500">${d.risk}</b>，新保单保费随之上浮`, 'warn');
      busy(0, 2000);
    }
    refreshQuote();
  } else {
    S.srv.fails++;
    if (S.srv.fails >= 2 && n.online) {
      n.online = false; n.downtime++;
      logAI('🩺 风控Agent', `真实节点连续 <b style="color:#ff3b30">${S.srv.fails}</b> 次探测超时 / 不可达 → 判定违约宕机`, 'err');
      tx('reportViolation ← 真实探测证据（链下风控Agent上报）');
      lightStep(3);
      setTimeout(() => triggerPolicies(n), 1200);
    }
  }
  renderSrv(); renderNodes(); renderKPI();
}
async function attackServer() {
  if (!S.srv.on) return toast('请先接入真实节点服务器', 'warn');
  const N = +$('atkN').value || 12, ms = (+$('atkMs').value || 6) * 1000;
  S.srv.attacking = true; renderSrv();
  logAI('🔥 攻击', `向 <b>${S.srv.url}/work</b> 发起 ${N} 并发 × ${ms / 1000}s 阻塞请求 → 算力饱和`, 'err');
  tx('(链下) 压测流量涌入 → 被保节点主线程阻塞');
  const jobs = [];
  for (let i = 0; i < N; i++) jobs.push(fetch(S.srv.url + '/work?ms=' + ms, { cache: 'no-store' }).catch(() => {}));
  Promise.all(jobs).then(() => {
    S.srv.attacking = false; renderSrv();
    logAI('🔥 攻击', '压测请求结束，等待节点恢复心跳', 'warn');
  });
}
async function killServer() {
  if (!S.srv.on) return toast('请先接入真实节点服务器', 'warn');
  await jget('/admin/kill', 2000);
  logAI('☠️ 攻击', '已下发硬宕机指令，/health 将返回 503', 'err');
}
async function reviveServer() {
  if (!S.srv.on) return toast('请先接入真实节点服务器', 'warn');
  await jget('/admin/revive', 2000);
  logAI('💚 运维', '服务已恢复，等待下一次心跳探测确认', 'ok');
}

/* ---------- 保单渲染 ---------- */
const ST = {
  Active: ['active', '✅ 生效中'], Triggered: ['triggered', '⚠️ 已触发 · 挑战窗口'],
  Challenged: ['challenged', '⚖️ 争议中'], Paid: ['paid', '💸 已自动赔付'],
  Rejected: ['rejected', '已拒绝'], Expired: ['rejected', '已到期'],
};
function renderPolicies() {
  $('policyList').innerHTML = S.policies.map(p => {
    const [c, t] = ST[p.status];
    const win = (p.status === 'Triggered' || p.status === 'Challenged');
    return `<div class="pol ${p.status === 'Paid' ? 'paid' : ''} ${p.status === 'Triggered' ? 'trig' : ''}">
      <div class="pol-hd"><span class="pol-id">保单 #${p.id}</span><span class="st ${c}">${t}</span></div>
      <div class="pol-meta">
        <span>节点 <b>${p.node.id}</b></span>
        <span>保额 <b>${fmt(p.coverage)}</b></span>
        <span>保费 <b>${fmt(p.premium)}</b></span>
        <span>SLA ≤ <b>${p.sla}s</b></span>
      </div>
      ${win ? `<div class="win">
        <div class="wt"><span>挑战窗口剩余 <b id="cd${p.id}">${p.deadline}s</b></span>
        <span>${p.deadline}/${S.WINDOW}</span></div>
        <div class="wb"><i id="wb${p.id}" style="width:${(p.deadline / S.WINDOW) * 100}%"></i></div>
        <div class="row-btns" style="margin-top:9px">
          <button class="btn sm dan" ${p.status !== 'Triggered' ? 'disabled' : ''} onclick="challenge(${p.id})">⚖️ 发起挑战</button>
        </div></div>` : ''}
    </div>`;
  }).join('') || '<div class="hint">暂无保单，先在上方购买一张 →</div>';
}

/* ---------- 一键全流程 ---------- */
function runFullDemo() {
  if (onChain()) return toast('全流程演示仅用于本地模拟，请勿用模拟事故发送链上交易。', 'warn');
  toast('开始演示：节点质押 → 投保 → 宕机 → 触发 → 挑战窗口 → 自动赔付', 'ok');
  registerNode(2000);
  setTimeout(() => lpDeposit(50000), 900);
  setTimeout(() => buyPolicy(), 1900);
  setTimeout(() => simulateDown(S.nodes.length - 1), 3600);
}

/* ---------- 主循环 ---------- */
setInterval(() => {
  if ($('block')) $('block').textContent = '—';
  S.nodes.forEach(n => { if (n.online) n.uptime++; });
  let running = false;
  S.policies.forEach(p => {
    if (p.chainId == null && (p.status === 'Triggered' || p.status === 'Challenged')) {
      running = true; p.deadline--;
      const cd = $('cd' + p.id), wb = $('wb' + p.id);
      if (cd) cd.textContent = Math.max(0, p.deadline) + 's';
      if (wb) wb.style.width = Math.max(0, (p.deadline / S.WINDOW) * 100) + '%';
      if (p.deadline <= 0) { lightStep(5); resolvePolicy(p); }
    }
  });
  if (running) lightStep(4);
}, 1000);
setInterval(refreshQuote, 3000);

/* ---------- 启动 ---------- */
lightStep(0);
renderNodes(); renderPolicies(); renderKPI(); renderChainBar();
logAI('🛡️ 协议', `Aegis 神盾 · ComputeShield · 目标网络 <b>${CHAIN.netCfg().name}</b>（ChainID ${CHAIN.netCfg().id}）`, 'ok');
logAI('Agent', '风控、定价与理赔演示模块已初始化；本地模式使用预设规则', 'info');
logAI('💡 提示', CHAIN.configured()
  ? '合约地址已配置，连接钱包、匹配网络并校验 IV 合约后可进入链上模式'
  : '当前为演示模式（不消耗 gas）。填入合约地址并连接钱包可切到真实链上模式', 'warn');
logEV(`${CHAIN.netCfg().name} · ChainID ${CHAIN.netCfg().id} · RPC ${CHAIN.netCfg().rpc}`, 'ok');
logEV(CHAIN.configured()
  ? `Core ${CHAIN.addr.core} · Pool ${CHAIN.addr.pool} · Registry ${CHAIN.addr.registry}`
  : '合约地址未配置；当前记录为本地演示事件', 'info');

/* 启动时自动探测本地真实算力节点（server/node-server.js） */
(async () => {
  const d = await jget('/health', 1500);
  if (d && d.status === 'ok') {
    logAI('🖧 真实节点', `检测到本地算力节点服务 <b style="color:#0a84ff">${S.srv.url}</b> → 自动接入并开始探测`, 'ok');
    connectServer();
  } else {
    logAI('🖧 真实节点',
      `未检测到本地节点服务 —— 先跑 <b>node server/node-server.js</b>，再点「🔌 接入并开始探测」（当前可先用模拟节点演示）`, 'warn');
  }
})();
